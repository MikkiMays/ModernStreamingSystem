package dev.mikki.stream.activity;

import dev.mikki.stream.room.RoomRepository;
import dev.mikki.stream.room.RoomState;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.*;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Что показывает страница «Активность» ({@code docs/observability.md} §12): встречи сейчас — из
 * живых комнат, встречи за период — из {@code meeting_stats}. Обе части работают без профиля {@code
 * monitoring}: это своя статистика ядра, а не графики VictoriaMetrics.
 *
 * <p>Ни названия встречи, ни имён в «Сейчас» нет: владельцу сервера, чтобы закрыть встречу или
 * заблокировать её создателя, хватает кода, длительности и числа людей. Имена — в журнале аудита,
 * на его срок.
 */
@Component
public class ActivityReport {
  private final RoomRepository rooms;
  private final JdbcClient jdbc;
  private final MeetingStats stats;
  private final Audit audit;
  private final Clock clock;

  public ActivityReport(
      RoomRepository rooms, JdbcClient jdbc, MeetingStats stats, Audit audit, Clock clock) {
    this.rooms = rooms;
    this.jdbc = jdbc;
    this.stats = stats;
    this.audit = audit;
    this.clock = clock;
  }

  public record LiveRoom(
      String id,
      String code,
      long createdAt,
      Long startedAt,
      Long endsAt,
      int humans,
      int connected,
      int waiting,
      int bots,
      int screens,
      List<String> integrations,
      boolean approvalRequired,
      boolean createdHere) {}

  public record Now(
      long serverTime,
      int live,
      int waiting,
      int humans,
      int connected,
      int bots,
      int screens,
      List<LiveRoom> rooms) {}

  public Now now() {
    var list = new ArrayList<LiveRoom>();
    int live = 0, waiting = 0, humans = 0, connected = 0, bots = 0, screens = 0;
    for (var room : rooms.all()) {
      if (room.closedAt != null) continue;
      int h = 0, c = 0, w = 0, b = 0, s = 0;
      for (var m : room.members.values()) {
        if (!m.occupiesSeat()) continue;
        if (!m.human()) b++;
        else if (m.status == RoomState.Status.WAITING) w++;
        else {
          h++;
          if (m.status == RoomState.Status.CONNECTED) c++;
          if (m.screen && m.screenStarted) s++;
        }
      }
      if (room.startedAt != null) live++;
      else waiting++;
      humans += h;
      connected += c;
      bots += b;
      screens += s;
      list.add(
          new LiveRoom(
              room.id,
              room.code,
              room.createdAt,
              room.startedAt,
              room.endsAt,
              h,
              c,
              w,
              b,
              s,
              Activity.integrations(room),
              room.approvalRequired,
              room.createdFrom != null));
    }
    list.sort(
        Comparator.comparing((LiveRoom r) -> r.startedAt() == null)
            .thenComparing(LiveRoom::createdAt));
    return new Now(clock.millis(), live, waiting, humans, connected, bots, screens, list);
  }

  public record Day(String day, int meetings, long humanSeconds, int peakHumans) {}

  public record Bucket(long upToSeconds, int meetings) {}

  public record Summary(
      long from,
      long to,
      int meetings,
      long humanSeconds,
      long medianSeconds,
      long longestSeconds,
      int peakHumans,
      long uniqueDevices,
      long joins,
      long joinFailures,
      List<Day> days,
      List<Bucket> durations,
      Map<String, Integer> integrations,
      Map<String, Integer> endReasons) {}

  /** Качество связи за день: итогов, средний оборот и потери. */
  public record QualityDay(String day, int reports, Integer rttMs, Double lossPercent) {}

  /** Встреча в «Качестве»: код (пока комната жива), начало и её средние. */
  public record QualityMeeting(
      String code,
      long startedAt,
      int reports,
      Integer rttMs,
      Integer rttMaxMs,
      Double lossPercent,
      Integer jitterMs,
      int freezes,
      boolean relay) {}

  /**
   * Качество связи за период — из итогов браузеров ({@link ClientQuality}, V12). Средние — по
   * итогам, где величина была; доли — {@code null}, если итогов нет.
   */
  public record Quality(
      long from,
      long to,
      int meetings,
      int reports,
      long seconds,
      Integer rttMs,
      Integer rttMaxMs,
      Double lossPercent,
      Integer jitterMs,
      Integer bitrateKbps,
      int freezes,
      Double freezesPerHour,
      Double lossyShare,
      Double relayShare,
      Map<String, Integer> codecs,
      List<QualityDay> days,
      List<QualityMeeting> recent) {}

  /** Сколько встреч показывает «Качество» поимённо — последние с итогами. */
  static final int RECENT = 20;

  /** Встречи, начавшиеся в промежутке, — только те, о которых браузеры прислали итоги. */
  public Quality quality(long from, long to, int offsetMinutes) {
    record Row(
        long startedAt,
        String code,
        int reports,
        long seconds,
        long lossy,
        long rttSum,
        int rttReports,
        int rttMax,
        long lossSum,
        int lossReports,
        long jitterSum,
        int jitterReports,
        long bitrateSum,
        int bitrateReports,
        int freezes,
        int relay,
        String codecs) {}
    var list =
        jdbc.sql(
                "SELECT s.started_at, r.room_code, s.quality_reports, s.quality_seconds,"
                    + " s.lossy_seconds, s.rtt_ms_sum, s.rtt_reports, s.rtt_ms_max,"
                    + " s.loss_permille_sum, s.loss_reports, s.jitter_ms_sum, s.jitter_reports,"
                    + " s.bitrate_kbps_sum, s.bitrate_reports, s.freezes, s.relay_reports, s.codecs"
                    + " FROM meeting_stats s LEFT JOIN rooms r ON r.id=s.room_id"
                    + " WHERE s.started_at>=? AND s.started_at<? AND s.quality_reports>0"
                    + " ORDER BY s.started_at DESC")
            .params(from, to)
            .query(
                (rs, i) ->
                    new Row(
                        rs.getLong(1),
                        rs.getString(2),
                        rs.getInt(3),
                        rs.getLong(4),
                        rs.getLong(5),
                        rs.getLong(6),
                        rs.getInt(7),
                        rs.getInt(8),
                        rs.getLong(9),
                        rs.getInt(10),
                        rs.getLong(11),
                        rs.getInt(12),
                        rs.getLong(13),
                        rs.getInt(14),
                        rs.getInt(15),
                        rs.getInt(16),
                        rs.getString(17)))
            .list();
    var offset = ZoneOffset.ofTotalSeconds(Math.clamp(offsetMinutes, -14 * 60, 14 * 60) * 60);
    var days = new TreeMap<LocalDate, long[]>();
    var codecs = new TreeMap<String, Integer>();
    var recent = new ArrayList<QualityMeeting>();
    long reports = 0, seconds = 0, lossy = 0, rttSum = 0, rttReports = 0, lossSum = 0;
    long lossReports = 0, jitterSum = 0, jitterReports = 0, bitrateSum = 0, bitrateReports = 0;
    long relay = 0;
    int rttMax = 0, freezes = 0;
    for (var row : list) {
      reports += row.reports();
      seconds += row.seconds();
      lossy += row.lossy();
      rttSum += row.rttSum();
      rttReports += row.rttReports();
      rttMax = Math.max(rttMax, row.rttMax());
      lossSum += row.lossSum();
      lossReports += row.lossReports();
      jitterSum += row.jitterSum();
      jitterReports += row.jitterReports();
      bitrateSum += row.bitrateSum();
      bitrateReports += row.bitrateReports();
      freezes += row.freezes();
      relay += row.relay();
      if (row.codecs() != null && !row.codecs().isBlank())
        for (var codec : row.codecs().split(" ")) codecs.merge(codec, 1, Integer::sum);
      var day = LocalDate.ofInstant(Instant.ofEpochMilli(row.startedAt()), offset);
      var totals = days.computeIfAbsent(day, d -> new long[5]);
      totals[0] += row.reports();
      totals[1] += row.rttSum();
      totals[2] += row.rttReports();
      totals[3] += row.lossSum();
      totals[4] += row.lossReports();
      if (recent.size() < RECENT)
        recent.add(
            new QualityMeeting(
                row.code(),
                row.startedAt(),
                row.reports(),
                mean(row.rttSum(), row.rttReports()),
                row.rttReports() > 0 ? row.rttMax() : null,
                percent(row.lossSum(), row.lossReports()),
                mean(row.jitterSum(), row.jitterReports()),
                row.freezes(),
                row.relay() > 0));
    }
    return new Quality(
        from,
        to,
        list.size(),
        (int) reports,
        seconds,
        mean(rttSum, rttReports),
        rttReports > 0 ? rttMax : null,
        percent(lossSum, lossReports),
        mean(jitterSum, jitterReports),
        mean(bitrateSum, bitrateReports),
        freezes,
        seconds > 0 ? freezes * 3600.0 / seconds : null,
        seconds > 0 ? (double) lossy / seconds : null,
        reports > 0 ? (double) relay / reports : null,
        codecs,
        days.entrySet().stream()
            .map(
                e ->
                    new QualityDay(
                        e.getKey().toString(),
                        (int) e.getValue()[0],
                        mean(e.getValue()[1], e.getValue()[2]),
                        percent(e.getValue()[3], e.getValue()[4])))
            .toList(),
        recent);
  }

  private static Integer mean(long sum, long count) {
    return count > 0 ? (int) Math.round((double) sum / count) : null;
  }

  /** Потери — из десятых долей процента: среднее с одним знаком после запятой. */
  private static Double percent(long permille, long count) {
    return count > 0 ? Math.round((double) permille / count) / 10.0 : null;
  }

  /** Границы корзин длительности: до 5 мин, 15, 30, часа, двух, четырёх и дольше. */
  static final long[] BUCKETS = {300, 900, 1800, 3600, 7200, 14400, Long.MAX_VALUE};

  /**
   * Встречи, начавшиеся в промежутке. Дни — по часовому поясу смотрящего ({@code offsetMinutes} к
   * UTC, как его называет браузер): владелец видит «вчера» своим вчера.
   */
  public Summary summary(long from, long to, int offsetMinutes) {
    long now = clock.millis();
    record Row(
        long startedAt, Long endedAt, String reason, int peak, long humanSeconds, String kinds) {}
    var list =
        jdbc.sql(
                "SELECT started_at, ended_at, end_reason, peak_humans, human_seconds, integrations,"
                    + " humans_now, humans_since FROM meeting_stats WHERE started_at>=? AND"
                    + " started_at<? ORDER BY started_at")
            .params(from, to)
            .query(
                (rs, i) -> {
                  long seconds = rs.getLong(5);
                  if (rs.getObject(2) == null)
                    seconds += (long) rs.getInt(7) * Math.max(0, now - rs.getLong(8)) / 1000;
                  return new Row(
                      rs.getLong(1),
                      rs.getObject(2, Long.class),
                      rs.getString(3),
                      rs.getInt(4),
                      seconds,
                      rs.getString(6));
                })
            .list();
    var offset = ZoneOffset.ofTotalSeconds(Math.clamp(offsetMinutes, -14 * 60, 14 * 60) * 60);
    var days = new TreeMap<LocalDate, long[]>();
    var integrations = new TreeMap<String, Integer>();
    var reasons = new TreeMap<String, Integer>();
    var durations = new ArrayList<Long>();
    var buckets = new int[BUCKETS.length];
    long humanSeconds = 0;
    int peak = 0;
    for (var row : list) {
      long seconds =
          Math.max(0, ((row.endedAt() == null ? now : row.endedAt()) - row.startedAt()) / 1000);
      durations.add(seconds);
      for (int i = 0; i < BUCKETS.length; i++)
        if (seconds < BUCKETS[i]) {
          buckets[i]++;
          break;
        }
      humanSeconds += row.humanSeconds();
      peak = Math.max(peak, row.peak());
      var day = LocalDate.ofInstant(Instant.ofEpochMilli(row.startedAt()), offset);
      var totals = days.computeIfAbsent(day, d -> new long[3]);
      totals[0]++;
      totals[1] += row.humanSeconds();
      totals[2] = Math.max(totals[2], row.peak());
      if (row.kinds() != null && !row.kinds().isBlank())
        for (var kind : row.kinds().split(" ")) integrations.merge(kind, 1, Integer::sum);
      reasons.merge(row.reason() == null ? "live" : row.reason(), 1, Integer::sum);
    }
    Collections.sort(durations);
    var joins = audit.joins(from, to);
    var fromDay = LocalDate.ofInstant(Instant.ofEpochMilli(from), ZoneOffset.UTC);
    var toDay = LocalDate.ofInstant(Instant.ofEpochMilli(Math.max(from, to - 1)), ZoneOffset.UTC);
    var bucketList = new ArrayList<Bucket>();
    for (int i = 0; i < BUCKETS.length; i++)
      bucketList.add(new Bucket(BUCKETS[i] == Long.MAX_VALUE ? -1 : BUCKETS[i], buckets[i]));
    return new Summary(
        from,
        to,
        list.size(),
        humanSeconds,
        durations.isEmpty() ? 0 : durations.get(durations.size() / 2),
        durations.isEmpty() ? 0 : durations.getLast(),
        peak,
        stats.devices(fromDay, toDay),
        joins[0],
        joins[1],
        days.entrySet().stream()
            .map(
                e ->
                    new Day(
                        e.getKey().toString(),
                        (int) e.getValue()[0],
                        e.getValue()[1],
                        (int) e.getValue()[2]))
            .toList(),
        bucketList,
        integrations,
        reasons);
  }
}
