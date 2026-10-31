package dev.mikki.stream.activity;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
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
 * <p>ОТДАЧА (R152). Рядом с приёмом — своя отдача за то же окно: каким кодеком, в железе или
 * процессором, сколько секунд кодировщик ограничивали процессор и канал, и смены кодека с причиной.
 * Отсюда доли кодеков и HW/SW по источнику на панели «Cord — медиа»: «работает ли гибкий кодек»
 * видно графиком, а не со слов. Метры — {@code cord.client.publish.seconds}, {@code
 * cord.client.tx.limited.seconds}, {@code cord.client.codec.switch}.
 *
 * <p>ПРИВАТНОСТЬ (П8). В сводке — класс дорожки, источник, кодек и причины из перечислений и числа
 * в пределах; ни номера дорожки, ни участника, ни видеокарты. Сводка никуда не ложится: только
 * метры.
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

  /**
   * Источники отдачи — как их зовёт клиент ({@code media/codec-planner.ts}: {@code PublishSource}).
   */
  public static final String SOURCES = "camera|screen";

  /** Кодеки отдачи — те же слова, что у итога звонка ({@link ClientQuality#CODECS}). */
  public static final String CODECS = ClientQuality.CODECS;

  /** Кодировщик в железе, процессором или браузер не сказал. */
  public static final String ENGINES = "hw|sw|unknown";

  /** Почему сменили кодек ({@code codec-planner.ts}: {@code SwitchReason}). */
  public static final String SWITCH_REASONS = "cpu|encode-time|software|restore|viewers|level";

  /** Кодеки, между которыми ходит смена, — без {@code other}: его не выбирает политика. */
  public static final String SWITCH_CODECS = "vp8|vp9|h264|h265|av1";

  /** Записей отдачи в сводке: два источника, по смене кодека посреди окна. */
  public static final int MAX_TX = 4;

  /** Смен кодека в сводке: между сменами одного источника не меньше 30 с. */
  public static final int MAX_SWITCHES = 8;

  /** Отдача одного источника одним кодеком за окно; секунды — по часам кодировщика. */
  public record TxTrack(
      @NotNull @Pattern(regexp = SOURCES) String source,
      @NotNull @Pattern(regexp = CODECS) String codec,
      @NotNull @Pattern(regexp = ENGINES) String hw,
      @DecimalMin("0") @DecimalMax("60") double seconds,
      @DecimalMin("0") @DecimalMax("60") double cpuSeconds,
      @DecimalMin("0") @DecimalMax("60") double bandwidthSeconds,
      @DecimalMin("0") @DecimalMax("60") double otherSeconds) {}

  /** Смена кодека отдачи. */
  public record TxSwitch(
      @NotNull @Pattern(regexp = SOURCES) String source,
      @NotNull @Pattern(regexp = SWITCH_CODECS) String from,
      @NotNull @Pattern(regexp = SWITCH_CODECS) String to,
      @NotNull @Pattern(regexp = SWITCH_REASONS) String reason) {}

  /**
   * Сводка за окно. {@code tx} и {@code switches} пришли с R152 и необязательны: веб старее ядра
   * (пока выкатка идёт) шлёт только приём.
   */
  public record RxSummary(
      @NotNull @Size(max = MAX_TRACKS) List<@Valid RxTrack> tracks,
      @Size(max = MAX_TX) List<@Valid TxTrack> tx,
      @Size(max = MAX_SWITCHES) List<@Valid TxSwitch> switches) {
    public RxSummary(List<RxTrack> tracks) {
      this(tracks, null, null);
    }
  }

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
    if (summary.tx() != null)
      for (var tx : summary.tx()) {
        if (tx.seconds() > 0)
          Counter.builder("cord.client.publish.seconds")
              .description("Секунды отдачи видео по источнику, кодеку и железу (сводки браузеров)")
              .tag("source", tx.source())
              .tag("codec", tx.codec())
              .tag("hw", tx.hw())
              .register(registry)
              .increment(tx.seconds());
        limited(tx.source(), "cpu", Math.min(tx.cpuSeconds(), tx.seconds()));
        limited(tx.source(), "bandwidth", Math.min(tx.bandwidthSeconds(), tx.seconds()));
        limited(tx.source(), "other", Math.min(tx.otherSeconds(), tx.seconds()));
      }
    if (summary.switches() != null)
      for (var change : summary.switches())
        Counter.builder("cord.client.codec.switch")
            .description("Смены кодека отдачи по источнику, направлению и причине")
            .tag("source", change.source())
            .tag("from", change.from())
            .tag("to", change.to())
            .tag("reason", change.reason())
            .register(registry)
            .increment();
  }

  private void limited(String source, String reason, double seconds) {
    if (seconds <= 0) return;
    Counter.builder("cord.client.tx.limited.seconds")
        .description("Секунды, когда кодировщик отдачи ограничивали процессор, канал или прочее")
        .tag("source", source)
        .tag("reason", reason)
        .register(registry)
        .increment(seconds);
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
