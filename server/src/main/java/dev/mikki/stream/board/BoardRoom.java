package dev.mikki.stream.board;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.mikki.stream.shared.Json;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.Pattern;

/**
 * Сцена одной доски в памяти ядра (R159): элементы Excalidraw, слияние правок, номер правки и
 * кольцо последних пачек для возврата по {@code since}.
 *
 * <p>СЛИЯНИЕ — ПО ЭЛЕМЕНТУ, «ПОСЛЕДНИЙ ПОБЕЖДАЕТ». У элемента Excalidraw есть {@code version}
 * (растёт на каждую правку) и {@code versionNonce} (случайное число правки). Правка принимается,
 * если её версия больше, а при равной — если её {@code versionNonce} меньше. Ровно так решает и
 * браузер ({@code reconcileElements} Excalidraw): у ядра и у каждого участника один ответ, и сцена
 * сходится без CRDT. Проигравшая правка не теряется молча: автор получает победителя в ответе
 * ({@link Applied#stale}).
 *
 * <p>УДАЛЕНИЕ — ОТМЕТКОЙ. Удалённый элемент ({@code isDeleted}) остаётся в сцене коротким следом:
 * иначе участник, вернувшийся без сети со старой копией, воскресил бы его. След занимает место в
 * {@code maxIds}, но не в видимых элементах.
 *
 * <p>НОМЕР ПРАВКИ И ПОКОЛЕНИЕ. Каждая принятая пачка получает следующий {@code seq}; последние
 * пачки лежат в кольце, и вернувшийся сокет получает только пропущенное. Очистка начинает новое
 * поколение ({@code epoch}): у кого оно старое, тот берёт сцену целиком и забывает своё.
 *
 * <p>Методы синхронизированы на самой доске: сокет держит тот же замок, пока раскладывает пачку по
 * очередям участников, — поэтому у каждого сокета правки идут строго по номерам.
 */
public final class BoardRoom {
  /**
   * Что можно рисовать. Встраиваемых рамок (embeddable, iframe) и ИИ-рамок здесь нет — их не
   * пускаем.
   */
  static final Set<String> TYPES =
      Set.of(
          "rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "image", "frame");

  private static final Pattern ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");

  /**
   * Линии и штрихи: у их следа остаются две крайние точки — элемент цел, но почти ничего не весит.
   */
  private static final Set<String> POINTED = Set.of("arrow", "line", "freedraw");

  private final String roomId;
  private final BoardProperties limits;
  private long epoch;
  private long seq;
  private final LinkedHashMap<String, Element> elements = new LinkedHashMap<>();
  private int live;
  private long bytes;
  private final ArrayDeque<Batch> ring = new ArrayDeque<>();
  private long ringBytes;
  private final LinkedHashMap<String, FileMeta> files = new LinkedHashMap<>();
  private boolean dirty;

  /** Элемент сцены: то, что нужно слиянию и пределам, и сам JSON ({@code size} — его байты). */
  record Element(
      String id,
      long version,
      long versionNonce,
      boolean deleted,
      String fileId,
      String json,
      int size) {}

  /**
   * Принятая пачка: номер, автор, сколько элементов и они сами JSON-массивом — так она и уходит.
   */
  public record Batch(long seq, String from, int count, String elements) {}

  /** Картинка доски: что лежит в {@code room_board_files}. */
  public record FileMeta(String id, String mime, int size) {}

  /** Почему элемент не принят: {@code BOARD_FULL} (пределы) или {@code BOARD_INVALID}. */
  public record Rejected(String id, long version, String code) {}

  /**
   * Итог пачки. {@code batch} — принятое (null, если не принято ничего), {@code rejected} — отказы,
   * {@code stale} — победители тех правок, что проиграли слиянию (JSON элементов).
   */
  public record Applied(Batch batch, List<Rejected> rejected, List<String> stale) {
    public int accepted() {
      return batch == null ? 0 : batch.count();
    }
  }

  /** Сцена для записи и для того, кто входит: поколение, номер и все элементы. */
  public record Scene(long epoch, long seq, String elements, List<FileMeta> files) {}

  public BoardRoom(String roomId, BoardProperties limits) {
    this.roomId = roomId;
    this.limits = limits;
  }

  /** Доска из базы: элементы — как записаны, без повторной проверки пределов. */
  public static BoardRoom restore(
      String roomId,
      BoardProperties limits,
      long epoch,
      long seq,
      String elements,
      List<FileMeta> files) {
    var room = new BoardRoom(roomId, limits);
    room.epoch = epoch;
    room.seq = seq;
    for (var node : Json.tree(elements)) {
      var element = element(node, Json.write(node));
      if (element == null) continue;
      room.elements.put(element.id(), element);
      room.bytes += element.size();
      if (!element.deleted()) room.live++;
    }
    for (var file : files) room.files.put(file.id(), file);
    return room;
  }

  public String roomId() {
    return roomId;
  }

  public synchronized long epoch() {
    return epoch;
  }

  public synchronized long seq() {
    return seq;
  }

  /** Сколько видимых элементов на доске. */
  public synchronized int live() {
    return live;
  }

  public synchronized boolean dirty() {
    return dirty;
  }

  /** Сцена записана — отметка снимается, если с тех пор ничего не принято. */
  public synchronized void saved(long savedSeq, long savedEpoch) {
    if (seq == savedSeq && epoch == savedEpoch) dirty = false;
  }

  /**
   * Применить пачку правок участника {@code from}. Каждый элемент проверяется и сливается сам по
   * себе: негодный или проигравший не мешает остальным.
   */
  public synchronized Applied apply(JsonNode incoming, String from) {
    if (incoming == null || !incoming.isArray()) throw new IllegalArgumentException("not an array");
    var accepted = new ArrayList<String>();
    var rejected = new ArrayList<Rejected>();
    var stale = new ArrayList<String>();
    for (var node : incoming) {
      var candidate = candidate(node);
      if (candidate == null) {
        rejected.add(
            new Rejected(
                node.path("id").asText(""), node.path("version").asLong(0), "BOARD_INVALID"));
        continue;
      }
      var existing = elements.get(candidate.id());
      if (existing != null && !wins(candidate, existing)) {
        if (existing.version() != candidate.version()
            || existing.versionNonce() != candidate.versionNonce()) stale.add(existing.json());
        continue;
      }
      boolean wasLive = existing != null && !existing.deleted();
      boolean isLive = !candidate.deleted();
      long nextBytes = bytes - (existing == null ? 0 : existing.size()) + candidate.size();
      if ((existing == null && elements.size() >= limits.maxIds())
          || (isLive && !wasLive && live >= limits.maxElements())
          || (isLive && nextBytes > limits.maxSceneBytes() && nextBytes > bytes)) {
        rejected.add(new Rejected(candidate.id(), candidate.version(), "BOARD_FULL"));
        continue;
      }
      elements.put(candidate.id(), candidate);
      bytes = nextBytes;
      live += (isLive ? 1 : 0) - (wasLive ? 1 : 0);
      accepted.add(candidate.json());
    }
    if (accepted.isEmpty()) return new Applied(null, rejected, stale);
    var batch = new Batch(++seq, from, accepted.size(), "[" + String.join(",", accepted) + "]");
    remember(batch);
    dirty = true;
    return new Applied(batch, rejected, stale);
  }

  /**
   * Пропущенное после {@code since} в поколении {@code epoch}, или пусто — если его уже не
   * восстановить пачками (другое поколение, кольцо ушло вперёд, номер из будущего) и нужна вся
   * сцена.
   */
  public synchronized Optional<List<Batch>> since(long sinceEpoch, long since) {
    if (sinceEpoch != epoch || since > seq || since < 0) return Optional.empty();
    if (since == seq) return Optional.of(List.of());
    if (ring.isEmpty() || ring.peekFirst().seq() > since + 1) return Optional.empty();
    return Optional.of(ring.stream().filter(b -> b.seq() > since).toList());
  }

  /** Вся сцена: поколение, номер, элементы с отметками удалённых и картинки. */
  public synchronized Scene scene() {
    var text = new StringBuilder(Math.toIntExact(Math.min(Integer.MAX_VALUE - 16, bytes + 2)));
    text.append('[');
    boolean first = true;
    for (var element : elements.values()) {
      if (!first) text.append(',');
      text.append(element.json());
      first = false;
    }
    text.append(']');
    return new Scene(epoch, seq, text.toString(), List.copyOf(files.values()));
  }

  /**
   * Очистить доску у всех: новое поколение, пустая сцена, без картинок. Возвращает новое поколение.
   */
  public synchronized long clear() {
    elements.clear();
    live = 0;
    bytes = 0;
    ring.clear();
    ringBytes = 0;
    files.clear();
    epoch++;
    seq++;
    dirty = true;
    return epoch;
  }

  public synchronized List<FileMeta> files() {
    return List.copyOf(files.values());
  }

  public synchronized boolean hasFile(String fileId) {
    return files.containsKey(fileId);
  }

  /**
   * Место под новую картинку. Доска полна — сначала уходят картинки, которых нет ни у одного
   * видимого элемента (удалённые, вставленные и отменённые); возвращает, какие убраны, или {@code
   * null}, если места нет и так.
   */
  public synchronized List<String> makeRoomForFile() {
    if (files.size() < limits.maxFiles()) return List.of();
    var used = new HashSet<String>();
    for (var element : elements.values())
      if (!element.deleted() && element.fileId() != null) used.add(element.fileId());
    var unused = files.keySet().stream().filter(id -> !used.contains(id)).toList();
    if (files.size() - unused.size() >= limits.maxFiles()) return null;
    unused.forEach(files::remove);
    return unused;
  }

  public synchronized void addFile(FileMeta file) {
    files.put(file.id(), file);
  }

  private void remember(Batch batch) {
    ring.addLast(batch);
    ringBytes += batch.elements().length();
    while (ring.size() > limits.ringBatches()
        || (ringBytes > limits.ringBytes() && ring.size() > 1)) {
      ringBytes -= ring.removeFirst().elements().length();
    }
  }

  /** Правка {@code a} побеждает {@code b}: та же формула, что у {@code reconcileElements}. */
  static boolean wins(Element a, Element b) {
    return a.version() > b.version()
        || (a.version() == b.version() && a.versionNonce() < b.versionNonce());
  }

  /**
   * Проверенный элемент правки или null — если он негоден. У удалённого штриха и линии остаются две
   * крайние точки: элемент остаётся целым для Excalidraw, но не весит тысячи точек.
   */
  private Element candidate(JsonNode node) {
    if (node == null || !node.isObject()) return null;
    if (!TYPES.contains(node.path("type").asText())) return null;
    var link = node.get("link");
    if (link != null && !link.isNull() && !safeLink(link)) return null;
    var object = (ObjectNode) node;
    if (object.path("isDeleted").asBoolean(false) && POINTED.contains(object.path("type").asText()))
      object = trace(object);
    var json = Json.write(object);
    var element = element(object, json);
    if (element == null || element.size() > limits.maxElementBytes()) return null;
    return element;
  }

  private static ObjectNode trace(ObjectNode node) {
    var copy = node.deepCopy();
    var points = node.path("points");
    if (points.isArray() && points.size() > 2) {
      var ends = JsonNodeFactory.instance.arrayNode();
      ends.add(points.get(0));
      ends.add(points.get(points.size() - 1));
      copy.set("points", ends);
    }
    if (copy.has("pressures")) copy.set("pressures", JsonNodeFactory.instance.arrayNode());
    return copy;
  }

  /** Поля слияния из JSON элемента, или null — если их нет или они не того вида. */
  private static Element element(JsonNode node, String json) {
    var id = node.path("id");
    var version = node.path("version");
    var nonce = node.path("versionNonce");
    if (!id.isTextual() || !ID.matcher(id.asText()).matches()) return null;
    if (!version.isIntegralNumber() || version.asLong() < 1) return null;
    if (!nonce.isIntegralNumber()) return null;
    var deleted = node.path("isDeleted");
    if (!deleted.isMissingNode() && !deleted.isBoolean()) return null;
    var fileId = node.path("fileId");
    String file = null;
    if (fileId.isTextual()) {
      if (!ID.matcher(fileId.asText()).matches()) return null;
      file = fileId.asText();
    } else if (!fileId.isMissingNode() && !fileId.isNull()) return null;
    return new Element(
        id.asText(),
        version.asLong(),
        nonce.asLong(),
        deleted.asBoolean(false),
        file,
        json,
        json.getBytes(StandardCharsets.UTF_8).length);
  }

  /**
   * Ссылка элемента — только обычная: https, http или почта. Скрипт ({@code javascript:}) и данные
   * в ссылке открыли бы у соседа то, чего он не просил.
   */
  private static boolean safeLink(JsonNode link) {
    if (!link.isTextual()) return false;
    var text = link.asText().strip().toLowerCase(Locale.ROOT);
    if (text.isEmpty()) return true;
    if (text.length() > 2048) return false;
    return text.startsWith("https://") || text.startsWith("http://") || text.startsWith("mailto:");
  }
}
