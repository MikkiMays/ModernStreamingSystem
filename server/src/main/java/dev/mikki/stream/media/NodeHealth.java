package dev.mikki.stream.media;

import dev.mikki.stream.nodes.MediaNode;
import dev.mikki.stream.nodes.MediaNodes;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Tags;
import jakarta.annotation.PreDestroy;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Опрос медиаузлов и решение «узел мёртв» по двум независимым признакам (R195; R200 §5, Р-105).
 *
 * <p>Раз в {@link #PERIOD_MS} ядро спрашивает у каждого узла {@code ListRooms} по магистрали (все
 * узлы — параллельно, таймаут вызова 1 с). Ответ — узел жив и держит столько комнат и людей (это
 * знает {@link MediaNodes}: не ставить встречи на полный узел, считать ступень нагрузки).
 *
 * <p>Промахи опроса сами по себе — ещё не смерть: хост узла замирает на 2–4 с (steal), магистраль
 * через фильтр A рвётся, а люди при этом на связи — переезд им только навредил бы. Поэтому узел
 * признаётся мёртвым, когда выполнено одно из правил:
 *
 * <ul>
 *   <li><b>A</b> — ≥ {@link #MISSES_WITH_PEOPLE} промахов подряд <b>и</b> ≥ половины подключённых к
 *       узлу людей пожаловались ядру ({@code media.stall}/{@code media.lost}, {@link LossReports}).
 *       Проверяется и по опросу, и сразу по каждой жалобе: ≈ 4–6 с от остановки SFU.
 *   <li><b>B</b> — ≥ {@link #MISSES_WITHOUT_PEOPLE} промахов подряд, а людей на узле нет: ломать
 *       нечего, узел просто выводится из выбора надёжнее (≈ 8–10 с).
 *   <li><b>C</b> — опрос отвечает, но ≥ половины людей узла в беде дольше {@link
 *       LossReports#STUCK_MS}: путь к узлу мёртв для людей, а не для магистрали (UDP/443 к узлу
 *       режут у провайдера). Медленный порог — против массового «мигания» VPN.
 * </ul>
 *
 * <p>Промахи без жалоб ({@code ≥ MISSES_WITH_PEOPLE}) — узел {@code unreachable}: новые встречи на
 * него не ставятся, идущие не трогаются, метрика {@code cord.node.reachable} 0 и алерт {@code
 * NodeUnreachable}. Ответил — снова в строю. Мёртвый узел: {@code cord.node.up} 0, его встречи
 * {@link MediaService#evacuate переезжают} сразу и на каждом проходе, пока он мёртв; ожил — снова
 * принимает встречи, переехавшие комнаты назад не возвращаются.
 *
 * <p>Ёмкость (R200 §3.4): тем же проходом читается node-exporter узла ({@link
 * MediaGateway#metrics}, {@link NodeExporter}) — ЦП со steal и отдача канала; по разности двух
 * снимков вместе с комнатами и людьми {@link MediaNodes#load} считает ступень 1–4. Молчание
 * node-exporter — не отказ узла.
 *
 * <p>Метрики: {@code cord.node.up{node}}, {@code cord.node.reachable{node}}, {@code
 * cord.node.rooms{node}}, {@code cord.node.participants{node}}, {@code cord.node.level{node}} (в
 * {@link MediaNodes}); алерты {@code NodeDown}, {@code NodeUnreachable}, {@code NodeSaturated} —
 * {@code infra/monitoring/rules/cord.yml}.
 */
@Component
@ConditionalOnProperty(
    name = "stream.scheduling-enabled",
    havingValue = "true",
    matchIfMissing = true)
public class NodeHealth {
  private static final Logger log = LoggerFactory.getLogger(NodeHealth.class);
  static final long PERIOD_MS = 2000;

  /** Правило A: столько промахов подряд вместе с жалобами половины людей — узел мёртв. */
  static final int MISSES_WITH_PEOPLE = 2;

  /** Правило B: столько промахов подряд без людей на узле — узел мёртв. */
  static final int MISSES_WITHOUT_PEOPLE = 4;

  /** Узел молчит, люди есть, жалоб нет: снимки комнат перечитываются не чаще этого (правило B). */
  static final long RECHECK_MS = 10_000;

  /** Сглаживание долей ЦП и канала между опросами — как у {@code LoadMeter}. */
  private static final double EWMA = 0.35;

  /** Доли людей узла, которых достаточно для решения: половина. */
  static boolean quorum(int lost, int people) {
    return people > 0 && lost * 2 >= people;
  }

  private final MediaNodes nodes;
  private final MediaGateway gateway;
  private final MediaService media;
  private final LossReports losses;
  private final MeterRegistry registry;
  private final Clock clock;
  private final Map<String, State> states = new ConcurrentHashMap<>();

  /** Опрос узлов и оценка по жалобам — вне потока запроса и вне планировщика. */
  private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();

  static final class State {
    final AtomicInteger up = new AtomicInteger(1);
    final AtomicInteger reachable = new AtomicInteger(1);
    final AtomicInteger rooms = new AtomicInteger();
    final AtomicInteger participants = new AtomicInteger();
    volatile int failures;
    volatile long since;
    volatile long peopleAt;
    NodeExporter.Sample sample;
    double cpu = Double.NaN;
    double steal = Double.NaN;
    double mbps = Double.NaN;
  }

  public NodeHealth(
      MediaNodes nodes,
      MediaGateway gateway,
      MediaService media,
      LossReports losses,
      MeterRegistry registry,
      Clock clock) {
    this.nodes = nodes;
    this.gateway = gateway;
    this.media = media;
    this.losses = losses;
    this.registry = registry;
    this.clock = clock;
    // Жалоба пришла — оценить узел сейчас, не дожидаясь опроса: это и даёт ≈ 4–6 с вместо 15.
    losses.subscribe(id -> executor.execute(() -> onReport(id)));
  }

  @PreDestroy
  void shutdown() {
    executor.shutdownNow();
  }

  @Scheduled(fixedRate = PERIOD_MS)
  public void tick() {
    var all = nodes.all();
    var polls = new ArrayList<CompletableFuture<Void>>(all.size());
    for (var node : all)
      polls.add(
          CompletableFuture.runAsync(
              () -> {
                MediaGateway.NodeStats stats;
                try {
                  stats = gateway.rooms(node);
                } catch (RuntimeException e) {
                  stats = null;
                }
                var now = clock.millis();
                if (stats != null) measure(node, gateway.metrics(node), now);
                observe(node, stats, now);
              },
              executor));
    for (var poll : polls)
      try {
        poll.join();
      } catch (RuntimeException e) {
        log.warn("Polling a media node failed", e);
      }
    sweep();
  }

  /**
   * Переселить всё, что ещё стоит на мёртвых узлах, — на каждом проходе, пока узел мёртв: комнаты,
   * созданные с опозданием, не дошедшие в прошлый раз из-за ошибки, и те, кому не хватало живого
   * узла, пока он не вернулся. {@code evacuate} идемпотентен и дёшев (проход по открытым комнатам).
   */
  public void sweep() {
    for (var node : nodes.all()) if (nodes.isDown(node.id())) evacuate(node.id());
  }

  private void evacuate(String id) {
    try {
      media.evacuate(id);
    } catch (RuntimeException e) {
      log.warn("Evacuating rooms from {} failed; next tick retries", id, e);
    }
  }

  /** Один ответ узла: комнаты и люди, {@code null} — не ответил. */
  public void observe(MediaNode node, MediaGateway.NodeStats stats, long now) {
    var state = states.computeIfAbsent(node.id(), this::track);
    if (stats != null) {
      state.rooms.set(stats.rooms());
      state.participants.set(stats.participants());
      nodes.load(
          node.id(), stats.rooms(), stats.participants(), state.cpu, state.steal, state.mbps);
      if (state.up.get() == 0) {
        log.info("Media node {} is back after {} s", node.id(), (now - state.since) / 1000);
        nodes.down(node.id(), false);
      } else if (state.reachable.get() == 0)
        log.info("Media node {} answers again after {} s", node.id(), (now - state.since) / 1000);
      state.failures = 0;
      state.up.set(1);
      if (state.reachable.compareAndSet(0, 1)) nodes.unreachable(node.id(), false);
      // Правило C: магистраль отвечает, а люди узла давно без медиа. Снимки комнат читаются только
      // когда на узле есть хоть одна отметка — в спокойном состоянии опрос базу не трогает.
      if (losses.reported(node.id()) == 0) return;
      var people = media.onNode(node.id());
      var stuck = losses.lostAmong(node.id(), people, now, LossReports.STUCK_MS);
      if (quorum(stuck, people.size()))
        die(
            node,
            state,
            now,
            "%d of %d people lost media for %d s while the node answers"
                .formatted(stuck, people.size(), LossReports.STUCK_MS / 1000));
      return;
    }
    if (state.failures == 0) state.since = now;
    state.failures++;
    if (state.failures >= MISSES_WITH_PEOPLE && state.reachable.compareAndSet(1, 0)) {
      log.warn(
          "Media node {} did not answer {} times in a row — no new rooms go there until it does",
          node.id(),
          state.failures);
      nodes.unreachable(node.id(), true);
    }
    assess(node, state, now);
  }

  /** Новая жалоба на узел: правило A может сработать до следующего опроса. */
  void onReport(String id) {
    for (var node : nodes.all()) if (node.id().equals(id)) reassess(node, clock.millis());
  }

  /** Оценить узел по текущим промахам и жалобам (тесты зовут напрямую со своим временем). */
  public void reassess(MediaNode node, long now) {
    var state = states.get(node.id());
    if (state == null || state.up.get() == 0 || state.failures == 0) return;
    assess(node, state, now);
  }

  private void assess(MediaNode node, State state, long now) {
    if (state.up.get() == 0) return;
    int failures = state.failures;
    if (failures < MISSES_WITH_PEOPLE) return;
    // Снимки комнат — только когда они могут что-то решить: есть жалобы (правило A), промахов стало
    // ровно столько, сколько нужно правилу B, или узел давно молчит и люди могли разойтись (раз в
    // RECHECK_MS). Длинный обрыв магистрали без жалоб не читает базу каждые 2 с.
    boolean reports = losses.reported(node.id()) > 0;
    boolean recheck = failures > MISSES_WITHOUT_PEOPLE && now - state.peopleAt >= RECHECK_MS;
    if (!reports && failures != MISSES_WITHOUT_PEOPLE && !recheck) return;
    var people = media.onNode(node.id());
    state.peopleAt = now;
    if (people.isEmpty()) {
      if (failures >= MISSES_WITHOUT_PEOPLE)
        die(node, state, now, "%d misses in a row, nobody connected".formatted(failures));
      return;
    }
    var lost = losses.lostAmong(node.id(), people, now, 0);
    if (quorum(lost, people.size()))
      die(
          node,
          state,
          now,
          "%d misses in a row and %d of %d people lost media"
              .formatted(failures, lost, people.size()));
  }

  private void die(MediaNode node, State state, long now, String why) {
    if (!state.up.compareAndSet(1, 0)) return;
    log.warn(
        "Media node {} is dead ({} s since the first miss): {} — moving its rooms",
        node.id(),
        state.failures == 0 ? 0 : (now - state.since) / 1000,
        why);
    nodes.down(node.id(), true);
    evacuate(node.id());
    losses.clear(node.id());
  }

  /**
   * Снимок node-exporter узла ({@code null} — не ответил): доли считаются по разности с прошлым
   * снимком и сглаживаются; без двух снимков долей нет ({@code NaN}).
   */
  public void measure(MediaNode node, String metrics, long now) {
    var state = states.computeIfAbsent(node.id(), this::track);
    var sample = metrics == null ? null : NodeExporter.parse(metrics, now);
    if (sample == null) {
      // Молчание дольше трёх опросов — старые доли ничего не значат, считаем без них.
      if (state.sample != null && now - state.sample.at() > 3 * PERIOD_MS) {
        state.sample = null;
        state.cpu = state.steal = state.mbps = Double.NaN;
      }
      return;
    }
    var shares = sample.since(state.sample);
    state.sample = sample;
    if (shares == null) return;
    state.cpu = smooth(state.cpu, shares.cpu());
    state.steal = smooth(state.steal, shares.steal());
    if (!Double.isNaN(shares.mbps())) state.mbps = smooth(state.mbps, shares.mbps());
  }

  private static double smooth(double previous, double value) {
    return Double.isNaN(previous) ? value : previous + EWMA * (value - previous);
  }

  private State track(String id) {
    var state = new State();
    Gauge.builder("cord.node.up", state.up, AtomicInteger::get)
        .description("Медиаузел жив (1) или признан мёртвым (0): его встречи переехали")
        .tags(Tags.of("node", id))
        .register(registry);
    Gauge.builder("cord.node.reachable", state.reachable, AtomicInteger::get)
        .description("Медиаузел отвечает на ListRooms по магистрали (1) или молчит (0)")
        .tags(Tags.of("node", id))
        .register(registry);
    Gauge.builder("cord.node.rooms", state.rooms, AtomicInteger::get)
        .description("Сколько комнат держит SFU узла")
        .tags(Tags.of("node", id))
        .register(registry);
    Gauge.builder("cord.node.participants", state.participants, AtomicInteger::get)
        .description("Сколько людей на связи в комнатах SFU узла")
        .tags(Tags.of("node", id))
        .register(registry);
    return state;
  }
}
