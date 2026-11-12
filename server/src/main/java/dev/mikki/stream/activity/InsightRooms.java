package dev.mikki.stream.activity;

import dev.mikki.stream.nodes.MediaNodes;
import dev.mikki.stream.room.RoomObserver;
import dev.mikki.stream.room.RoomRepository;
import dev.mikki.stream.room.RoomState;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Встречи глазами службы аналитики (R239, {@code contracts/insight.md} §2): наблюдатель комнат
 * превращает перемены во встрече в факты — {@code meeting_open}, {@code meeting_close}, {@code
 * media_up}, {@code media_down}, {@code presence}, {@code integration_open}, {@code
 * integration_close}, {@code integration_error}, {@code node_move}.
 *
 * <p>ПОСЛЕ ФИКСАЦИИ. Наблюдатель зовётся внутри транзакции комнаты и под её замком. Там он только
 * снимает, что видит: кто на связи, какой узел, какой номер события. Факты собираются и уходят в
 * буфер после фиксации ({@link InsightFacts#afterCommit}): откатившаяся встреча следов не
 * оставляет, а сбой аналитики встречу не ломает — ни в транзакции, ни после неё.
 *
 * <p>КТО НА СВЯЗИ. Статус участника меняется в десятке мест ядра, и все они кончаются объявлением
 * перемены ({@link #changed}). Поэтому наблюдатель помнит, кого видел на связи в каждой встрече, и
 * сравнивает: появился — {@code media_up}, пропал — {@code media_down} с причиной по его новому
 * статусу. Раз в минуту на каждую встречу с людьми на связи уходит тик {@code presence} со всеми,
 * кто на связи: служба считает секунды по тикам, а кого в тике нет — считает ушедшим. Боты не люди
 * и в фактах связи не участвуют.
 *
 * <p>ПОРЯДОК. Замок комнаты отпущен раньше, чем дошло до наблюдателя после фиксации, поэтому два
 * изменения одной встречи могут прийти сюда не по порядку. У каждого снимка — номер события
 * комнаты: снимок старше уже увиденного пропускается, как и снимок встречи, которая уже кончилась.
 *
 * <p>СВОИ ВСТРЕЧИ. Память наблюдателя — встречи, которые меняло это ядро, и те, что шли на момент
 * его запуска ({@link #seed}: перезапуск посреди разговора не обрывает присутствие). Начало и конец
 * встречи, запуски интеграций и переезды приходят явными событиями комнаты ({@link RoomObserver}) и
 * от памяти процесса не зависят: номер запуска лежит в самой комнате ({@link RoomState#runs}).
 */
@Component
public class InsightRooms implements RoomObserver {
  private static final Logger log = LoggerFactory.getLogger(InsightRooms.class);

  /** Как часто уходит тик присутствия, мс. Служба засчитывает за раз не больше 90 с. */
  public static final long TICK_MS = 60_000;

  /** Сколько завершённых встреч помнить, чтобы не принять запоздавший снимок за новую встречу. */
  static final int CLOSED_MEMORY = 10_000;

  private final InsightFacts facts;
  private final MediaNodes nodes;
  private final RoomRepository rooms;

  /** Всё ниже — под этим замком. */
  private final Object lock = new Object();

  private final Map<String, Watched> watched = new HashMap<>();

  /** Завершённая встреча → номер события, которым она кончилась. */
  private final LinkedHashMap<String, Long> ended =
      new LinkedHashMap<>(256, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Long> eldest) {
          return size() > CLOSED_MEMORY;
        }
      };

  /** Что наблюдатель помнит о встрече. */
  private static final class Watched {
    long sequence = -1;
    int moves;
    String node;
    int peak;

    /** Люди на связи: участник → хэш профиля (или {@code null}). */
    final Map<String, String> connected = new LinkedHashMap<>();
  }

  /** Что видно во встрече в момент перемены — снято под замком комнаты, применяется после него. */
  private record Seen(
      String room,
      long sequence,
      boolean closed,
      String node,
      int moves,
      Map<String, String> connected,
      Map<String, RoomState.Status> others,
      long at) {}

  public InsightRooms(InsightFacts facts, MediaNodes nodes, RoomRepository rooms) {
    this.facts = facts;
    this.nodes = nodes;
    this.rooms = rooms;
  }

  private Seen see(RoomState room, long at) {
    var connected = new LinkedHashMap<String, String>();
    var others = new HashMap<String, RoomState.Status>();
    for (var member : room.members.values()) {
      if (!member.human()) continue;
      if (member.status == RoomState.Status.CONNECTED)
        connected.put(member.id, room.profiles.get(member.id));
      else others.put(member.id, member.status);
    }
    return new Seen(
        room.id,
        room.sequence,
        room.closedAt != null,
        nodes.resolve(room.mediaNode).id(),
        room.mediaMoves == null ? 0 : room.mediaMoves,
        connected,
        others,
        at);
  }

  // ── Наблюдатель комнаты ──────────────────────────────────────────────────────────────────────

  @Override
  public void changed(RoomState room, String event, long now) {
    if (!facts.enabled()) return;
    try {
      var seen = see(room, now);
      InsightFacts.afterCommit(() -> apply(seen, true));
    } catch (RuntimeException e) {
      // Аналитика не роняет встречу: её отказ внутри транзакции комнаты откатил бы саму встречу.
      log.warn("Аналитика: перемена встречи не учтена: {}", e.toString());
    }
  }

  @Override
  public void opened(RoomState room, String profileHash, long now) {
    if (!facts.enabled()) return;
    try {
      var id = room.id;
      var node = nodes.resolve(room.mediaNode).id();
      InsightFacts.afterCommit(
          () ->
              facts
                  .fact("meeting_open", now)
                  .put("room", id)
                  .put("node", node)
                  .profile(profileHash)
                  .publish());
    } catch (RuntimeException e) {
      log.warn("Аналитика: начало встречи не учтено: {}", e.toString());
    }
  }

  @Override
  public void closed(RoomState room, String reason, long now) {
    if (!facts.enabled()) return;
    try {
      var id = room.id;
      // Объявление конца встречи получит следующий номер события; всё, что не новее, — прошлое.
      long sequence = room.sequence + 1;
      InsightFacts.afterCommit(() -> close(id, sequence, reason, now));
    } catch (RuntimeException e) {
      log.warn("Аналитика: конец встречи не учтён: {}", e.toString());
    }
  }

  @Override
  public void moved(RoomState room, String from, String to, String reason, long now) {
    if (!facts.enabled()) return;
    try {
      var id = room.id;
      InsightFacts.afterCommit(
          () ->
              facts
                  .fact("node_move", now)
                  .put("room", id)
                  .put("from", from)
                  .put("to", to)
                  .put("reason", reason)
                  .publish());
    } catch (RuntimeException e) {
      log.warn("Аналитика: переезд встречи не учтён: {}", e.toString());
    }
  }

  @Override
  public void integrationOpened(RoomState room, String kind, String run, long now) {
    if (!facts.enabled()) return;
    try {
      var id = room.id;
      var integration = Integration.of(room, kind);
      InsightFacts.afterCommit(
          () ->
              facts
                  .fact("integration_open", now)
                  .put("room", id)
                  .put("run", run)
                  .put("kind", integration.kind())
                  .put("variant", integration.variant())
                  .profile(integration.opener())
                  .publish());
    } catch (RuntimeException e) {
      log.warn("Аналитика: начало интеграции не учтено: {}", e.toString());
    }
  }

  @Override
  public void integrationClosed(RoomState room, String kind, String run, String reason, long now) {
    if (!facts.enabled()) return;
    try {
      var id = room.id;
      InsightFacts.afterCommit(
          () ->
              facts
                  .fact("integration_close", now)
                  .put("room", id)
                  .put("run", run)
                  .put("reason", reason)
                  .publish());
    } catch (RuntimeException e) {
      log.warn("Аналитика: конец интеграции не учтён: {}", e.toString());
    }
  }

  @Override
  public void integrationFailed(RoomState room, String kind, String run, String code, long now) {
    if (!facts.enabled()) return;
    try {
      var id = room.id;
      var integration = Integration.of(room, kind);
      InsightFacts.afterCommit(
          () ->
              facts
                  .fact("integration_error", now)
                  .put("room", id)
                  .put("run", run)
                  .put("kind", integration.kind())
                  .put("variant", integration.variant())
                  .put("code", code)
                  .publish());
    } catch (RuntimeException e) {
      log.warn("Аналитика: отказ интеграции не учтён: {}", e.toString());
    }
  }

  /**
   * Интеграция словами службы: вид — {@code cinema}, {@code music}, {@code game}, {@code board};
   * разновидность — площадка кинозала или игра (у музыки и доски её нет: источник музыки знает
   * служба музыки, а не ядро); кто открыл — хэш профиля или {@code null}.
   */
  record Integration(String kind, String variant, String opener) {
    static Integration of(RoomState room, String word) {
      return switch (word) {
        case "watch" ->
            new Integration(
                "cinema",
                room.watch == null ? null : room.watch.provider,
                room.watch == null ? null : room.profiles.get(room.watch.openedBy));
        case "music" -> new Integration("music", null, null);
        case "poker" ->
            new Integration(
                "game", word, room.poker == null ? null : opener(room, room.poker.hostId));
        case "durak" ->
            new Integration(
                "game", word, room.durak == null ? null : opener(room, room.durak.hostId));
        case "chess" ->
            new Integration(
                "game", word, room.chess == null ? null : opener(room, room.chess.hostId));
        case "gartic" ->
            new Integration(
                "game", word, room.gartic == null ? null : opener(room, room.gartic.hostId));
        case "board" ->
            new Integration(
                "board", null, room.board == null ? null : opener(room, room.board.openedBy));
        default -> new Integration(word, null, null);
      };
    }

    private static String opener(RoomState room, String memberId) {
      return memberId == null ? null : room.profiles.get(memberId);
    }
  }

  // ── Память о встречах ────────────────────────────────────────────────────────────────────────

  /**
   * Применить снимок встречи: кто появился на связи и кто пропал. {@code report} — слать ли факты:
   * при запуске ядра встречи только запоминаются ({@link #seed}).
   */
  private void apply(Seen seen, boolean report) {
    var published = new ArrayList<InsightFacts.Fact>();
    synchronized (lock) {
      if (seen.closed()) return;
      var over = ended.get(seen.room());
      if (over != null && seen.sequence() <= over) return;
      var room = watched.get(seen.room());
      if (room == null) {
        room = new Watched();
        watched.put(seen.room(), room);
      } else if (seen.sequence() <= room.sequence) return;
      boolean relocated = seen.moves() > room.moves && room.sequence >= 0;
      room.sequence = seen.sequence();
      room.moves = seen.moves();
      room.node = seen.node();
      for (var it = room.connected.entrySet().iterator(); it.hasNext(); ) {
        var gone = it.next();
        if (seen.connected().containsKey(gone.getKey())) continue;
        it.remove();
        published.add(
            facts
                .fact("media_down", seen.at())
                .put("room", seen.room())
                .profile(gone.getValue())
                .put("member", gone.getKey())
                .put("reason", reason(seen.others().get(gone.getKey()), relocated)));
      }
      for (var arrived : seen.connected().entrySet()) {
        if (room.connected.containsKey(arrived.getKey())) continue;
        room.connected.put(arrived.getKey(), arrived.getValue());
        published.add(
            facts
                .fact("media_up", seen.at())
                .put("room", seen.room())
                .profile(arrived.getValue())
                .put("member", arrived.getKey())
                .put("node", seen.node()));
      }
      room.peak = Math.max(room.peak, room.connected.size());
    }
    if (report) published.forEach(InsightFacts.Fact::publish);
  }

  /** Почему человек пропал со связи — по тому, кем он стал. */
  private static String reason(RoomState.Status status, boolean relocated) {
    if (status == null) return "left";
    return switch (status) {
      case REMOVED -> "removed";
      case RECOVERING -> relocated ? "moved" : "lost";
      case EXPIRED -> "lost";
      default -> "left";
    };
  }

  /** Встреча кончилась: все, кто был на связи, — со связи, затем сама встреча. */
  private void close(String id, long sequence, String reason, long now) {
    var published = new ArrayList<InsightFacts.Fact>();
    synchronized (lock) {
      ended.put(id, sequence);
      var room = watched.remove(id);
      if (room != null)
        for (var member : room.connected.entrySet())
          published.add(
              facts
                  .fact("media_down", now)
                  .put("room", id)
                  .profile(member.getValue())
                  .put("member", member.getKey())
                  .put("reason", "ended"));
      published.add(
          facts
              .fact("meeting_close", now)
              .put("room", id)
              .put("reason", ending(reason))
              .put("peak", room == null ? 0 : room.peak));
    }
    published.forEach(InsightFacts.Fact::publish);
  }

  /**
   * Причина конца встречи словами службы: ведущий — {@code owner}, все ушли или никто не пришёл —
   * {@code empty}, потолок длительности — {@code limit}, владелец сервера — {@code admin},
   * технические работы — {@code maintenance}.
   */
  static String ending(String reason) {
    return switch (reason == null ? "" : reason) {
      case "host" -> "owner";
      case "ceiling" -> "limit";
      case "server" -> "admin";
      case "maintenance" -> "maintenance";
      default -> "empty";
    };
  }

  /**
   * Ядро поднялось: встречи, которые идут, запоминаются как есть — без фактов. Служба их знает, а
   * дальше тики присутствия и перемены продолжают тот же счёт; без этого тихая встреча выпадала бы
   * из присутствия до первого события в ней.
   */
  @EventListener(ApplicationReadyEvent.class)
  public void seed() {
    if (!facts.enabled()) return;
    try {
      long now = System.currentTimeMillis();
      for (var room : rooms.all()) if (room.closedAt == null) apply(see(room, now), false);
    } catch (RuntimeException e) {
      log.warn("Аналитика: идущие встречи при запуске не прочитаны: {}", e.toString());
    }
  }

  /**
   * Тик присутствия: по факту {@code presence} на каждую свою встречу, где кто-то на связи, — со
   * всеми, кто на связи. Встречи без людей на связи тика не дают.
   *
   * <p>Страховка от встреч-призраков: встреча уходит из памяти с её концом, но если строки комнаты
   * в базе уже нет, а конца наблюдатель не видел, тик о ней шёл бы до перезапуска ядра и копил бы
   * людям время, которого не было. Поэтому перед тиком одним запросом проверяется, что встречи с
   * людьми на связи ещё есть; база не ответила — тик идёт как есть.
   */
  public void tick() {
    if (!facts.enabled()) return;
    List<String> live;
    synchronized (lock) {
      live =
          watched.entrySet().stream()
              .filter(entry -> !entry.getValue().connected.isEmpty())
              .map(Map.Entry::getKey)
              .toList();
    }
    if (live.isEmpty()) return;
    var gone = new java.util.HashSet<>(live);
    try {
      for (int from = 0; from < live.size(); from += 500)
        gone.removeAll(
            rooms
                .jdbc()
                .sql("SELECT id FROM rooms WHERE id IN (:ids)")
                .param("ids", live.subList(from, Math.min(live.size(), from + 500)))
                .query(String.class)
                .list());
    } catch (RuntimeException e) {
      gone.clear();
      log.warn("Аналитика: встречи перед тиком присутствия не сверены: {}", e.toString());
    }
    var ticks = new ArrayList<InsightFacts.Fact>();
    synchronized (lock) {
      watched.keySet().removeAll(gone);
      for (var entry : watched.entrySet()) {
        var room = entry.getValue();
        if (room.connected.isEmpty()) continue;
        var members = new ArrayList<Map<String, Object>>(room.connected.size());
        for (var member : room.connected.entrySet()) {
          var one = new LinkedHashMap<String, Object>();
          one.put("member", member.getKey());
          one.put("profile", facts.pseudonym(member.getValue()));
          members.add(one);
        }
        ticks.add(
            facts
                .fact("presence")
                .put("room", entry.getKey())
                .put("node", room.node)
                .put("members", List.copyOf(members)));
      }
    }
    ticks.forEach(InsightFacts.Fact::publish);
  }

  /** Сколько встреч наблюдатель помнит — для тестов. */
  int remembered() {
    synchronized (lock) {
      return watched.size();
    }
  }
}
