package dev.mikki.stream.activity;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.function.Function;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Отчёт аналитики ({@code GET /api/v1/admin/analytics}, R210): одни и те же величины в двух
 * измерениях (Р-122, {@code docs/architecture/admin-analytics.md} §2.5–2.6).
 *
 * <ul>
 *   <li><b>АКТУАЛ</b> ({@code actual}) — всё, что произошло в периоде, кем бы ни было сделано:
 *       посетитель, пришедший год назад, здесь считается.
 *   <li><b>ЛТВ</b> ({@code ltv}) — когорта: посетители, впервые появившиеся в периоде, и вся их
 *       жизнь от первого дня до сегодня — в периоде и после него.
 * </ul>
 *
 * <p>Встреча не принадлежит одному человеку (а номера встречи в аналитике нет, П8), поэтому то, что
 * берётся из {@code meeting_stats} — встреч проведено, длительность встречи, пик одновременных,
 * виды интеграций, — есть только в АКТУАЛЕ; в ЛТВ эти поля {@code null}, а взамен — то, что когорта
 * сделала сама: встреч создано, входов, часов на связи, минут на вход.
 *
 * <p>Дни — по поясу {@link AnalyticsProperties#zone}, границы периода включительно. Наружу — только
 * числа: ключей посетителей в ответе нет. Сводится в Java из строк «на посетителя»: при нашем
 * масштабе это тысячи строк; вырастет до сотен тысяч — считать итоги заранее.
 */
@Component
public class AnalyticsReport {
  public static final String ACTUAL = "actual";
  public static final String LTV = "ltv";
  static final int[] RETENTION_DAYS = {1, 3, 7, 30};

  /** Самый длинный период отчёта — столько же, сколько живут строки. */
  public static final int MAX_DAYS = 400;

  private final JdbcClient jdbc;
  private final Clock clock;
  private final AnalyticsProperties config;

  public AnalyticsReport(JdbcClient jdbc, Clock clock, AnalyticsProperties config) {
    this.jdbc = jdbc;
    this.clock = clock;
    this.config = config;
  }

  /**
   * Посетители: всего, новых (первый день в периоде), вернувшихся, звонивших, новых звонивших и
   * позвонивших в первый же день. В АКТУАЛЕ «вернувшиеся» — пришедшие до периода; в ЛТВ — те из
   * когорты, кто появился хоть раз после первого дня.
   */
  public record Visitors(
      long total, long fresh, long returning, long callers, long newCallers, long sameDayCallers) {}

  /**
   * Доли. {@code er} — звонивших к посетителям; {@code stickiness} — среднее дневное число активных
   * к различным активным за период (только АКТУАЛ); {@code activeDays} — активных дней на
   * посетителя; {@code errorsPerVisit} — ошибок на открытие; {@code joinFailureRate} — отказов
   * среди попыток входа.
   */
  public record Rates(
      Double er,
      Double stickiness,
      Double activeDays,
      Double errorsPerVisit,
      Double joinFailureRate) {}

  /**
   * Звонки. {@code null} — величины нет в этом измерении (только АКТУАЛ): {@code meetings} (встреч
   * проведено, П7), {@code meetingHours} (человеко-часы по встречам — сверка с {@code
   * presenceHours}), длительность встречи, {@code peakMeetings} (одновременных встреч), {@code
   * largestMeeting} (людей в самой большой встрече).
   */
  public record Calls(
      Long meetings,
      long created,
      long entries,
      long joinFailures,
      double presenceHours,
      Double meetingHours,
      Double hoursPerCaller,
      Double minutesPerEntry,
      Double avgMinutes,
      Double medianMinutes,
      Double longestMinutes,
      Integer peakMeetings,
      Integer largestMeeting) {}

  /** Посетителей, дошедших до шага или дальше: открыл → предвход → вошёл во встречу. */
  public record Funnel(long opened, long prejoined, long joined) {}

  public record Share(String kind, long count) {}

  /**
   * Интеграции: встреч с каждым видом и хоть с одной (только АКТУАЛ); посетителей, заставших
   * интеграцию, и сколько раз застали (пара «встреча × вид»).
   */
  public record Integrations(
      List<Share> meetings, Long meetingsWithAny, long visitors, long encounters) {}

  /** День ряда; {@code meetings} — встреч, начавшихся в этот день (только АКТУАЛ). */
  public record Day(
      String day,
      long visitors,
      long fresh,
      long callers,
      long entries,
      double presenceHours,
      Long meetings) {}

  /**
   * Группа удержания: посетители с точкой отсчёта в {@code since…until}, сколько их и доля
   * вернувшихся в течение 1, 3, 7, 30 дней после точки; {@code null} — у группы ещё не прошло
   * столько полных дней.
   */
  public record Cohort(
      String since, String until, long size, Double d1, Double d3, Double d7, Double d30) {}

  /**
   * Удержание: {@code anchor} — от чего отсчёт ({@code first} — первый день посетителя, ЛТВ; {@code
   * period} — его первый день в периоде, АКТУАЛ); {@code step} — шаг групп ({@code day}, {@code
   * week}, {@code month}); {@code total} — по всем, у кого срок уже прошёл.
   */
  public record Retention(String anchor, String step, Cohort total, List<Cohort> cohorts) {}

  public record Report(
      String mode,
      String from,
      String to,
      String zone,
      String today,
      Visitors visitors,
      Rates rates,
      Calls calls,
      Funnel funnel,
      List<Share> clients,
      List<Share> os,
      Integrations integrations,
      List<Day> days,
      Retention retention) {}

  /** Сводка посетителя: из {@code visitors} и его строк дня (в периоде — АКТУАЛ, все — ЛТВ). */
  private record Visitor(
      LocalDate firstDay,
      LocalDate firstCalledDay,
      String client,
      String os,
      long activeDays,
      long visits,
      long prejoins,
      long creates,
      long joins,
      long failures,
      long presence,
      long integrations,
      long errors) {
    long entries() {
      return creates + joins;
    }
  }

  /** Точка отсчёта удержания и следующий после неё активный день посетителя. */
  private record Anchor(LocalDate anchor, LocalDate next) {}

  /** Отчёт за дни {@code from…to} включительно. */
  public Report report(LocalDate from, LocalDate to, String mode) {
    boolean ltv = LTV.equals(mode);
    var today = LocalDate.ofInstant(Instant.ofEpochMilli(clock.millis()), config.zone());
    var people = ltv ? cohort(from, to) : active(from, to);
    var anchors = ltv ? cohortAnchors(from, to) : periodAnchors(from, to);

    long total = people.size();
    long fresh = count(people, v -> within(v.firstDay(), from, to));
    long returning =
        ltv
            ? count(anchors, a -> a.next() != null)
            : count(people, v -> v.firstDay().isBefore(from));
    long callers = count(people, v -> v.entries() > 0);
    long newCallers = count(people, v -> within(v.firstCalledDay(), from, to));
    long sameDay =
        count(
            people, v -> within(v.firstDay(), from, to) && v.firstDay().equals(v.firstCalledDay()));

    long activeDays = sum(people, Visitor::activeDays);
    long visits = sum(people, Visitor::visits);
    long created = sum(people, Visitor::creates);
    long entries = sum(people, Visitor::entries);
    long failures = sum(people, Visitor::failures);
    long presence = sum(people, Visitor::presence);
    long errors = sum(people, Visitor::errors);
    long encounters = sum(people, Visitor::integrations);

    var meetings = ltv ? null : meetings(from, to);
    var days = days(ltv, from, ltv ? max(to, today) : to, from, to, meetings);
    Double stickiness = null;
    if (!ltv && total > 0) {
      // Дни периода, которые уже наступили: будущие нулями долю не размывают.
      long span = Math.max(1, ChronoUnit.DAYS.between(from, to.isAfter(today) ? today : to) + 1);
      stickiness = days.stream().mapToLong(Day::visitors).sum() / (double) span / total;
    }
    var rates =
        new Rates(
            ratio(callers, total),
            stickiness,
            ratio(activeDays, total),
            ratio(errors, visits),
            ratio(failures, entries + failures));
    var calls =
        new Calls(
            meetings == null ? null : (long) meetings.count(),
            created,
            entries,
            failures,
            presence / 3600.0,
            meetings == null ? null : meetings.humanSeconds() / 3600.0,
            callers > 0 ? presence / 3600.0 / callers : null,
            entries > 0 ? presence / 60.0 / entries : null,
            meetings == null ? null : meetings.avgMinutes(),
            meetings == null ? null : meetings.medianMinutes(),
            meetings == null ? null : meetings.longestMinutes(),
            meetings == null ? null : meetings.peak(),
            meetings == null ? null : meetings.largest());
    // Шаги воронки вложены: вошедший дошёл и до предвхода, и до открытия, даже если вошёл по
    // прямой ссылке из другого приложения.
    var funnel =
        new Funnel(total, count(people, v -> v.prejoins() > 0 || v.entries() > 0), callers);
    var integrations =
        new Integrations(
            meetings == null ? List.of() : meetings.kinds(),
            meetings == null ? null : (long) meetings.withIntegrations(),
            count(people, v -> v.integrations() > 0),
            encounters);
    return new Report(
        ltv ? LTV : ACTUAL,
        from.toString(),
        to.toString(),
        config.zone().getId(),
        today.toString(),
        new Visitors(total, fresh, returning, callers, newCallers, sameDay),
        rates,
        calls,
        funnel,
        ltv ? shares(people, Visitor::client) : breakdown("client", from, to),
        ltv ? shares(people, Visitor::os) : breakdown("os", from, to),
        integrations,
        days,
        retention(anchors, from, to, today, ltv));
  }

  // ── Посетители ───────────────────────────────────────────────────────────────────────────────

  private static final String SUMS =
      "COUNT(d.local_day), COALESCE(SUM(d.visits),0), COALESCE(SUM(d.prejoins),0),"
          + " COALESCE(SUM(d.creates),0), COALESCE(SUM(d.joins),0), COALESCE(SUM(d.join_failures),0),"
          + " COALESCE(SUM(d.presence_seconds),0), COALESCE(SUM(d.integrations),0),"
          + " COALESCE(SUM(d.errors),0)";

  private static final String GROUP =
      " GROUP BY v.visitor_key, v.first_day, v.first_called_day, v.first_client, v.first_os";

  /** АКТУАЛ: все, у кого есть строка дня в периоде; суммы — только за период. */
  private List<Visitor> active(LocalDate from, LocalDate to) {
    return jdbc.sql(
            "SELECT v.first_day, v.first_called_day, v.first_client, v.first_os, "
                + SUMS
                + " FROM visitor_days d JOIN visitors v ON v.visitor_key = d.visitor_key"
                + " WHERE d.local_day >= ? AND d.local_day <= ?"
                + GROUP)
        .params(from, to)
        .query(AnalyticsReport::visitor)
        .list();
  }

  /** ЛТВ: когорта с первым днём в периоде — вся её жизнь до сегодня. */
  private List<Visitor> cohort(LocalDate from, LocalDate to) {
    return jdbc.sql(
            "SELECT v.first_day, v.first_called_day, v.first_client, v.first_os, "
                + SUMS
                + " FROM visitors v LEFT JOIN visitor_days d ON d.visitor_key = v.visitor_key"
                + " WHERE v.first_day >= ? AND v.first_day <= ?"
                + GROUP)
        .params(from, to)
        .query(AnalyticsReport::visitor)
        .list();
  }

  private static Visitor visitor(ResultSet rs, int n) throws SQLException {
    return new Visitor(
        rs.getObject(1, LocalDate.class),
        rs.getObject(2, LocalDate.class),
        rs.getString(3),
        rs.getString(4),
        rs.getLong(5),
        rs.getLong(6),
        rs.getLong(7),
        rs.getLong(8),
        rs.getLong(9),
        rs.getLong(10),
        rs.getLong(11),
        rs.getLong(12),
        rs.getLong(13));
  }

  private static List<Share> shares(List<Visitor> people, Function<Visitor, String> by) {
    var counts = new TreeMap<String, Long>();
    for (var v : people)
      counts.merge(Objects.requireNonNullElse(by.apply(v), "other"), 1L, Long::sum);
    return counts.entrySet().stream().map(e -> new Share(e.getKey(), e.getValue())).toList();
  }

  /** АКТУАЛ: посетителей по клиенту или ОС строк дня; один человек с двух клиентов — в обоих. */
  private List<Share> breakdown(String column, LocalDate from, LocalDate to) {
    return jdbc.sql(
            "SELECT "
                + column
                + ", COUNT(DISTINCT visitor_key) FROM visitor_days WHERE local_day >= ? AND"
                + " local_day <= ? GROUP BY "
                + column
                + " ORDER BY 1")
        .params(from, to)
        .query((rs, n) -> new Share(rs.getString(1), rs.getLong(2)))
        .list();
  }

  // ── Дни ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * Ряд по дням {@code start…end}, пустые дни — нулями. АКТУАЛ — вся активность дня; ЛТВ — только
   * когорты {@code cohortFrom…cohortTo}, от первого дня периода до сегодня.
   */
  private List<Day> days(
      boolean ltv,
      LocalDate start,
      LocalDate end,
      LocalDate cohortFrom,
      LocalDate cohortTo,
      Meetings meetings) {
    var sql =
        "SELECT d.local_day, COUNT(*), SUM(CASE WHEN v.first_day = d.local_day THEN 1 ELSE 0 END),"
            + " SUM(CASE WHEN d.creates + d.joins > 0 THEN 1 ELSE 0 END), SUM(d.creates + d.joins),"
            + " SUM(d.presence_seconds) FROM visitor_days d JOIN visitors v ON v.visitor_key ="
            + " d.visitor_key WHERE d.local_day >= ? AND d.local_day <= ?"
            + (ltv ? " AND v.first_day >= ? AND v.first_day <= ?" : "")
            + " GROUP BY d.local_day";
    var params = new ArrayList<Object>(List.of(start, end));
    if (ltv) params.addAll(List.of(cohortFrom, cohortTo));
    var rows = new HashMap<LocalDate, long[]>();
    jdbc.sql(sql)
        .params(params)
        .query(
            (rs, n) ->
                rows.put(
                    rs.getObject(1, LocalDate.class),
                    new long[] {
                      rs.getLong(2), rs.getLong(3), rs.getLong(4), rs.getLong(5), rs.getLong(6)
                    }))
        .list();
    var out = new ArrayList<Day>();
    for (var day = start; !day.isAfter(end); day = day.plusDays(1)) {
      var row = rows.getOrDefault(day, new long[5]);
      out.add(
          new Day(
              day.toString(),
              row[0],
              row[1],
              row[2],
              row[3],
              row[4] / 3600.0,
              meetings == null ? null : (long) meetings.perDay().getOrDefault(day, 0)));
    }
    return out;
  }

  // ── Удержание ────────────────────────────────────────────────────────────────────────────────

  /** ЛТВ: точка — первый день посетителя из когорты периода. */
  private List<Anchor> cohortAnchors(LocalDate from, LocalDate to) {
    return jdbc.sql(
            "SELECT v.first_day, MIN(n.local_day) FROM visitors v LEFT JOIN visitor_days n ON"
                + " n.visitor_key = v.visitor_key AND n.local_day > v.first_day WHERE v.first_day >="
                + " ? AND v.first_day <= ? GROUP BY v.visitor_key, v.first_day")
        .params(from, to)
        .query(
            (rs, n) ->
                new Anchor(rs.getObject(1, LocalDate.class), rs.getObject(2, LocalDate.class)))
        .list();
  }

  /** АКТУАЛ: точка — первый день посетителя в периоде, кем бы он ни был. */
  private List<Anchor> periodAnchors(LocalDate from, LocalDate to) {
    return jdbc.sql(
            "SELECT a.anchor, MIN(n.local_day) FROM (SELECT visitor_key, MIN(local_day) AS anchor"
                + " FROM visitor_days WHERE local_day >= ? AND local_day <= ? GROUP BY visitor_key) a"
                + " LEFT JOIN visitor_days n ON n.visitor_key = a.visitor_key AND n.local_day >"
                + " a.anchor GROUP BY a.visitor_key, a.anchor")
        .params(from, to)
        .query(
            (rs, n) ->
                new Anchor(rs.getObject(1, LocalDate.class), rs.getObject(2, LocalDate.class)))
        .list();
  }

  /**
   * Группы по точке отсчёта: по дням, если период до двух недель; по неделям (с понедельника) — до
   * 120 дней; дальше — по месяцам. Доля D_N — вернувшихся в течение N дней после точки (нестрогое,
   * Р-123: D1 ≤ D3 ≤ D7 ≤ D30). Считается только по тем, у кого N полных дней уже прошло:
   * сегодняшний день ещё не кончился.
   */
  Retention retention(
      List<Anchor> anchors, LocalDate from, LocalDate to, LocalDate today, boolean ltv) {
    long span = ChronoUnit.DAYS.between(from, to) + 1;
    String step = span <= 14 ? "day" : span <= 120 ? "week" : "month";
    var groups = new TreeMap<LocalDate, List<Anchor>>();
    for (var a : anchors) {
      var start =
          switch (step) {
            case "day" -> a.anchor();
            case "week" -> a.anchor().with(DayOfWeek.MONDAY);
            default -> a.anchor().withDayOfMonth(1);
          };
      groups.computeIfAbsent(start, d -> new ArrayList<>()).add(a);
    }
    var lastComplete = today.minusDays(1);
    var cohorts = new ArrayList<Cohort>();
    for (var e : groups.entrySet()) {
      var start = e.getKey();
      var end =
          switch (step) {
            case "day" -> start;
            case "week" -> start.plusDays(6);
            default -> start.plusMonths(1).minusDays(1);
          };
      // Граница группы — не дальше периода: неделя, начатая до него, считается с его начала.
      var since = max(start, from);
      var until = end.isAfter(to) ? to : end;
      var shares = new Double[RETENTION_DAYS.length];
      for (int i = 0; i < RETENTION_DAYS.length; i++) {
        int n = RETENTION_DAYS[i];
        if (until.plusDays(n).isAfter(lastComplete)) continue;
        shares[i] = returned(e.getValue(), n);
      }
      cohorts.add(cohort(since, until, e.getValue().size(), shares));
    }
    var totals = new Double[RETENTION_DAYS.length];
    for (int i = 0; i < RETENTION_DAYS.length; i++) {
      int n = RETENTION_DAYS[i];
      var ripe =
          anchors.stream().filter(a -> !a.anchor().plusDays(n).isAfter(lastComplete)).toList();
      totals[i] = ripe.isEmpty() ? null : returned(ripe, n);
    }
    return new Retention(
        ltv ? "first" : "period", step, cohort(from, to, anchors.size(), totals), cohorts);
  }

  private static Double returned(List<Anchor> members, int days) {
    long back =
        members.stream()
            .filter(a -> a.next() != null && !a.next().isAfter(a.anchor().plusDays(days)))
            .count();
    return back / (double) members.size();
  }

  private static Cohort cohort(LocalDate since, LocalDate until, long size, Double[] shares) {
    return new Cohort(
        since.toString(), until.toString(), size, shares[0], shares[1], shares[2], shares[3]);
  }

  // ── Встречи (только АКТУАЛ) ──────────────────────────────────────────────────────────────────

  private record Meetings(
      int count,
      long humanSeconds,
      Double avgMinutes,
      Double medianMinutes,
      Double longestMinutes,
      int peak,
      int largest,
      int withIntegrations,
      List<Share> kinds,
      Map<LocalDate, Integer> perDay) {}

  /**
   * Встречи, начавшиеся в периоде (П7: от «двое людей на связи»), и пик одновременных — по всем,
   * что шли в периоде, включая начатые раньше. Идущая встреча длится до «сейчас».
   */
  private Meetings meetings(LocalDate from, LocalDate to) {
    long start = from.atStartOfDay(config.zone()).toInstant().toEpochMilli();
    long end = to.plusDays(1).atStartOfDay(config.zone()).toInstant().toEpochMilli();
    long now = clock.millis();
    record Row(long startedAt, long endedAt, int peak, long humanSeconds, String kinds) {}
    var rows =
        jdbc.sql(
                "SELECT started_at, ended_at, peak_humans, human_seconds, integrations, humans_now,"
                    + " humans_since FROM meeting_stats WHERE started_at < ? AND (ended_at IS NULL"
                    + " OR ended_at > ?) ORDER BY started_at")
            .params(end, start)
            .query(
                (rs, i) -> {
                  long seconds = rs.getLong(4);
                  Long ended = rs.getObject(2, Long.class);
                  if (ended == null)
                    seconds += (long) rs.getInt(6) * Math.max(0, now - rs.getLong(7)) / 1000;
                  return new Row(
                      rs.getLong(1),
                      ended == null ? Math.max(now, rs.getLong(1)) : ended,
                      rs.getInt(3),
                      seconds,
                      rs.getString(5));
                })
            .list();
    var durations = new ArrayList<Long>();
    var kinds = new TreeMap<String, Long>();
    var perDay = new HashMap<LocalDate, Integer>();
    var edges = new ArrayList<long[]>();
    long humanSeconds = 0;
    int largest = 0, withIntegrations = 0;
    for (var row : rows) {
      edges.add(new long[] {Math.max(row.startedAt(), start), 1});
      edges.add(new long[] {Math.min(row.endedAt(), end), -1});
      if (row.startedAt() < start) continue;
      durations.add(Math.max(0, row.endedAt() - row.startedAt()) / 1000);
      humanSeconds += row.humanSeconds();
      largest = Math.max(largest, row.peak());
      perDay.merge(
          LocalDate.ofInstant(Instant.ofEpochMilli(row.startedAt()), config.zone()),
          1,
          Integer::sum);
      if (row.kinds() != null && !row.kinds().isBlank()) {
        withIntegrations++;
        for (var kind : row.kinds().trim().split("\\s+")) kinds.merge(kind, 1L, Long::sum);
      }
    }
    // Пик одновременных: развёртка начал и концов; конец в ту же миллисекунду, что чужое начало, —
    // раньше него.
    edges.sort((a, b) -> a[0] != b[0] ? Long.compare(a[0], b[0]) : Long.compare(a[1], b[1]));
    int open = 0, peak = 0;
    for (var edge : edges) {
      open += (int) edge[1];
      peak = Math.max(peak, open);
    }
    Collections.sort(durations);
    int size = durations.size();
    Double avg =
        size == 0 ? null : durations.stream().mapToLong(Long::longValue).sum() / 60.0 / size;
    Double median =
        size == 0
            ? null
            : (size % 2 == 1
                    ? durations.get(size / 2)
                    : (durations.get(size / 2 - 1) + durations.get(size / 2)) / 2.0)
                / 60.0;
    return new Meetings(
        size,
        humanSeconds,
        avg,
        median,
        size == 0 ? null : durations.getLast() / 60.0,
        peak,
        largest,
        withIntegrations,
        kinds.entrySet().stream().map(e -> new Share(e.getKey(), e.getValue())).toList(),
        perDay);
  }

  // ── Мелочи ───────────────────────────────────────────────────────────────────────────────────

  private static <T> long count(List<T> items, java.util.function.Predicate<T> test) {
    return items.stream().filter(test).count();
  }

  private static long sum(List<Visitor> people, java.util.function.ToLongFunction<Visitor> by) {
    return people.stream().mapToLong(by).sum();
  }

  private static Double ratio(long part, long whole) {
    return whole > 0 ? part / (double) whole : null;
  }

  private static boolean within(LocalDate day, LocalDate from, LocalDate to) {
    return day != null && !day.isBefore(from) && !day.isAfter(to);
  }

  private static LocalDate max(LocalDate a, LocalDate b) {
    return a.isAfter(b) ? a : b;
  }
}
