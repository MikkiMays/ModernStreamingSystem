package dev.mikki.stream.activity;

import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.room.RoomObserver;
import dev.mikki.stream.room.RoomState;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Статистика встреч: одна строка {@code meeting_stats} на встречу в смысле П7 — от «двое людей на
 * связи» до конца ({@code docs/observability.md} §9).
 *
 * <p>ЧЕЛОВЕКО-СЕКУНДЫ. Строка помнит, сколько людей на связи сейчас и с какого момента ({@code
 * humans_now}, {@code humans_since}); каждое изменение этого числа досчитывает прошедший отрезок.
 * Поэтому перезапуск ядра посреди встречи ничего не теряет: следующее изменение прочтёт отсчёт из
 * базы. В памяти — только копия строки, чтобы не писать в базу на каждое событие комнаты: запись
 * бывает, только когда изменилось число людей, появилась интеграция или пришло сообщение.
 *
 * <p>УСТРОЙСТВА. Сколько разных устройств входило за сутки, считает HyperLogLog Redis ({@code
 * PFADD} отпечатка профиля или адреса): в базу ложится только число, сами отпечатки не хранятся
 * нигде. Без Redis (тесты, локальный профиль) — множества в памяти процесса.
 */
@Component
public class MeetingStats implements RoomObserver {
  private static final String DEVICES = "activity:devices:";

  /**
   * Сколько суток держится счётчик устройств одного дня — дольше года «за период» не спрашивают.
   */
  private static final long DEVICE_DAYS = 400;

  private final JdbcClient jdbc;
  private final StreamProperties config;
  private final Metrics metrics;
  private final Clock clock;
  private final Secrets secrets;
  private final StringRedisTemplate redis;
  private final Map<String, Tracked> tracked = new ConcurrentHashMap<>();
  private final Map<LocalDate, Set<String>> localDevices = new ConcurrentHashMap<>();

  private record Tracked(long startedAt, int humans, long since, int peak, String integrations) {}

  public MeetingStats(
      JdbcClient jdbc,
      StreamProperties config,
      Metrics metrics,
      Clock clock,
      Secrets secrets,
      StringRedisTemplate redis) {
    this.jdbc = jdbc;
    this.config = config;
    this.metrics = metrics;
    this.clock = clock;
    this.secrets = secrets;
    this.redis = redis;
  }

  @Override
  public void changed(RoomState room, String event, long now) {
    if (room.startedAt == null || room.closedAt != null) return;
    var row = row(room);
    int humans = Activity.connectedHumans(room);
    var integrations = merge(row.integrations(), Activity.integrations(room));
    boolean message = "message.created".equals(event);
    if (humans == row.humans() && integrations.equals(row.integrations()) && !message) return;
    long add = humans == row.humans() ? 0 : spent(row, now);
    long since = humans == row.humans() ? row.since() : now;
    int peak = Math.max(row.peak(), humans);
    jdbc.sql(
            "UPDATE meeting_stats SET human_seconds=human_seconds+?, humans_now=?, humans_since=?,"
                + " peak_humans=?, integrations=?, messages=messages+? WHERE room_id=? AND"
                + " started_at=?")
        .params(add, humans, since, peak, integrations, message ? 1 : 0, room.id, room.startedAt)
        .update();
    remember(room.id, new Tracked(row.startedAt(), humans, since, peak, integrations));
  }

  @Override
  public void closed(RoomState room, String reason, long now) {
    if (room.startedAt == null) return;
    var row = row(room);
    var integrations = merge(row.integrations(), Activity.integrations(room));
    jdbc.sql(
            "UPDATE meeting_stats SET ended_at=?, end_reason=?, human_seconds=human_seconds+?,"
                + " humans_now=0, humans_since=?, unique_devices=?, integrations=?, expires_at=?"
                + " WHERE room_id=? AND started_at=?")
        .params(
            now,
            reason,
            spent(row, now),
            now,
            devices(room),
            integrations,
            now + config.retention().meetingStats().toMillis(),
            room.id,
            room.startedAt)
        .update();
    tracked.remove(room.id);
    metrics.meetingEnded(reason, Math.max(0, (now - room.startedAt) / 1000), row.peak());
  }

  /**
   * Вход устройства во встречу — для «уникальных устройств» за сутки. {@code id} — хэш профиля или
   * отпечаток адреса; в счётчик ложится производный от него отпечаток дня.
   */
  public void device(String id) {
    if (id == null) return;
    var day = LocalDate.ofInstant(Instant.ofEpochMilli(clock.millis()), ZoneOffset.UTC);
    var element = secrets.derive("device:" + day + ":" + id);
    if (config.redisEnabled()) {
      try {
        var key = DEVICES + day;
        redis.opsForHyperLogLog().add(key, element);
        redis.expire(key, java.time.Duration.ofDays(DEVICE_DAYS));
        return;
      } catch (Exception e) {
        // Счётчик устройств — статистика, а не условие входа: без Redis вход не ломается.
        return;
      }
    }
    localDevices.computeIfAbsent(day, d -> ConcurrentHashMap.newKeySet()).add(element);
    localDevices.keySet().removeIf(d -> d.isBefore(day.minusDays(DEVICE_DAYS)));
  }

  /** Сколько разных устройств входило в эти сутки (UTC) — объединение, а не сумма. */
  public long devices(LocalDate from, LocalDate to) {
    var days = new ArrayList<LocalDate>();
    for (var d = from; !d.isAfter(to) && days.size() <= DEVICE_DAYS; d = d.plusDays(1)) days.add(d);
    if (config.redisEnabled()) {
      try {
        return Objects.requireNonNullElse(
            redis
                .opsForHyperLogLog()
                .size(days.stream().map(d -> DEVICES + d).toArray(String[]::new)),
            0L);
      } catch (Exception e) {
        return 0;
      }
    }
    var union = new HashSet<String>();
    for (var d : days) union.addAll(localDevices.getOrDefault(d, Set.of()));
    return union.size();
  }

  /** Строка встречи — из памяти, из базы или новая: встреча только что началась. */
  private Tracked row(RoomState room) {
    var known = tracked.get(room.id);
    if (known != null && known.startedAt() == room.startedAt) return known;
    var stored =
        jdbc.sql(
                "SELECT humans_now, humans_since, peak_humans, integrations FROM meeting_stats"
                    + " WHERE room_id=? AND started_at=?")
            .params(room.id, room.startedAt)
            .query(
                (rs, i) ->
                    new Tracked(
                        room.startedAt, rs.getInt(1), rs.getLong(2), rs.getInt(3), rs.getString(4)))
            .optional();
    if (stored.isPresent()) {
      remember(room.id, stored.get());
      return stored.get();
    }
    jdbc.sql(
            "INSERT INTO meeting_stats(room_id,started_at,humans_since,expires_at) VALUES(?,?,?,?)")
        .params(
            room.id,
            room.startedAt,
            room.startedAt,
            room.startedAt + config.retention().meetingStats().toMillis())
        .update();
    metrics.meetingStarted();
    var fresh = new Tracked(room.startedAt, 0, room.startedAt, 0, "");
    remember(room.id, fresh);
    return fresh;
  }

  /**
   * Копия строки в памяти — только если транзакция встречи зафиксируется. Откатилась — копия
   * забывается, и следующее событие перечитает строку из базы.
   */
  private void remember(String roomId, Tracked row) {
    tracked.put(roomId, row);
    if (TransactionSynchronizationManager.isSynchronizationActive())
      TransactionSynchronizationManager.registerSynchronization(
          new TransactionSynchronization() {
            @Override
            public void afterCompletion(int status) {
              if (status != STATUS_COMMITTED) tracked.remove(roomId);
            }
          });
  }

  /** Человеко-секунды отрезка с последнего изменения числа людей. */
  private static long spent(Tracked row, long now) {
    return (long) row.humans() * Math.max(0, now - row.since()) / 1000;
  }

  /** Слова интеграций через пробел, по алфавиту, без повторов. */
  private static String merge(String known, List<String> now) {
    var all = new TreeSet<String>();
    if (known != null && !known.isBlank()) all.addAll(Arrays.asList(known.split(" ")));
    all.addAll(now);
    return String.join(" ", all);
  }

  /**
   * Разных устройств за встречу: профили людей, вошедших с её начала (вернувшийся — тот же
   * профиль), и по одному на вход без профиля. Боты не считаются.
   */
  private static int devices(RoomState room) {
    long opened = room.openedAt != null ? room.openedAt : room.createdAt;
    var profiles = new HashSet<String>();
    int anonymous = 0;
    for (var member : room.members.values()) {
      if (!member.human() || member.joinedAt < opened || member.status == RoomState.Status.WAITING)
        continue;
      var profile = room.profiles.get(member.id);
      if (profile != null) profiles.add(profile);
      else if (member.replacedBy == null) anonymous++;
    }
    return Math.min(Short.MAX_VALUE, profiles.size() + anonymous);
  }
}
