package dev.mikki.stream.activity;

import dev.mikki.stream.access.Blocks;
import dev.mikki.stream.config.StreamProperties;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Итоги дня и сроки хранения — сама работа {@link ActivitySchedule}, отдельным бином: тест зовёт её
 * без расписания.
 */
@Component
public class ActivityRollup {
  private final JdbcClient jdbc;
  private final StreamProperties config;
  private final Clock clock;
  private final Audit audit;
  private final MeetingStats stats;
  private final Blocks blocks;

  public ActivityRollup(
      JdbcClient jdbc,
      StreamProperties config,
      Clock clock,
      Audit audit,
      MeetingStats stats,
      Blocks blocks) {
    this.jdbc = jdbc;
    this.config = config;
    this.clock = clock;
    this.audit = audit;
    this.stats = stats;
    this.blocks = blocks;
  }

  @Transactional
  public void run() {
    long now = clock.millis();
    var today = LocalDate.ofInstant(Instant.ofEpochMilli(now), ZoneOffset.UTC);
    day(today.minusDays(1));
    day(today);
    audit.sweep(now);
    jdbc.sql("DELETE FROM meeting_stats WHERE expires_at<=?").param(now).update();
    jdbc.sql("DELETE FROM activity_daily WHERE expires_at<=?").param(now).update();
    blocks.sweep(now);
  }

  private void day(LocalDate day) {
    long from = day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
    long to = day.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
    var totals =
        jdbc.sql(
                "SELECT COUNT(*), COALESCE(SUM(human_seconds),0), COALESCE(MAX(peak_humans),0)"
                    + " FROM meeting_stats WHERE started_at>=? AND started_at<?")
            .params(from, to)
            .query((rs, i) -> new long[] {rs.getLong(1), rs.getLong(2), rs.getLong(3)})
            .single();
    var joins = audit.joins(from, to);
    jdbc.sql("DELETE FROM activity_daily WHERE day_utc=?").param(day).update();
    jdbc.sql(
            "INSERT INTO activity_daily(day_utc,meetings,human_seconds,peak_humans,joins,"
                + "join_failures,unique_devices,expires_at) VALUES(?,?,?,?,?,?,?,?)")
        .params(
            day,
            (int) totals[0],
            totals[1],
            (int) totals[2],
            (int) joins[0],
            (int) joins[1],
            (int) stats.devices(day, day),
            to + Math.min(config.retention().activityDaily().toMillis(), Long.MAX_VALUE / 4))
        .update();
  }
}
