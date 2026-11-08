package dev.mikki.stream.activity;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.*;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Отчёт аналитики ({@code GET /api/v1/admin/analytics}, R210): одни и те же величины в двух
 * измерениях — ЛТВ и АКТУАЛ (Р-122, {@code docs/architecture/admin-analytics.md} §2.5–2.6).
 *
 * <p>АКТУАЛ — всё, что произошло в периоде, кем бы ни было сделано. ЛТВ — когорта посетителей с
 * первым днём в периоде и вся её жизнь до сегодня. Удержание — всегда по когорте первого дня:
 * «вернулся в течение N дней» (нестрогое, Р-123).
 *
 * <p>Дни — по UTC, как строки {@code visitor_days}; наружу — только числа, ключей посетителей в
 * ответе нет. Сводится в Java из строк «на посетителя» и «на день»: при нашем масштабе это
 * сотни-тысячи строк; вырастет до миллионов — считать итоги в {@link ActivityRollup}.
 */
@Component
public class AnalyticsReport {
  public static final String ACTUAL = "actual";
  public static final String LTV = "ltv";
  static final int[] RETENTION_DAYS = {1, 3, 7, 30};

  private final JdbcClient jdbc;
  private final Clock clock;

  public AnalyticsReport(JdbcClient jdbc, Clock clock) {
    this.jdbc = jdbc;
    this.clock = clock;
  }

  public record Visitors(long total, long fresh, long returning, long callers, long newCallers) {}

  /** Доли: ER — звонивших к посетителям; stickiness — средних дневных активных к различным. */
  public record Rates(Double er, Double stickiness, Double errorsPerVisit) {}

  public record Calls(
      long meetings,
      long entries,
      double presenceHours,
      double meetingHours,
      Double hoursPerCaller,
      Double avgMinutes,
      Double medianMinutes,
      Double longestMinutes,
      int peakMeetings,
      int peakHumans,
      long joinFailures) {}

  /** Посетителей на шаге воронки. */
  public record Funnel(long opened, long prejoined, long joined) {}

  public record Share(String kind, long count) {}

  public record Day(
      String day,
      long visitors,
      long fresh,
      long callers,
      double presenceHours,
      long visits,
      long entries) {}

  /**
   * Когорта по первому дню: размер и доля вернувшихся в течение 1, 3, 7, 30 дней; null — ещё рано.
   */
  public record Cohort(
      String since, String until, long size, Double d1, Double d3, Double d7, Double d30) {}

  public record Report(
      String mode,
      long from,
      long to,
      Visitors visitors,
      Rates rates,
      Calls calls,
      Funnel funnel,
      List<Share> clients,
      List<Share> os,
      List<Share> integrations,
      List<Day> days,
      List<Cohort> retention) {}

  /** Строка «на посетителя» из {@code visitor_days}, сведённая SQL. */
  private record Visitor(
      LocalDate firstDay,
      Long firstCalledAt,
      String client,
      String os,
      long visits,
      long prejoins,
      long entries,
      long failures,
      long presence,
      long integrations,
      long errors,
      LocalDate firstReturn) {}

  public Report report(long from, long to, String mode) {
    boolean ltv = LTV.equals(mode);
    var fromDay = day(from);
    var toDay = day(to - 1).plusDays(1);
    long now = clock.millis();
    var today = day(now);

    var visitors = ltv ? cohort(fromDay, toDay) : active(fromDay, toDay);
    var cohort = ltv ? visitors : cohort(fromDay, toDay);

    long total = visitors.size();
    long fresh =
        visitors.stream()
            .filter(v -> !v.firstDay().isBefore(fromDay) && v.firstDay().isBefore(toDay))
            .count();
    long callers = visitors.stream().filter(v -> v.entries() > 0).count();
    long newCallers =
        visitors.stream()
            .filter(
                v ->
                    v.firstCalledAt() != null
                        && v.firstCalledAt() >= from
                        && v.firstCalledAt() < to)
            .count();
    if (ltv) {
      callers = visitors.stream().filter(v -> v.firstCalledAt() != null || v.entries() > 0).count();
      newCallers = callers;
    }
    long visits = visitors.stream().mapToLong(Visitor::visits).sum();
    long entries = visitors.stream().mapToLong(Visitor::entries).sum();
    long failures = visitors.stream().mapToLong(Visitor::failures).sum();
    long presence = visitors.stream().mapToLong(Visitor::presence).sum();
    long errors = visitors.stream().mapToLong(Visitor::errors).sum();
    long integrationOpens = visitors.stream().mapToLong(Visitor::integrations).sum();

    var days = ltv ? cohortDays(fromDay, toDay) : days(fromDay, toDay);
    Double stickiness = null;
    if (!ltv && total > 0 && !days.isEmpty()) {
      long span = Math.max(1, ChronoUnit.DAYS.between(fromDay, toDay));
      double dailyAverage = days.stream().mapToLong(Day::visitors).sum() / (double) span;
      stickiness = dailyAverage / total;
    }
    var rates =
        new Rates(
            total > 0 ? callers / (double) total : null,
            stickiness,
            visits > 0 ? errors / (double) visits : null);

    var meetings = ltv ? Meetings.NONE : meetings(from, to, now);
    var calls =
        new Calls(
            meetings.count(),
            entries,
            presence / 3600.0,
            meetings.humanSeconds() / 3600.0,
            callers > 0 ? presence / 3600.0 / callers : null,
            meetings.avgMinutes(),
            meetings.medianMinutes(),
            meetings.longestMinutes(),
            meetings.peakMeetings(),
            meetings.peakHumans(),
            failures);

    var funnel =
        new Funnel(
            visitors.stream().filter(v -> v.visits() > 0).count(),
            visitors.stream().filter(v -> v.prejoins() > 0).count(),
            callers);

    List<Share> clients;
    List<Share> systems;
    if (ltv) {
      clients = shares(visitors, Visitor::client);
      systems = shares(visitors, Visitor::os);
    } else {
      clients = breakdown("client", fromDay, toDay);
      systems = breakdown("os", fromDay, toDay);
    }
    var integrations = new ArrayList<Share>();
    for (var e : meetings.integrations().entrySet())
      integrations.add(new Share(e.getKey(), e.getValue()));
    integrations.add(new Share("opened", integrationOpens));

    return new Report(
        ltv ? LTV : ACTUAL,
        from,
        to,
        new Visitors(total, fresh, ltv ? 0 : total - fresh, callers, newCallers),
        rates,
        calls,
        funnel,
        clients,
        systems,
        integrations,
        days,
        retention(cohort, fromDay, toDay, today));
  }

  // ── Посетители ───────────────────────────────────────────────────────────────────────────────

  private static final String VISITOR_SELECT =
      "SELECT v.first_day, v.first_called_at, v.first_client, v.first_os, SUM(d.visits),"
          + " SUM(d.prejoins), SUM(d.creates+d.joins), SUM(d.join_failures), SUM(d.presence_seconds),"
          + " SUM(d.integrations), SUM(d.errors), MIN(CASE WHEN d.day_utc > v.first_day THEN d.day_utc"
          + " END) FROM visitors v JOIN visitor_days d ON d.visitor_key = v.visitor_key";

  /** АКТУАЛ: все, у кого есть строка дня в периоде; суммы — только за период. */
  private List<Visitor> active(LocalDate from, LocalDate to) {
    return jdbc.sql(
            VISITOR_SELECT
                + " WHERE d.day_utc >= ? AND d.day_utc < ? GROUP BY v.visitor_key, v.first_day,"
                + " v.first_called_at, v.first_client, v.first_os")
        .params(from, to)
        .query(this::visitor)
        .list();
  }

  /** ЛТВ: когорта с первым днём в периоде — вся её жизнь; без суточных отпечатков адресов. */
  private List<Visitor> cohort(LocalDate from, LocalDate to) {
    return jdbc.sql(
            VISITOR_SELECT
                + " WHERE v.first_day >= ? AND v.first_day < ? AND v.anonymous = FALSE GROUP BY"
                + " v.visitor_key, v.first_day, v.first_called_at, v.first_client, v.first_os")
        .params(from, to)
        .query(this::visitor)
        .list();
  }

  private Visitor visitor(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
    var firstCalled = rs.getObject(2, Long.class);
    var firstReturn = rs.getObject(12, java.sql.Date.class);
    return new Visitor(
        rs.getObject(1, java.sql.Date.class).toLocalDate(),
        firstCalled,
        rs.getString(3),
        rs.getString(4),
        rs.getLong(5),
        rs.getLong(6),
        rs.getLong(7),
        rs.getLong(8),
        rs.getLong(9),
        rs.getLong(10),
        rs.getLong(11),
        firstReturn == null ? null : firstReturn.toLocalDate());
  }

  private static List<Share> shares(
      List<Visitor> visitors, java.util.function.Function<Visitor, String> by) {
    var counts = new TreeMap<String, Long>();
    for (var v : visitors) counts.merge(by.apply(v) == null ? "other" : by.apply(v), 1L, Long::sum);
    return counts.entrySet().stream().map(e -> new Share(e.getKey(), e.getValue())).toList();
  }

  /** АКТУАЛ: посетителей по клиенту или ОС строк дня; один человек с двух клиентов — в обоих. */
  private List<Share> breakdown(String column, LocalDate from, LocalDate to) {
    return jdbc.sql(
            "SELECT COALESCE("
                + column
                + ",'other'), COUNT(DISTINCT visitor_key) FROM visitor_days WHERE day_utc >= ? AND"
                + " day_utc < ? GROUP BY "
                + column
                + " ORDER BY 1")
        .params(from, to)
        .query((rs, n) -> new Share(rs.getString(1), rs.getLong(2)))
        .list();
  }

  // ── Дни ──────────────────────────────────────────────────────────────────────────────────────

  private static final String DAY_SELECT =
      "SELECT d.day_utc, COUNT(*), SUM(CASE WHEN v.first_day = d.day_utc THEN 1 ELSE 0 END),"
          + " SUM(CASE WHEN d.creates + d.joins > 0 THEN 1 ELSE 0 END), SUM(d.presence_seconds),"
          + " SUM(d.visits), SUM(d.creates + d.joins) FROM visitor_days d JOIN visitors v ON"
          + " v.visitor_key = d.visitor_key";

  private List<Day> days(LocalDate from, LocalDate to) {
    return jdbc.sql(
            DAY_SELECT + " WHERE d.day_utc >= ? AND d.day_utc < ? GROUP BY d.day_utc ORDER BY 1")
        .params(from, to)
        .query(this::day)
        .list();
  }

  /** ЛТВ: активность когорты по дням — от первого дня периода до сегодня. */
  private List<Day> cohortDays(LocalDate from, LocalDate to) {
    return jdbc.sql(
            DAY_SELECT
                + " WHERE v.first_day >= ? AND v.first_day < ? AND v.anonymous = FALSE GROUP BY"
                + " d.day_utc ORDER BY 1")
        .params(from, to)
        .query(this::day)
        .list();
  }

  private Day day(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
    return new Day(
        rs.getObject(1, java.sql.Date.class).toLocalDate().toString(),
        rs.getLong(2),
        rs.getLong(3),
        rs.getLong(4),
        rs.getLong(5) / 3600.0,
        rs.getLong(6),
        rs.getLong(7));
  }

  // ── Удержание ────────────────────────────────────────────────────────────────────────────────

  /**
   * Когорты первого дня: по дням, если период до двух недель, иначе по неделям (понедельник —
   * воскресенье). Доля — вернувшихся в течение N дней; когорта, у которой N дней ещё не прошло, —
   * {@code null}.
   */
  List<Cohort> retention(List<Visitor> cohort, LocalDate from, LocalDate to, LocalDate today) {
    boolean weekly = ChronoUnit.DAYS.between(from, to) > 14;
    var groups = new TreeMap<LocalDate, List<Visitor>>();
    for (var v : cohort) {
      var start = weekly ? v.firstDay().with(java.time.DayOfWeek.MONDAY) : v.firstDay();
      groups.computeIfAbsent(start, d -> new ArrayList<>()).add(v);
    }
    var out = new ArrayList<Cohort>();
    for (var e : groups.entrySet()) {
      var start = e.getKey();
      var end = weekly ? start.plusDays(6) : start;
      var members = e.getValue();
      var shares = new Double[RETENTION_DAYS.length];
      for (int i = 0; i < RETENTION_DAYS.length; i++) {
        int n = RETENTION_DAYS[i];
        if (end.plusDays(n).isAfter(today)) continue;
        long returned =
            members.stream()
                .filter(
                    v ->
                        v.firstReturn() != null
                            && !v.firstReturn().isAfter(v.firstDay().plusDays(n)))
                .count();
        shares[i] = returned / (double) members.size();
      }
      out.add(
          new Cohort(
              start.toString(),
              end.toString(),
              members.size(),
              shares[0],
              shares[1],
              shares[2],
              shares[3]));
    }
    return out;
  }

  // ── Встречи (АКТУАЛ) ─────────────────────────────────────────────────────────────────────────

  private record Meetings(
      long count,
      long humanSeconds,
      Double avgMinutes,
      Double medianMinutes,
      Double longestMinutes,
      int peakMeetings,
      int peakHumans,
      Map<String, Long> integrations) {
    static final Meetings NONE = new Meetings(0, 0, null, null, null, 0, 0, Map.of());
  }

  private Meetings meetings(long from, long to, long now) {
    record Row(long startedAt, Long endedAt, int peak, long humanSeconds, String kinds) {}
    var rows =
        jdbc.sql(
                "SELECT started_at, ended_at, peak_humans, human_seconds, integrations, humans_now,"
                    + " humans_since FROM meeting_stats WHERE started_at>=? AND started_at<? ORDER BY"
                    + " started_at")
            .params(from, to)
            .query(
                (rs, i) -> {
                  long seconds = rs.getLong(4);
                  if (rs.getObject(2) == null)
                    seconds += (long) rs.getInt(6) * Math.max(0, now - rs.getLong(7)) / 1000;
                  return new Row(
                      rs.getLong(1),
                      rs.getObject(2, Long.class),
                      rs.getInt(3),
                      seconds,
                      rs.getString(5));
                })
            .list();
    if (rows.isEmpty()) return Meetings.NONE;
    var durations = new ArrayList<Long>();
    var integrations = new TreeMap<String, Long>();
    var edges = new ArrayList<long[]>();
    long humanSeconds = 0;
    int peakHumans = 0;
    for (var row : rows) {
      long end = row.endedAt() == null ? now : row.endedAt();
      durations.add(Math.max(0, (end - row.startedAt()) / 1000));
      humanSeconds += row.humanSeconds();
      peakHumans = Math.max(peakHumans, row.peak());
      edges.add(new long[] {row.startedAt(), 1});
      edges.add(new long[] {end, -1});
      if (row.kinds() != null && !row.kinds().isBlank())
        for (var kind : row.kinds().split(" ")) integrations.merge(kind, 1L, Long::sum);
    }
    // Пик одновременных встреч: развёртка начал и концов; конец раньше начала в одну миллисекунду.
    edges.sort((a, b) -> a[0] != b[0] ? Long.compare(a[0], b[0]) : Long.compare(a[1], b[1]));
    int open = 0, peakMeetings = 0;
    for (var edge : edges) {
      open += (int) edge[1];
      peakMeetings = Math.max(peakMeetings, open);
    }
    Collections.sort(durations);
    double avg = durations.stream().mapToLong(Long::longValue).average().orElse(0) / 60.0;
    return new Meetings(
        rows.size(),
        humanSeconds,
        avg,
        durations.get(durations.size() / 2) / 60.0,
        durations.getLast() / 60.0,
        peakMeetings,
        peakHumans,
        integrations);
  }

  private static LocalDate day(long millis) {
    return LocalDate.ofInstant(Instant.ofEpochMilli(millis), ZoneOffset.UTC);
  }
}
