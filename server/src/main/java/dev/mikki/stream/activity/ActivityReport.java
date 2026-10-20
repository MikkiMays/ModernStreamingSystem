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
