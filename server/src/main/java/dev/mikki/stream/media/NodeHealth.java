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
 * — узел жив и держит столько комнат (это знает {@link MediaNodes}, чтобы не ставить встречи на
 * полный узел). {@link #DEAD_AFTER} отказов подряд (≈ 10–15 с с таймаутами) — узел мёртв: новые
 * встречи на него не ставятся, а идущие {@link MediaService#evacuate переезжают} на живой узел —
 * клиенты в окне восстановления берут новый токен и приходят туда. Ожил — снова принимает встречи;
 * переехавшие комнаты назад не возвращаются.
 *
 * <p>Метрики: {@code cord.node.up{node}} (1/0), {@code cord.node.rooms{node}}; алерт {@code
 * NodeDown} — {@code infra/monitoring/rules/cord.yml}.
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

  private final MediaNodes nodes;
  private final MediaGateway gateway;
  private final MediaService media;
  private final MeterRegistry registry;
  private final Clock clock;
  private final Map<String, State> states = new ConcurrentHashMap<>();

  static final class State {
    final AtomicInteger up = new AtomicInteger(1);
    final AtomicInteger rooms = new AtomicInteger();
    int failures;
    long since;
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
      Integer rooms;
      try {
        rooms = gateway.rooms(node);
      } catch (RuntimeException e) {
        rooms = null;
      }
      observe(node, rooms, clock.millis());
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

  /** Один ответ узла: {@code rooms} — сколько комнат он держит, {@code null} — не ответил. */
  public void observe(MediaNode node, Integer rooms, long now) {
    var state = states.computeIfAbsent(node.id(), this::track);
    if (rooms != null) {
      state.rooms.set(rooms);
      nodes.rooms(node.id(), rooms);
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
    return state;
  }
}
