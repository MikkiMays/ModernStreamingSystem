package dev.mikki.stream.nodes;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.mikki.stream.config.StreamProperties;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Реестр медиаузлов и выбор узла для новой встречи (R195).
 *
 * <p>ИСТОЧНИК. Файл {@code stream.nodes-file} ({@code infra/generated/nodes/registry.json}),
 * который пишет {@code scripts/node-config.mjs} на узле управления. Перечитывается не чаще раза в
 * {@link #RELOAD_MS} и только если файл изменился: добавить узел или снять его с размещения ({@code
 * enabled: false}) можно без перезапуска ядра. Файла нет — один неявный узел из {@code LIVEKIT_URL}
 * и {@code LIVEKIT_INTERNAL_URL} с именем {@code stream.node-id}; так работала каждая установка до
 * узлов, и так же работают тесты.
 *
 * <p>ВЫБОР. Создатель встречи присылает {@code preferredNode} — узел, до которого его устройство
 * измерило лучший путь ({@code web/src/media/node-probe.ts}). Ядро проверяет, что узел есть,
 * принимает встречи, жив (его не отметил мёртвым опрос {@code media.NodeHealth}) и не полон; иначе
 * — узел управления, иначе — первый живой, иначе — узел управления как есть (встреча хоть куда-то,
 * а не отказ). Причина выбора — в метрике {@code cord.node.choice}, по ней видно, работает ли
 * замер.
 *
 * <p>ПОЧЕМУ НЕ В {@code media}. Пакет {@code room} ({@code RoomService.create}) этим пользуется, а
 * зависеть от медиатранспорта ему нельзя ({@code ArchitectureTest}). Здесь нет ни LiveKit, ни сети
 * — только файл и решение; живость узлов сюда сообщает {@code media.NodeHealth} через {@link
 * #down}.
 */
@Component
public class MediaNodes {
  private static final Logger log = LoggerFactory.getLogger(MediaNodes.class);
  static final long RELOAD_MS = 10_000;
  static final String FORMAT = "cord.nodes/1";

  /** Чем кончился выбор: для метрики и журнала. */
  public record Choice(MediaNode node, String reason) {}

  private static final ObjectMapper JSON = new ObjectMapper();

  private final Path file;
  private final Clock clock;
  private final MeterRegistry registry;
  private final MediaNode implicit;
  private final String nodeId;

  /**
   * 1 — реестр есть, но проигнорирован (его узел управления — не этот сервер): алерт
   * `NodeRegistryIgnored`.
   */
  private final AtomicInteger ignored = new AtomicInteger();

  private volatile List<MediaNode> nodes;
  private volatile boolean checked;
  private volatile long checkedAt;
  private volatile long modifiedAt = -1;
  private final Set<String> down = ConcurrentHashMap.newKeySet();
  private final Map<String, Integer> rooms = new ConcurrentHashMap<>();

  @Autowired
  public MediaNodes(StreamProperties config, Clock clock, MeterRegistry registry) {
    this(config, Path.of(config.nodesFile()), clock, registry);
  }

  MediaNodes(StreamProperties config, Path file, Clock clock, MeterRegistry registry) {
    this.file = file;
    this.clock = clock;
    this.registry = registry;
    this.nodeId = config.nodeId();
    Gauge.builder("cord.node.registry.ignored", ignored, AtomicInteger::get)
        .description("Реестр узлов проигнорирован: его узел управления — не NODE_ID этого сервера")
        .register(registry);
    this.implicit =
        new MediaNode(
            config.nodeId(),
            true,
            Map.of(),
            config.livekitUrl(),
            config.publicUrl(),
            null,
            config.livekitInternalUrl(),
            config.maxRooms(),
            true);
    this.nodes = List.of(implicit);
  }

  /** Все узлы реестра, узел управления — первым. */
  public List<MediaNode> all() {
    refresh();
    return nodes;
  }

  /** Узел управления: он же узел комнат без {@code mediaNode}. */
  public MediaNode control() {
    for (var node : all()) if (node.control()) return node;
    return all().get(0);
  }

  /**
   * Узел комнаты по имени из снимка. Неизвестное имя (узел убрали из реестра, пока комната жила) и
   * {@code null} — узел управления: туда и пойдут токены, пока комнату не переназначат.
   */
  public MediaNode resolve(String id) {
    if (id != null) for (var node : all()) if (node.id().equals(id)) return node;
    return control();
  }

  public boolean knows(String id) {
    return id != null && all().stream().anyMatch(n -> n.id().equals(id));
  }

  /**
   * Живые узлы, которые принимают встречи, — для списка в {@code capabilities}: эти и стоит мерить.
   */
  public List<MediaNode> available() {
    return all().stream().filter(n -> n.enabled() && !down.contains(n.id())).toList();
  }

  public Choice choose(String preferred) {
    var choice = decide(preferred);
    Counter.builder("cord.node.choice")
        .description("Выбор узла для новой встречи: узел и причина")
        .tags("node", choice.node().id(), "reason", choice.reason())
        .register(registry)
        .increment();
    return choice;
  }

  Choice decide(String preferred) {
    var candidates = available();
    if (preferred != null)
      for (var node : candidates)
        if (node.id().equals(preferred))
          // Полный узел по предпочтению не берётся: встреча идёт на запасной (ревью R195).
          return full(node)
              ? fallback(candidates, control(), "preferred-full")
              : new Choice(node, "preferred");
    var control = control();
    if (preferred != null && !knows(preferred)) return fallback(candidates, control, "unknown");
    if (preferred != null)
      return fallback(candidates, control, down.contains(preferred) ? "down" : "disabled");
    return fallback(candidates, control, "default");
  }

  private Choice fallback(List<MediaNode> candidates, MediaNode control, String why) {
    if (candidates.contains(control) && !full(control))
      return new Choice(control, why + "-control");
    for (var node : candidates) if (!full(node)) return new Choice(node, why + "-first");
    if (candidates.contains(control)) return new Choice(control, why + "-control-full");
    return new Choice(control, why + "-all-down");
  }

  private boolean full(MediaNode node) {
    return rooms.getOrDefault(node.id(), 0) >= node.maxRooms();
  }

  /** Опрос узлов ({@code media.NodeHealth}) сообщает, кто мёртв; мёртвые в выборе не участвуют. */
  public void down(String id, boolean isDown) {
    if (isDown) down.add(id);
    else down.remove(id);
  }

  public boolean isDown(String id) {
    return down.contains(id);
  }

  /**
   * Сколько комнат SFU узел держит сейчас — по ответу {@code ListRooms}; полный узел не выбирается.
   */
  public void rooms(String id, int count) {
    rooms.put(id, count);
  }

  private void refresh() {
    long now = clock.millis();
    if (checked && now - checkedAt < RELOAD_MS) return;
    checked = true;
    checkedAt = now;
    try {
      if (!Files.isRegularFile(file)) {
        if (modifiedAt != -1)
          log.warn("Media node registry {} disappeared; using the single implicit node", file);
        modifiedAt = -1;
        ignored.set(0);
        nodes = List.of(implicit);
        return;
      }
      long modified = Files.getLastModifiedTime(file).toMillis();
      if (modified == modifiedAt) return;
      var parsed = parse(Files.readString(file));
      modifiedAt = modified;
      var control = parsed.stream().filter(MediaNode::control).findFirst().orElseThrow();
      // Файл не про этот сервер (или NODE_ID не задан): работать по нему — отдавать токены на чужие
      // узлы.
      // Прод от этого не падает: остаёмся с одним неявным узлом, кричим в журнал и метрику.
      if (!control.id().equals(nodeId)) {
        log.error(
            "Media node registry {} names control node '{}' but this server is NODE_ID='{}' — registry IGNORED, single implicit node stays",
            file,
            control.id(),
            nodeId);
        ignored.set(1);
        nodes = List.of(implicit);
        return;
      }
      ignored.set(0);
      nodes = parsed;
      log.info(
          "Media nodes: {}",
          parsed.stream()
              .map(n -> n.id() + (n.control() ? "*" : "") + (n.enabled() ? "" : "(drained)"))
              .toList());
    } catch (IOException | IllegalArgumentException e) {
      // Битый файл — не повод терять узлы: остаёмся на прошлом списке и говорим об этом.
      log.warn(
          "Media node registry {} is unreadable, keeping {} node(s): {}",
          file,
          nodes.size(),
          e.getMessage());
    }
  }

  static List<MediaNode> parse(String text) throws IOException {
    JsonNode root = JSON.readTree(text);
    if (!FORMAT.equals(root.path("format").asText()))
      throw new IllegalArgumentException("registry format is not " + FORMAT);
    var seen = new LinkedHashMap<String, MediaNode>();
    for (JsonNode entry : root.path("nodes")) {
      var node = JSON.treeToValue(entry, MediaNode.class);
      if (seen.put(node.id(), node) != null)
        throw new IllegalArgumentException("node " + node.id() + " listed twice");
    }
    if (seen.isEmpty()) throw new IllegalArgumentException("registry has no nodes");
    var list = new ArrayList<MediaNode>(seen.values());
    if (list.stream().filter(MediaNode::control).count() != 1)
      throw new IllegalArgumentException("registry must name exactly one control node");
    list.sort((a, b) -> Boolean.compare(b.control(), a.control()));
    return List.copyOf(list);
  }
}
