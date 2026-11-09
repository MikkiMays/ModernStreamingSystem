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
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Реестр медиаузлов и выбор узла для новой встречи (R195; ёмкость — R200; без пределов по числу
 * встреч — R228, Р-135).
 *
 * <p>ИСТОЧНИК. Файл {@code stream.nodes-file} ({@code infra/generated/nodes/registry.json}),
 * который пишет {@code scripts/node-config.mjs} на узле управления. Перечитывается не чаще раза в
 * {@link #RELOAD_MS} и только если файл изменился: добавить узел или снять его с размещения ({@code
 * enabled: false}) можно без перезапуска ядра. Файла нет — один неявный узел из {@code LIVEKIT_URL}
 * и {@code LIVEKIT_INTERNAL_URL} с именем {@code stream.node-id}; так работала каждая установка до
 * узлов, и так же работают тесты.
 *
 * <p>ЧИСЛО ВСТРЕЧ — НЕ ПРЕДЕЛ (Р-135, как у Google Meet, Телемоста и Discord). Ни ядро, ни узел не
 * считают встречи против потолка: узел упирается в ЦП, канал, память или диск, а не в счётчик.
 * Каждый ресурс узла — доля к своему мягкому порогу ({@link #CPU_HOT}, {@link #EGRESS_HOT}, {@link
 * #MEMORY_HOT}, {@link #SFU_MEMORY_HOT}, {@link #DISK_HOT}); нагрузка узла — наибольшая из этих
 * долей, 1 — порог. Узел «горячий» с нагрузки 1 и остывает, только простояв ниже {@link #COOL}
 * {@link #COOL_AFTER_MS} (гистерезис по значению и по времени; сглаживание ЦП, канала и памяти — в
 * {@code media.NodeHealth}, EWMA раз в 2 с). Метрик нет — ЦП оценивается по людям на узле ({@link
 * #PEOPLE_PER_CORE}), память SFU — по людям ({@link #SFU_MB_PER_PERSON}).
 *
 * <p>ВЫБОР ({@code server-selection.md} §3.1, §3.4). Создатель встречи присылает {@code
 * preferredNode} — узел, до которого его устройство измерило лучший путь ({@code
 * web/src/media/node-probe.ts}), и сами замеры. Узел «с запасом» — живой, принимает встречи, не
 * горячий и останется ниже порога с этой встречей и с теми, что поставлены на него за последние
 * {@link #RESERVE_MS} (их нагрузка ещё не дошла до метрик: {@link #MEETING_MBPS}, {@link
 * #MEETING_CORES} на встречу — так пачка встреч не ложится на один узел). Предпочтённый узел с
 * запасом — он; иначе ближайший по замеру создателя среди узлов с запасом («перенаправить на другой
 * ближайший»); без замеров — узел управления или наименее загруженный. Запаса нет ни у кого —
 * встреча всё равно создаётся, на наименее загруженном узле (причина {@code *-saturated}, метрика
 * {@code cord.nodes.saturated}): отказа по нагрузке нет, SFU сам снижает слои (simulcast, dynacast,
 * adaptive stream). Идущие встречи ради нагрузки не переезжают (Р-102) — только при смерти узла.
 * Причина выбора — в метрике {@code cord.node.choice}.
 *
 * <p>СТУПЕНЬ 1–4 на каждый узел — для палочек в «Настройки → Сервер»: по нагрузке трети порога,
 * горячий — 4 («full»), steal выше {@link #STEAL_BUSY} — не ниже 3; вверх сразу, вниз через {@link
 * #DOWN_AFTER_MS}. Данные приносит {@code media.NodeHealth} раз в опрос ({@link #load}). Один
 * неявный узел ведёт себя как до R200: выбирать не из чего, встреча всегда на нём.
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

  /** Мягкий порог ЦП хоста (со steal): выше — узел горячий. */
  static final double CPU_HOT = 0.70;

  /** Мягкий порог отдачи канала к {@code uplinkMbps} узла. */
  static final double EGRESS_HOT = 0.70;

  /**
   * Мягкий порог занятой памяти хоста ({@code 1 − MemAvailable / MemTotal}): кэш страниц не в счёт.
   */
  static final double MEMORY_HOT = 0.85;

  /**
   * Мягкий порог памяти процесса SFU к пределу его контейнера: Go нужен запас под сборку мусора.
   */
  static final double SFU_MEMORY_HOT = 0.80;

  /** Мягкий порог занятого корневого диска: журналы и образы Docker. */
  static final double DISK_HOT = 0.90;

  /** Нагрузка, с которой узел горячий: наибольшая доля дошла до своего порога. */
  static final double HOT = 1.0;

  /**
   * Нагрузка, ниже которой горячий узел остывает: ЦП и канал — 60 %, память хоста — 72 %, память
   * SFU — 68 %, диск — 76 %.
   */
  static final double COOL = 0.857;

  /** Сколько горячий узел должен простоять ниже {@link #COOL}, чтобы снова брать встречи. */
  static final long COOL_AFTER_MS = 30_000;

  /** Ступень вниз — не раньше, чем через столько: палочки не мигают на каждом всплеске. */
  static final long DOWN_AFTER_MS = 30_000;

  /**
   * Отдача, которую новая встреча успевает набрать, пока её нет в метриках (камеры 3–6 человек).
   */
  static final double MEETING_MBPS = 25;

  /** ЦП той же встречи: ≈ 250 Мбит/с пересылки на ядро ({@code docs/capacity.md}, И1 R227). */
  static final double MEETING_CORES = 0.1;

  /** Сколько поставленная встреча считается сверх метрик узла (резерв под запаздывание). */
  static final long RESERVE_MS = 60_000;

  /**
   * Сколько людей на ядро — оценка ЦП, пока node-exporter молчит (2 vCPU ≈ 150 Мбит/с, T09/R227).
   */
  static final int PEOPLE_PER_CORE = 15;

  /** Оценка памяти SFU без его метрик: база и на человека ({@code docs/capacity.md} §3). */
  static final double SFU_BASE_MB = 60;

  static final double SFU_MB_PER_PERSON = 6;

  /** steal выше этого — ступень не ниже 3: хост делит ЦП с соседями. */
  static final double STEAL_BUSY = 0.25;

  /**
   * Журнал «запаса нет нигде» — не чаще раза в столько: встречи создаются, крик не нужен каждой.
   */
  static final long SATURATED_LOG_MS = 60_000;

  /** Чем кончился выбор: для метрики и журнала. */
  public record Choice(MediaNode node, String reason) {}

  /** Замер создателя до узла: лучшее из UDP и TCP в мс; {@code ms == null} — узел не ответил. */
  public record Measure(String node, Integer ms, boolean udpOpen) {}

  /** Нагрузка узла для показа: ступень и состояние, без чисел ({@code GET /api/v1/nodes}). */
  public record Level(int level, String state) {}

  /**
   * Что узел показал опросом ({@code media.NodeHealth}): комнаты и люди — из {@code ListRooms}; ЦП
   * со steal, steal, занятая память и корневой диск хоста — доли 0…1, отдача — Мбит/с (всё из
   * node-exporter); память процесса SFU — МиБ (из метрик SFU). {@code NaN} — не меряется.
   */
  public record Sample(
      int rooms,
      int participants,
      double cpu,
      double steal,
      double egressMbps,
      double memory,
      double disk,
      double sfuMemoryMb) {
    /** Только то, что знает {@code ListRooms}. */
    public static Sample rooms(int rooms, int participants) {
      return new Sample(
          rooms,
          participants,
          Double.NaN,
          Double.NaN,
          Double.NaN,
          Double.NaN,
          Double.NaN,
          Double.NaN);
    }
  }

  /** Нагрузка узла: наибольшая доля к своему порогу и какой ресурс её дал. */
  record Pressure(double value, String by) {}

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

  /**
   * Узел молчит по магистрали, но его люди на связи ({@code NodeHealth}, Р-105): новые встречи туда
   * не ставятся, идущие не трогаются. В отличие от {@link #down} — не повод для эвакуации.
   */
  private final Set<String> unreachable = ConcurrentHashMap.newKeySet();

  private final Map<String, Load> loads = new ConcurrentHashMap<>();
  private final AtomicLong saturatedLoggedAt = new AtomicLong(Long.MIN_VALUE / 2);

  /** Что известно о нагрузке узла по последнему опросу. Меняется под замком самого объекта. */
  static final class Load {
    volatile Sample sample = Sample.rooms(0, 0);
    volatile double pressure;
    volatile String by = "none";
    volatile boolean hot;
    long coolSince = -1;
    final AtomicInteger level = new AtomicInteger(1);
    long lowerSince = -1;

    /** Когда на узел ставились встречи последние {@link #RESERVE_MS}. */
    final Deque<Long> placed = new ArrayDeque<>();
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
    Gauge.builder("cord.nodes.saturated", this, nodes -> nodes.saturated() ? 1 : 0)
        .description(
            "Все живые медиаузлы горячие (Р-135): встречи создаются на наименее загруженном, запаса"
                + " нет")
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
    return all().stream()
        .filter(n -> n.enabled() && !down.contains(n.id()) && !unreachable.contains(n.id()))
        .toList();
  }

  public Choice choose(String preferred) {
    return choose(preferred, List.of());
  }

  public Choice choose(String preferred, List<Measure> measures) {
    return choose(preferred, measures, false);
  }

  /**
   * {@code manual} — узел просил человек в настройках, а не замер (Р-101): видно в метрике.
   * Выбранный узел получает резерв новой встречи на {@link #RESERVE_MS}.
   */
  public Choice choose(String preferred, List<Measure> measures, boolean manual) {
    var choice = decide(preferred, measures == null ? List.of() : measures);
    reserve(choice.node().id());
    Counter.builder("cord.node.choice")
        .description("Выбор узла для новой встречи: узел и причина")
        .tags(
            "node",
            choice.node().id(),
            "reason",
            choice.reason(),
            "manual",
            Boolean.toString(manual))
        .register(registry)
        .increment();
    return choice;
  }

  Choice decide(String preferred, List<Measure> measures) {
    var candidates = available();
    var control = control();
    var now = clock.millis();
    MediaNode wanted = null;
    if (preferred != null)
      for (var node : candidates) if (node.id().equals(preferred)) wanted = node;
    if (wanted != null && headroom(wanted, now)) return new Choice(wanted, "preferred");
    String why;
    if (wanted != null) why = "preferred-hot";
    else if (preferred == null) why = "default";
    else if (!knows(preferred)) why = "unknown";
    else if (down.contains(preferred)) why = "down";
    else if (unreachable.contains(preferred)) why = "unreachable";
    else why = "disabled";
    // Все мёртвы — встреча всё равно куда-то ставится (на узел управления), а не отказ.
    if (candidates.isEmpty()) return new Choice(control, why + "-all-down");
    var roomy = candidates.stream().filter(n -> headroom(n, now)).toList();
    if (!roomy.isEmpty()) {
      // Ближайший по пути создателя среди узлов с запасом: UDP впереди TCP, потом миллисекунды.
      var nearest = roomy.stream().filter(n -> ms(measures, n.id()) != null).min(byPath(measures));
      if (nearest.isPresent()) return new Choice(nearest.get(), why + "-measured");
      if (roomy.contains(control)) return new Choice(control, why + "-control");
      return new Choice(leastLoaded(roomy, measures, now), why + "-least");
    }
    // Запаса нет ни у кого: не отказ, а наименее загруженный узел; SFU снизит слои сам (Р-135).
    var least = leastLoaded(candidates, measures, now);
    var logged = saturatedLoggedAt.get();
    if (now - logged >= SATURATED_LOG_MS && saturatedLoggedAt.compareAndSet(logged, now))
      log.warn(
          "Every media node is over its soft limits — the meeting goes to the least loaded {} ({}"
              + " at {} % of its limit), not refused; add capacity",
          least.id(), loadOf(least).by, Math.round(predicted(least, now, 1).value() * 100));
    return new Choice(least, why + "-saturated");
  }

  private static Comparator<MediaNode> byPath(List<Measure> measures) {
    return Comparator.comparing((MediaNode n) -> !udpOpen(measures, n.id()))
        .thenComparingInt(n -> ms(measures, n.id()));
  }

  /**
   * Наименее загруженный по прогнозу с этой встречей; поровну — ближе по замеру, затем управление.
   */
  private MediaNode leastLoaded(List<MediaNode> nodes, List<Measure> measures, long now) {
    Comparator<MediaNode> order =
        Comparator.comparingDouble((MediaNode n) -> predicted(n, now, 1).value())
            .thenComparing(n -> ms(measures, n.id()) == null)
            .thenComparing(n -> !udpOpen(measures, n.id()))
            .thenComparingInt(
                n -> ms(measures, n.id()) == null ? Integer.MAX_VALUE : ms(measures, n.id()))
            .thenComparing(n -> !n.control());
    return nodes.stream().min(order).orElseThrow();
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
   * Опрос узлов сообщает, кто молчит по магистрали при живых людях; такие в выборе не участвуют.
   */
  public void unreachable(String id, boolean is) {
    if (is) unreachable.add(id);
    else unreachable.remove(id);
  }

  public boolean isUnreachable(String id) {
    return unreachable.contains(id);
  }

  /**
   * Нагрузка узла с опроса ({@link Sample}). Отсюда — горячий ли узел (с гистерезисом) и ступень.
   */
  public void load(String id, Sample sample) {
    var load = loadOf(id);
    var node = resolveExact(id);
    var now = clock.millis();
    synchronized (load) {
      load.sample = sample;
      if (node == null) return;
      var pressure = pressure(node, sample, 0);
      load.pressure = pressure.value();
      load.by = pressure.by();
      if (!load.hot && pressure.value() >= HOT) {
        load.hot = true;
        load.coolSince = -1;
        log.warn(
            "Media node {} is hot: {} at {} % of its soft limit — new meetings go to the nearest"
                + " node with headroom, running ones stay",
            id, pressure.by(), Math.round(pressure.value() * 100));
      } else if (load.hot) {
        if (pressure.value() >= COOL) load.coolSince = -1;
        else if (load.coolSince < 0) load.coolSince = now;
        else if (now - load.coolSince >= COOL_AFTER_MS) {
          load.hot = false;
          load.coolSince = -1;
          log.info("Media node {} has cooled down and takes new meetings again", id);
        }
      }
      var wanted = load.hot ? 4 : step(pressure.value());
      if (!Double.isNaN(sample.steal()) && sample.steal() > STEAL_BUSY)
        wanted = Math.max(wanted, 3);
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

  /** Горячий ли узел: новые встречи — мимо него, пока у другого есть запас. */
  public boolean hot(String id) {
    var load = loads.get(id);
    return load != null && load.hot;
  }

  /** Все живые узлы горячие: запаса нет нигде, встречи всё равно создаются (Р-135). */
  public boolean saturated() {
    var alive = available();
    return !alive.isEmpty() && alive.stream().allMatch(n -> hot(n.id()));
  }

  /** Ступень и состояние узла словами — для {@code GET /api/v1/nodes} и настроек. */
  public Level levelOf(MediaNode node) {
    String state;
    if (down.contains(node.id()) || unreachable.contains(node.id())) state = "down";
    else if (!node.enabled()) state = "drained";
    else if (hot(node.id())) state = "full";
    else if (level(node.id()) >= 3) state = "busy";
    else state = "ok";
    return new Level(level(node.id()), state);
  }

  /**
   * Есть ли у узла запас под ещё одну встречу: не горячий и с ней, и с недавно поставленными
   * останется ниже порога.
   */
  boolean headroom(MediaNode node, long now) {
    var load = loads.get(node.id());
    if (load != null && load.hot) return false;
    return predicted(node, now, 1).value() < HOT;
  }

  /** Нагрузка узла с резервом недавно поставленных встреч и {@code extra} новых. */
  Pressure predicted(MediaNode node, long now, int extra) {
    var load = loadOf(node.id());
    int reserved;
    synchronized (load) {
      while (!load.placed.isEmpty() && Math.abs(now - load.placed.peekFirst()) >= RESERVE_MS)
        load.placed.pollFirst();
      reserved = load.placed.size();
    }
    return pressure(node, load.sample, reserved + extra);
  }

  private void reserve(String id) {
    var load = loadOf(id);
    synchronized (load) {
      load.placed.addLast(clock.millis());
    }
  }

  /**
   * Нагрузка узла: наибольшая из долей ресурсов, каждая к своему порогу, с прибавкой {@code
   * meetings} новых встреч. Без ЦП из node-exporter — оценка по людям и ядрам; без памяти SFU — по
   * людям; остальное без данных не считается.
   */
  static Pressure pressure(MediaNode node, Sample sample, int meetings) {
    var value = 0.0;
    var by = "none";
    var cpu = sample.cpu();
    if (Double.isNaN(cpu) && node.cores() > 0)
      cpu = (double) sample.participants() / (node.cores() * PEOPLE_PER_CORE);
    if (!Double.isNaN(cpu)) {
      if (node.cores() > 0) cpu += meetings * MEETING_CORES / node.cores();
      if (cpu / CPU_HOT > value) {
        value = cpu / CPU_HOT;
        by = "cpu";
      }
    }
    var egress = Double.isNaN(sample.egressMbps()) ? 0 : sample.egressMbps();
    var uplink = (egress + meetings * MEETING_MBPS) / node.uplinkMbps() / EGRESS_HOT;
    if (uplink > value) {
      value = uplink;
      by = "egress";
    }
    if (!Double.isNaN(sample.memory()) && sample.memory() / MEMORY_HOT > value) {
      value = sample.memory() / MEMORY_HOT;
      by = "memory";
    }
    var sfu =
        Double.isNaN(sample.sfuMemoryMb())
            ? SFU_BASE_MB + SFU_MB_PER_PERSON * sample.participants()
            : sample.sfuMemoryMb();
    if (sfu / node.sfuMemoryMb() / SFU_MEMORY_HOT > value) {
      value = sfu / node.sfuMemoryMb() / SFU_MEMORY_HOT;
      by = "sfu-memory";
    }
    if (!Double.isNaN(sample.disk()) && sample.disk() / DISK_HOT > value) {
      value = sample.disk() / DISK_HOT;
      by = "disk";
    }
    return new Pressure(value, by);
  }

  /** Нагрузка → ступень 1…4 по третям порога; порог и выше — 4. */
  static int step(double pressure) {
    if (pressure < 0.35) return 1;
    if (pressure < 0.7) return 2;
    if (pressure < HOT) return 3;
    return 4;
  }

  private Load loadOf(MediaNode node) {
    return loadOf(node.id());
  }

  private Load loadOf(String id) {
    return loads.computeIfAbsent(id, this::track);
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
    Gauge.builder("cord.node.pressure", load, l -> l.pressure)
        .description(
            "Нагрузка медиаузла: наибольшая доля ресурса к его мягкому порогу, 1 — порог (Р-135)")
        .tags("node", id)
        .register(registry);
    Gauge.builder("cord.node.hot", load, l -> l.hot ? 1 : 0)
        .description("Медиаузел горячий: новые встречи идут на ближайший узел с запасом (Р-135)")
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
