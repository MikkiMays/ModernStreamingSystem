package dev.mikki.stream.activity;

import dev.mikki.stream.room.RoomState;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.util.*;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Качество связи глазами браузеров ({@code POST /api/v1/rooms/{id}/client-report}, {@code
 * docs/observability.md} §15): в конце звонка браузер присылает короткий итог — оборот, потери,
 * джиттер, битрейт приёма, замирания картинки, путь и кодек, — и он ложится в строку встречи {@code
 * meeting_stats} суммами (V12).
 *
 * <p>ПРИВАТНОСТЬ (П8). Только числа в пределах и слова из перечислений: ни имени, ни адреса, ни
 * номера участника в итоге нет, в строке встречи — тоже. В метрики — те же числа с меткой пути
 * ({@code path}: перечисление).
 *
 * <p>ВСТРЕЧА — В СМЫСЛЕ П7. Итог ложится во встречу, которая идёт или шла в комнате ({@code
 * startedAt}); звонок одного человека встречей не был, и его итогу лечь некуда. Вход из прошлой
 * встречи той же комнаты (до повторного открытия из избранного) в новую не засчитывается.
 */
@Component
public class ClientQuality {
  /** Пути связи — как их называет браузер ({@code media/link-quality.ts}). */
  public static final String PATHS = "direct-udp|direct-tcp|relay-udp|relay-tcp|unknown";

  /** Кодеки картинки, которые клиент называет по имени; остальное — {@code other}. */
  public static final String CODECS = "vp8|vp9|h264|h265|av1|other";

  /**
   * Итог звонка одного входа. {@code null} — величины не было (браузер её не отдаёт или звонок без
   * приёма). Пределы — с запасом над тем, что бывает, и ниже того, что могло бы испортить средние.
   */
  public record Report(
      @Min(0) @Max(86_400) int seconds,
      @Min(0) @Max(60_000) Integer rttMs,
      @DecimalMin("0") @DecimalMax("100") Double lossPercent,
      @Min(0) @Max(60_000) Integer jitterMs,
      @Min(0) @Max(1_000_000) Integer bitrateKbps,
      @Min(0) @Max(100_000) int freezes,
      @Min(0) @Max(86_400) int freezeSeconds,
      @Min(0) @Max(86_400) int lossySeconds,
      @NotNull @Pattern(regexp = PATHS) String path,
      @Pattern(regexp = CODECS) String codec) {}

  private final JdbcClient jdbc;
  private final MeterRegistry registry;

  public ClientQuality(JdbcClient jdbc, MeterRegistry registry) {
    this.jdbc = jdbc;
    this.registry = registry;
  }

  /**
   * Засчитать итог входа {@code member} во встречу комнаты. {@code false} — встречи не было (один
   * человек, вход из прошлой встречи) или её строки нет: итог принят и забыт.
   */
  public boolean record(RoomState room, RoomState.Member member, Report report) {
    meter(report);
    if (room.startedAt == null || !member.human()) return false;
    if (room.openedAt != null && member.joinedAt < room.openedAt) return false;
    boolean relay = report.path().startsWith("relay");
    int updated =
        jdbc.sql(
                "UPDATE meeting_stats SET quality_reports=quality_reports+1,"
                    + " quality_seconds=quality_seconds+?, lossy_seconds=lossy_seconds+?,"
                    + " rtt_ms_sum=rtt_ms_sum+?, rtt_reports=rtt_reports+?,"
                    + " rtt_ms_max=GREATEST(rtt_ms_max,?),"
                    + " loss_permille_sum=loss_permille_sum+?, loss_reports=loss_reports+?,"
                    + " jitter_ms_sum=jitter_ms_sum+?, jitter_reports=jitter_reports+?,"
                    + " bitrate_kbps_sum=bitrate_kbps_sum+?, bitrate_reports=bitrate_reports+?,"
                    + " freezes=freezes+?, freeze_seconds=freeze_seconds+?,"
                    + " relay_reports=relay_reports+?, codecs=? WHERE room_id=? AND started_at=?")
            .params(
                report.seconds(),
                Math.min(report.lossySeconds(), report.seconds()),
                orZero(report.rttMs()),
                present(report.rttMs()),
                orZero(report.rttMs()),
                report.lossPercent() == null ? 0 : Math.round(report.lossPercent() * 10),
                present(report.lossPercent()),
                orZero(report.jitterMs()),
                present(report.jitterMs()),
                orZero(report.bitrateKbps()),
                present(report.bitrateKbps()),
                report.freezes(),
                Math.min(report.freezeSeconds(), report.seconds()),
                relay ? 1 : 0,
                codecs(room, report.codec()),
                room.id,
                room.startedAt)
            .update();
    return updated > 0;
  }

  /** Слова кодеков встречи: уже записанные и этот, по алфавиту, без повторов. */
  private String codecs(RoomState room, String codec) {
    var known =
        jdbc.sql("SELECT codecs FROM meeting_stats WHERE room_id=? AND started_at=?")
            .params(room.id, room.startedAt)
            .query(String.class)
            .optional()
            .orElse("");
    var all = new TreeSet<String>();
    if (!known.isBlank()) all.addAll(Arrays.asList(known.split(" ")));
    if (codec != null) all.add(codec);
    return String.join(" ", all);
  }

  private void meter(Report report) {
    Counter.builder("cord.client.reports")
        .description("Итоги звонков от браузеров по пути связи")
        .tag("path", report.path())
        .register(registry)
        .increment();
    if (report.rttMs() != null)
      summary("cord.client.rtt", "Оборот (RTT) звонка по итогу браузера, с", report.path())
          .record(report.rttMs() / 1000.0);
    if (report.jitterMs() != null)
      summary("cord.client.jitter", "Джиттер приёма по итогу браузера, с", report.path())
          .record(report.jitterMs() / 1000.0);
    if (report.lossPercent() != null)
      summary("cord.client.loss", "Доля потерянных пакетов по итогу браузера", report.path())
          .record(report.lossPercent() / 100);
    if (report.freezes() > 0)
      Counter.builder("cord.client.freezes")
          .description("Замирания картинки по итогам браузеров")
          .register(registry)
          .increment(report.freezes());
  }

  private DistributionSummary summary(String name, String description, String path) {
    return DistributionSummary.builder(name)
        .description(description)
        .tag("path", path)
        .serviceLevelObjectives(0.01, 0.05, 0.1, 0.2, 0.4, 1)
        .register(registry);
  }

  private static long orZero(Number value) {
    return value == null ? 0 : value.longValue();
  }

  private static int present(Object value) {
    return value == null ? 0 : 1;
  }
}
