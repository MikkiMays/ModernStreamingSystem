package dev.mikki.stream.activity;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;
import org.springframework.stereotype.Component;

/**
 * Сводки приёма от браузеров раз в десять секунд ({@code POST /api/v1/rooms/{id}/quality}, W1b шаг
 * 4, {@code docs/observability.md} §4): что слышит человек на самом деле — заглушка NetEq, её
 * события, потери и запас буфера по классу дорожки.
 *
 * <p>ЗАЧЕМ. Куратор меряет путь через SFU на самой машине, итог звонка ({@link ClientQuality})
 * приходит один раз в конце. Между ними — пустота: «музыка лагает» нельзя было увидеть графиком,
 * пока разговор идёт. Сводка раз в 10 с — те же числа, что решают запас буфера у клиента ({@code
 * media/playout.ts}), гистограммами Micrometer: доля заглушки, запас, провалы в минуту.
 *
 * <p>ПРИВАТНОСТЬ (П8). В сводке — класс дорожки из перечисления и числа в пределах; ни номера
 * дорожки, ни участника; в метках — только {@code kind}. Сводка никуда не ложится: только метры.
 */
@Component
public class RxQuality {
  /** Классы дорожек — как их зовёт клиент ({@code media/playout.ts}: {@code PlayoutClass}). */
  public static final String KINDS = "conversation|media|video";

  /** Дорожек в одной сводке — больше четырёх классов не бывает; лишнее — не сводка. */
  public static final int MAX_TRACKS = 8;

  /** Одна дорожка за десять секунд: разности счётчиков inbound-rtp и запас буфера. */
  public record RxTrack(
      @NotNull @Pattern(regexp = KINDS) String kind,
      /** Отсчётов заглушки за окно без тишины DTX. */
      @Min(0) @Max(100_000_000) long concealed,
      /** Отсчётов получено за окно. */
      @Min(0) @Max(100_000_000) long total,
      /** Сколько раз заглушка начиналась — слышимые провалы. */
      @Min(0) @Max(100_000) int events,
      @Min(0) @Max(1_000_000) int lost,
      /** Запас буфера, который клиент просит у приёмника, мс. */
      @Min(0) @Max(10_000) int targetMs,
      /** Фактическая задержка буфера, мс; {@code null} — не измерена. */
      @Min(0) @Max(60_000) Integer delayMs) {}

  public record RxSummary(@NotNull @Size(max = MAX_TRACKS) List<@Valid RxTrack> tracks) {}

  private final MeterRegistry registry;

  public RxQuality(MeterRegistry registry) {
    this.registry = registry;
  }

  public void record(RxSummary summary) {
    Counter.builder("cord.rx.reports")
        .description("Сводки приёма от браузеров")
        .register(registry)
        .increment();
    for (var track : summary.tracks()) {
      var kind = track.kind();
      if (track.total() > 0)
        DistributionSummary.builder("cord.rx.conceal.ratio")
            .description("Доля отсчётов заглушки за 10 с по классу дорожки")
            .tag("kind", kind)
            .serviceLevelObjectives(0.001, 0.004, 0.01, 0.03, 0.1, 0.3)
            .register(registry)
            .record(Math.min(1.0, (double) track.concealed() / track.total()));
      DistributionSummary.builder("cord.rx.target.ms")
          .description("Запас буфера приёма, который просит клиент, мс")
          .tag("kind", kind)
          .serviceLevelObjectives(60, 120, 200, 400, 800, 1500, 2500)
          .register(registry)
          .record(track.targetMs());
      if (track.delayMs() != null)
        DistributionSummary.builder("cord.rx.delay.ms")
            .description("Фактическая задержка буфера приёма, мс")
            .tag("kind", kind)
            .serviceLevelObjectives(60, 120, 200, 400, 800, 1500, 2500)
            .register(registry)
            .record(track.delayMs());
      count(
          "cord.rx.concealment.events", "Слышимые провалы (начала заглушки)", kind, track.events());
      count("cord.rx.packets.lost", "Потерянные пакеты по отчётам приёма", kind, track.lost());
      count("cord.rx.samples", "Отсчётов получено по отчётам приёма", kind, track.total());
      count(
          "cord.rx.concealed.samples",
          "Отсчётов заглушки по отчётам приёма",
          kind,
          track.concealed());
    }
  }

  private void count(String name, String description, String kind, double amount) {
    if (amount <= 0) return;
    Counter.builder(name)
        .description(description)
        .tag("kind", kind)
        .register(registry)
        .increment(amount);
  }
}
