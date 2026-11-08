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
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Реестр медиаузлов и выбор узла для новой встречи (R195, ёмкость — R200).
 *
 * <p>ИСТОЧНИК. Файл {@code stream.nodes-file} ({@code infra/generated/nodes/registry.json}),
 * который пишет {@code scripts/node-config.mjs} на узле управления. Перечитывается не чаще раза в
 * {@link #RELOAD_MS} и только если файл изменился: добавить узел или снять его с размещения ({@code
 * enabled: false}) можно без перезапуска ядра. Файла нет — один неявный узел из {@code LIVEKIT_URL}
 * и {@code LIVEKIT_INTERNAL_URL} с именем {@code stream.node-id}; так работала каждая установка до
 * узлов, и так же работают тесты.
 *
 * <p>ВЫБОР ({@code server-selection.md} §3.1, §3.4). Создатель встречи присылает {@code
 * preferredNode} — узел, до которого его устройство измерило лучший путь ({@code
 * web/src/media/node-probe.ts}), и сами замеры. Ядро проверяет, что узел есть, принимает встречи,
 * жив (его не отметил мёртвым опрос {@code media.NodeHealth}), не полон и не на ступени 4. Узел на
 * ступени 3 или без запаса под рост (прогнозная доля после новой встречи выше {@link #HEADROOM})
 * уступает узлу со ступенью ≤ 2, если тот не дальше {@link #TIE_MS} по замеру создателя. Иначе —
 * лучший по замеру среди свободных, иначе узел управления, иначе первый живой, иначе узел
 * управления как есть (встреча хоть куда-то, а не отказ). Причина выбора — в метрике {@code
 * cord.node.choice}.
 *
 * <p>СТУПЕНЬ 1–4 на каждый узел — по правилу {@code activity.LoadMeter}: наибольшая из долей
 * «встречи / maxRooms», «люди / (maxRooms × 6)», «ЦП со steal», «отдача / uplinkMbps»; четверти;
 * вверх сразу, вниз через {@link #DOWN_AFTER_MS}. Данные приносит {@code media.NodeHealth} раз в
 * опрос ({@link #load}); ЦП и канал — только у узлов с {@code loadUrl}, остальным хватает встреч и
 * людей. Один неявный узел ведёт себя как до R200: ступень на решение не влияет, потому что
 * выбирать не из чего.
 *
 * <p>ПОЧЕМУ НЕ В {@code media}. Пакет {@code room} ({@code RoomService.create}) этим пользуется, а
 * зависеть от медиатранспорта ему нельзя ({@code ArchitectureTest}). Здесь нет ни LiveKit, ни сети
 * — только файл и решение; живость и нагрузку узлов сюда сообщает {@code media.NodeHealth}.
 */
@Component
public class MediaNodes {
  private static final Logger log = LoggerFactory.getLogger(MediaNodes.class);
  static final long RELOAD_MS = 10_000;
  static final String FORMAT = "cord.nodes/1";

  /** Сколько людей считается «полной» встречей при доле людей и в прогнозе новой встречи. */
  static final int PEOPLE_PER_ROOM = 6;

  /** Сколько отдачи канала занимает новая встреча в прогнозе (камеры 5–6 человек). */
  static final double MEETING_MBPS = 25;

  /** Запас под рост идущих встреч: узел с прогнозной долей выше не берётся, пока есть другой. */
  static final double HEADROOM = 0.75;

  /** Узлы, чьи замеры различаются не больше этого, считаются равными — берётся менее занятый. */
  static final int TIE_MS = 20;

  static final long DOWN_AFTER_MS = 30_000;

  /** Чем кончился выбор: для метрики и журнала. */
  public record Choice(MediaNode node, String reason) {}

  /** Замер создателя до узла: лучшее из UDP и TCP в мс; {@code ms == null} — узел не ответил. */
  public record Measure(String node, Integer ms, boolean udpOpen) {}

  /** Нагрузка узла для показа: ступень и состояние, без чисел ({@code GET /api/v1/nodes}). */
  public record Level(int level, String state) {}

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
  private final Map<String, Load> loads = new ConcurrentHashMap<>();

  /** Что известно о нагрузке узла по последнему опросу. */
  static final class Load {
    volatile int rooms;
    volatile int participants;

    /** Доли 0…1; {@code NaN} — не меряется (узел без {@code loadUrl} или node-exporter молчит). */
    volatile double cpu = Double.NaN;

    volatile double steal = Double.NaN;
    volatile double uplinkMbps = Double.NaN;
    final AtomicInteger level = new AtomicInteger(1);
    long lowerSince = -1;
  }

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
    return choose(preferred, List.of());
  }

  public Choice choose(String preferred, List<Measure> measures) {
    var choice = decide(preferred, measures == null ? List.of() : measures);
    Counter.builder("cord.node.choice")
        .description("Выбор узла для новой встречи: узел и причина")
        .tags("node", choice.node().id(), "reason", choice.reason())
        .register(registry)
        .increment();
    return choice;
  }

  Choice decide(String preferred, List<Measure> measures) {
    var candidates = available();
    var control = control();
    if (preferred != null)
      for (var node : candidates)
        if (node.id().equals(preferred)) {
          // Полный узел по предпочтению не берётся: встреча идёт на запасной (ревью R195).
          if (full(node)) return fallback(candidates, control, measures, "preferred-full");
          // Ступень 4 без свободных мест по встречам — то же: людям там уже тесно.
          if (level(node.id()) >= 4)
            return fallback(candidates, control, measures, "preferred-level");
          // Тесно или без запаса — уступает соседу не дальше TIE_MS со ступенью ≤ 2 (§3.4).
          if (level(node.id()) >= 3 || !headroom(node)) {
            var mine = ms(measures, node.id());
            if (mine != null) {
              var nearby =
                  candidates.stream()
                      .filter(n -> n != node && placeable(n) && level(n.id()) <= 2 && headroom(n))
                      .filter(
                          n -> {
                            var other = ms(measures, n.id());
                            return other != null && other <= mine + TIE_MS;
                          })
                      .min(Comparator.comparingInt((MediaNode n) -> level(n.id())));
              if (nearby.isPresent()) return new Choice(nearby.get(), "preferred-busy");
            }
          }
          return new Choice(node, "preferred");
        }
    if (preferred != null && !knows(preferred))
      return fallback(candidates, control, measures, "unknown");
    if (preferred != null)
      return fallback(
          candidates, control, measures, down.contains(preferred) ? "down" : "disabled");
    return fallback(candidates, control, measures, "default");
  }

  private Choice fallback(
      List<MediaNode> candidates, MediaNode control, List<Measure> measures, String why) {
    // Замеры есть — лучший по пути среди свободных (с запасом), а не узел управления вслепую.
    if (!measures.isEmpty()) {
      var measured = bestMeasured(candidates, measures);
      if (measured.isPresent()) return new Choice(measured.get(), why + "-measured");
    }
    if (candidates.contains(control) && !full(control))
      return new Choice(control, why + "-control");
    for (var node : candidates) if (!full(node)) return new Choice(node, why + "-first");
    if (candidates.contains(control)) return new Choice(control, why + "-control-full");
    return new Choice(control, why + "-all-down");
  }

  private Optional<MediaNode> bestMeasured(List<MediaNode> candidates, List<Measure> measures) {
    Comparator<MediaNode> byPath =
        Comparator.comparing((MediaNode n) -> !udpOpen(measures, n.id()))
            .thenComparingInt(n -> ms(measures, n.id()));
    var free =
        candidates.stream()
            .filter(n -> placeable(n) && ms(measures, n.id()) != null && headroom(n))
            .min(byPath);
    if (free.isPresent()) return free;
    return candidates.stream()
        .filter(n -> placeable(n) && ms(measures, n.id()) != null)
        .min(byPath);
  }

  private static Integer ms(List<Measure> measures, String id) {
    for (var m : measures) if (id.equals(m.node())) return m.ms();
    return null;
  }

  private static boolean udpOpen(List<Measure> measures, String id) {
    for (var m : measures) if (id.equals(m.node())) return m.udpOpen();
    return false;
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
   * Короткая форма {@link #load} для тех, кто знает только комнаты.
   */
  public void rooms(String id, int count) {
    var load = loads.computeIfAbsent(id, this::track);
    load(id, count, load.participants, Double.NaN, Double.NaN, Double.NaN);
  }

  /**
   * Нагрузка узла с опроса: встречи и люди — из {@code ListRooms}, ЦП, steal и отдача — из
   * node-exporter узла ({@code NaN} — не меряется). Отсюда считается ступень.
   */
  public void load(
      String id, int rooms, int participants, double cpu, double steal, double uplinkMbps) {
    var load = loads.computeIfAbsent(id, this::track);
    load.rooms = rooms;
    load.participants = participants;
    load.cpu = cpu;
    load.steal = steal;
    load.uplinkMbps = uplinkMbps;
    var node = resolveExact(id);
    var wanted = node == null ? 1 : step(share(node, load, 0, 0, 0));
    if (!Double.isNaN(steal) && steal > 0.25) wanted = Math.max(wanted, 3);
    if (node != null && rooms >= node.maxRooms()) wanted = 4;
    var now = clock.millis();
    synchronized (load) {
      if (wanted >= load.level.get()) {
        load.level.set(wanted);
        load.lowerSince = -1;
      } else if (load.lowerSince < 0) load.lowerSince = now;
      else if (now - load.lowerSince >= DOWN_AFTER_MS) {
        load.level.set(wanted);
        load.lowerSince = -1;
      }
    }
  }

  /** Ступень 1–4 узла; неизвестный или ещё не опрошенный — 1. */
  public int level(String id) {
    var load = loads.get(id);
    return load == null ? 1 : load.level.get();
  }

  /** Ступень и состояние узла словами — для {@code GET /api/v1/nodes} и настроек. */
  public Level levelOf(MediaNode node) {
    String state;
    if (down.contains(node.id())) state = "down";
    else if (!node.enabled()) state = "drained";
    else if (full(node) || level(node.id()) >= 4) state = "full";
    else if (level(node.id()) >= 3) state = "busy";
    else state = "ok";
    return new Level(level(node.id()), state);
  }

  private boolean placeable(MediaNode node) {
    return !full(node) && level(node.id()) < 4;
  }

  /** Есть ли место под ещё одну встречу так, чтобы ни одна доля не вышла за {@link #HEADROOM}. */
  boolean headroom(MediaNode node) {
    var load = loads.get(node.id());
    if (load == null) return true;
    return share(node, load, 1, PEOPLE_PER_ROOM, MEETING_MBPS) <= HEADROOM;
  }

  /** Наибольшая доля узла с прибавкой (прогноз новой встречи); доли без данных не считаются. */
  private static double share(
      MediaNode node, Load load, int moreRooms, int morePeople, double moreMbps) {
    var rooms = (double) (load.rooms + moreRooms) / node.maxRooms();
    var people = (double) (load.participants + morePeople) / (node.maxRooms() * PEOPLE_PER_ROOM);
    var share = Math.max(rooms, people);
    if (!Double.isNaN(load.cpu)) share = Math.max(share, load.cpu);
    if (!Double.isNaN(load.uplinkMbps))
      share = Math.max(share, (load.uplinkMbps + moreMbps) / node.uplinkMbps());
    return share;
  }

  /** Доля 0…1 → ступень 1…4 по четвертям (как {@code LoadMeter.step}). */
  static int step(double share) {
    if (share < 0.25) return 1;
    if (share < 0.5) return 2;
    if (share < 0.75) return 3;
    return 4;
  }

  private boolean full(MediaNode node) {
    var load = loads.get(node.id());
    return load != null && load.rooms >= node.maxRooms();
  }

  private MediaNode resolveExact(String id) {
    for (var node : all()) if (node.id().equals(id)) return node;
    return null;
  }

  private Load track(String id) {
    var load = new Load();
    Gauge.builder("cord.node.level", load.level, AtomicInteger::get)
        .description("Ступень нагрузки медиаузла 1–4, как её видят люди в настройках (R200)")
        .tags("node", id)
        .register(registry);
    return load;
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
