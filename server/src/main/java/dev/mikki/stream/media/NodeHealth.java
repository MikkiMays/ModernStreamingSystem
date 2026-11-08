package dev.mikki.stream.media;

import dev.mikki.stream.nodes.MediaNode;
import dev.mikki.stream.nodes.MediaNodes;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Tags;
import java.time.Clock;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Опрос медиаузлов (R195, {@code docs/architecture/distributed-media.md}, поправка 08.11.2026).
 *
 * <p>Раз в {@link #PERIOD_MS} ядро спрашивает у каждого узла {@code ListRooms} по магистрали. Ответ
 * — узел жив и держит столько комнат и людей (это знает {@link MediaNodes}, чтобы не ставить
 * встречи на полный узел и считать ступень нагрузки). {@link #DEAD_AFTER} отказов подряд (≈ 10–15 с
 * с таймаутами) — узел мёртв: новые встречи на него не ставятся, а идущие {@link
 * MediaService#evacuate переезжают} на живой узел — клиенты в окне восстановления берут новый токен
 * и приходят туда. Ожил — снова принимает встречи; переехавшие комнаты назад не возвращаются.
 *
 * <p>Ёмкость (R200, {@code server-selection.md} §3.4): тем же проходом читается node-exporter узла
 * ({@link MediaGateway#metrics}, {@link NodeExporter}) — ЦП со steal и отдача канала; по разности
 * двух снимков вместе с комнатами и людьми {@link MediaNodes#load} считает ступень 1–4. Молчание
 * node-exporter — не отказ узла: ступень считается по встречам и людям.
 *
 * <p>Метрики: {@code cord.node.up{node}} (1/0), {@code cord.node.rooms{node}}, {@code
 * cord.node.participants{node}}, {@code cord.node.level{node}} (в {@link MediaNodes}); алерты
 * {@code NodeDown}, {@code NodeSaturated} — {@code infra/monitoring/rules/cord.yml}.
 */
@Component
@ConditionalOnProperty(
    name = "stream.scheduling-enabled",
    havingValue = "true",
    matchIfMissing = true)
public class NodeHealth {
  private static final Logger log = LoggerFactory.getLogger(NodeHealth.class);
  static final long PERIOD_MS = 5000;
  static final int DEAD_AFTER = 3;

  // Вызов узла — 1 с (`MediaGateway.rooms`): три молчания — ≈ 3 × (1 + 5) с.

  /** Сглаживание долей ЦП и канала между опросами — как у {@code LoadMeter}. */
  private static final double EWMA = 0.35;

  private final MediaNodes nodes;
  private final MediaGateway gateway;
  private final MediaService media;
  private final MeterRegistry registry;
  private final Clock clock;
  private final Map<String, State> states = new ConcurrentHashMap<>();

  static final class State {
    final AtomicInteger up = new AtomicInteger(1);
    final AtomicInteger rooms = new AtomicInteger();
    final AtomicInteger participants = new AtomicInteger();
    int failures;
    long since;
    NodeExporter.Sample sample;
    double cpu = Double.NaN;
    double steal = Double.NaN;
    double mbps = Double.NaN;
  }

  public NodeHealth(
      MediaNodes nodes,
      MediaGateway gateway,
      MediaService media,
      MeterRegistry registry,
      Clock clock) {
    this.nodes = nodes;
    this.gateway = gateway;
    this.media = media;
    this.registry = registry;
    this.clock = clock;
  }

  @Scheduled(fixedDelay = PERIOD_MS)
  public void tick() {
    for (var node : nodes.all()) {
      MediaGateway.NodeStats stats;
      try {
        stats = gateway.rooms(node);
      } catch (RuntimeException e) {
        stats = null;
      }
      var now = clock.millis();
      if (stats != null) measure(node, gateway.metrics(node), now);
      observe(node, stats, now);
    }
    sweep();
  }

  /**
   * Переселить всё, что ещё стоит на мёртвых узлах, — на каждом проходе, пока узел мёртв: комнаты,
   * созданные с опозданием, не дошедшие в прошлый раз из-за ошибки, и те, кому не хватало живого
   * узла, пока он не вернулся. {@code evacuate} идемпотентен и дёшев (проход по открытым комнатам).
   */
  public void sweep() {
    for (var node : nodes.all())
      if (nodes.isDown(node.id()))
        try {
          media.evacuate(node.id());
        } catch (RuntimeException e) {
          log.warn("Evacuating rooms from {} failed; next tick retries", node.id(), e);
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
      if (state.failures >= DEAD_AFTER) {
        log.info("Media node {} is back after {} s", node.id(), (now - state.since) / 1000);
        nodes.down(node.id(), false);
      }
      state.failures = 0;
      state.up.set(1);
      return;
    }
    if (state.failures == 0) state.since = now;
    state.failures++;
    if (state.failures == DEAD_AFTER) {
      log.warn(
          "Media node {} did not answer {} times in a row — moving its rooms",
          node.id(),
          DEAD_AFTER);
      state.up.set(0);
      nodes.down(node.id(), true);
    }
  }

  /**
   * Снимок node-exporter узла ({@code null} — не ответил): доли считаются по разности с прошлым
   * снимком и сглаживаются; без двух снимков долей нет ({@code NaN}).
   */
  public void measure(MediaNode node, String metrics, long now) {
    var state = states.computeIfAbsent(node.id(), this::track);
    var sample = metrics == null ? null : NodeExporter.parse(metrics, now);
    if (sample == null) {
      // Молчание дольше двух опросов — старые доли ничего не значат, считаем без них.
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
        .description("Медиаузел отвечает на ListRooms (1) или мёртв (0)")
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
