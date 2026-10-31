package dev.mikki.stream.activity;

import dev.mikki.stream.room.RoomRepository;
import dev.mikki.stream.room.RoomState;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Clock;
import java.util.*;
import org.springframework.stereotype.Component;

/**
 * Метры Cord для {@code /actuator/prometheus} ({@code docs/observability.md} §4).
 *
 * <p>ПРАВИЛО МЕТОК. В метках — только перечисления: состояние, причина, код ошибки из реестра, вид
 * интеграции. Ни номера встречи, ни участника, ни имени, ни адреса — ради приватности (П8) и числа
 * рядов: метка с номером встречи — это новый ряд на каждую встречу навсегда.
 *
 * <p>СНИМОК РАЗ В {@link #FRESH_MS}. Сколько встреч идёт и сколько в них людей, считается по всем
 * комнатам — это чтение снимков из базы. Сбор приходит раз в 30 с, но читать базу на каждый запрос
 * метрик незачем: числа берутся из последнего подсчёта, если ему меньше десяти секунд.
 *
 * <p>Люди и боты считаются раздельно ({@link RoomState.Member#human()}): в SFU бот — такой же
 * участник, и сколько людей на сервере, LiveKit не скажет.
 */
@Component
public class Metrics {
  static final long FRESH_MS = 10_000;

  /** Виды интеграций, которые метры знают поимённо. Остальное — {@code other}. */
  public static final List<String> INTEGRATIONS =
      List.of("watch", "music", "poker", "durak", "chess", "gartic", "board");

  private final MeterRegistry registry;
  private final RoomRepository rooms;
  private final Clock clock;
  private volatile Census census = Census.EMPTY;
  private volatile long countedAt;
  private final DistributionSummary duration;
  private final DistributionSummary peak;

  record Census(
      int live,
      int waiting,
      int humans,
      int connected,
      int bots,
      int screens,
      Map<String, Integer> integrations) {
    static final Census EMPTY = new Census(0, 0, 0, 0, 0, 0, Map.of());
  }

  public Metrics(MeterRegistry registry, RoomRepository rooms, Clock clock) {
    this.registry = registry;
    this.rooms = rooms;
    this.clock = clock;
    gauge("cord.rooms.active", "Встречи на сервере", c -> c.live(), "state", "live");
    gauge("cord.rooms.active", "Встречи на сервере", c -> c.waiting(), "state", "waiting");
    gauge("cord.participants.active", "Люди на местах (без ботов)", Census::humans);
    gauge("cord.participants.connected", "Люди на связи", Census::connected);
    gauge("cord.bots.active", "Боты во встречах", Census::bots);
    gauge("cord.screens.active", "Идущие демонстрации экрана", Census::screens);
    for (var kind : INTEGRATIONS)
      gauge(
          "cord.integrations.active",
          "Идущие интеграции",
          c -> c.integrations().getOrDefault(kind, 0),
          "kind",
          kind);
    duration =
        DistributionSummary.builder("cord.meeting.duration")
            .description("Длительность завершённой встречи, с (от двух людей на связи до конца)")
            .baseUnit("seconds")
            .serviceLevelObjectives(300, 900, 1800, 3600, 7200, 14400)
            .register(registry);
    peak =
        DistributionSummary.builder("cord.meeting.peak.participants")
            .description("Пик людей на связи за встречу")
            .serviceLevelObjectives(2, 3, 4, 6, 8, 12, 16, 20)
            .register(registry);
    var build = System.getenv("CORD_BUILD");
    Gauge.builder("cord.build.info", () -> 1)
        .description("Версия ядра — подписи выкаток на графиках")
        .tag("version", build == null || build.isBlank() ? "dev" : build)
        .register(registry);
  }

  private void gauge(
      String name,
      String description,
      java.util.function.ToIntFunction<Census> value,
      String... tags) {
    Gauge.builder(name, this, m -> value.applyAsInt(m.census()))
        .description(description)
        .tags(tags)
        .register(registry);
  }

  /** Подсчёт по всем комнатам, не старше {@link #FRESH_MS}. */
  Census census() {
    long now = clock.millis();
    if (now - countedAt < FRESH_MS && now >= countedAt) return census;
    int live = 0, waiting = 0, humans = 0, connected = 0, bots = 0, screens = 0;
    var integrations = new HashMap<String, Integer>();
    for (var room : rooms.all()) {
      if (room.closedAt != null) continue;
      if (room.startedAt != null) live++;
      else waiting++;
      for (var member : room.members.values()) {
        if (!member.occupiesSeat()) continue;
        if (member.human()) {
          humans++;
          if (member.status == RoomState.Status.CONNECTED) connected++;
          if (member.screen && member.screenStarted) screens++;
        } else bots++;
      }
      for (var kind : Activity.integrations(room)) integrations.merge(kind, 1, Integer::sum);
    }
    census = new Census(live, waiting, humans, connected, bots, screens, Map.copyOf(integrations));
    countedAt = now;
    return census;
  }

  public void meetingStarted() {
    counter("cord.meetings.started", "Встречи, где на связи стало двое людей").increment();
  }

  public void meetingEnded(String reason, long seconds, int peakHumans) {
    Counter.builder("cord.meetings.ended")
        .description("Завершённые встречи по причине")
        .tag("reason", reason == null ? "other" : reason)
        .register(registry)
        .increment();
    duration.record(seconds);
    peak.record(peakHumans);
  }

  /** Вход во встречу: {@code ok} или код отказа в нижнем регистре ({@code room_full}, …). */
  public void joined(String door, String result) {
    Counter.builder("cord.joins")
        .description("Входы во встречу по двери и исходу")
        .tag("door", door)
        .tag("result", result)
        .register(registry)
        .increment();
  }

  /** Отказ ядра: код из реестра ошибок и статус HTTP. */
  public void refused(String code, int status) {
    Counter.builder("cord.errors")
        .description("Отказы ядра по коду")
        .tag("code", code == null ? "OTHER" : code)
        .tag("status", Integer.toString(status))
        .register(registry)
        .increment();
  }

  public void blocked(String kind, String by) {
    Counter.builder("cord.blocks.created")
        .description("Поставленные блокировки")
        .tag("kind", kind)
        .tag("by", by)
        .register(registry)
        .increment();
  }

  private Counter counter(String name, String description) {
    return Counter.builder(name).description(description).register(registry);
  }
}
