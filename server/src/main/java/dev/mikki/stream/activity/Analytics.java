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
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Аналитика продукта (R210, {@code docs/architecture/admin-analytics.md} §2): строка на посетителя
 * ({@code visitors}) и строка на посетителя за день ({@code visitor_days}, V16). Считает, а не
 * показывает: отчёт строит {@link AnalyticsReport}.
 *
 * <p>ЛИЧНОСТЬ (Р-121). Посетитель — профиль устройства; ключ — HMAC секретом сервера от хэша
 * профиля: стабильный, иначе «вернулся через 7 дней» и когорты ЛТВ не сосчитать. Без профиля —
 * суточно-солёный отпечаток адреса: виден как посетитель дня, между днями не склеивается, в когорты
 * не входит.
 *
 * <p>ПРИСУТСТВИЕ. Как человеко-секунды у {@link MeetingStats}, но на человека: в памяти — с какого
 * момента участник на связи; отрезок ложится в его строку дня, когда он уходит со связи или встреча
 * закрывается. Перезапуск ядра теряет только незакрытые отрезки. Тип клиента участника наблюдатель
 * комнаты не знает — он запоминается при входе ({@link #entered}).
 *
 * <p>Аналитика — статистика, не условие входа: отказ базы здесь пишется в журнал и глотается, вход
 * человека от него не ломается. Внутри транзакции комнаты ({@link RoomObserver}) исключения тоже не
 * бросаются — иначе откатилось бы само действие.
 */
@Component
public class Analytics implements RoomObserver {
  private static final Logger log = LoggerFactory.getLogger(Analytics.class);

  /** Сколько профилей помнить с их клиентом; больше — таблица очищается целиком. */
  static final int CLIENT_MEMORY = 20_000;

  private final JdbcClient jdbc;
  private final Secrets secrets;
  private final StreamProperties config;
  private final Clock clock;
  private final Map<String, ClientKind> clients = new ConcurrentHashMap<>();
  private final Map<String, Presence> presence = new ConcurrentHashMap<>();

  /** Кто во встрече на связи и с какого момента, и какие интеграции в ней уже видели. */
  private record Presence(Map<String, Long> since, Set<String> integrations) {
    Presence() {
      this(new HashMap<>(), new HashSet<>());
    }
  }

  public Analytics(JdbcClient jdbc, Secrets secrets, StreamProperties config, Clock clock) {
    this.jdbc = jdbc;
    this.secrets = secrets;
    this.config = config;
    this.clock = clock;
  }

  // ── Запись событий ───────────────────────────────────────────────────────────────────────────

  /** Открыл сайт ({@code open}) или дошёл до предвхода ({@code prejoin}). */
  public void visit(String profileHash, String addressKey, ClientKind client, String stage) {
    var day = today();
    var key = key(profileHash, addressKey, day);
    if (key == null) return;
    remember(profileHash, client);
    boolean open = "open".equals(stage);
    try {
      touch(key, day, client, profileHash == null, false);
      bump(key, day, client, "visits", open ? 1 : 0, "prejoins", open ? 0 : 1);
    } catch (DataAccessException e) {
      log.warn("Аналитика: визит не записан: {}", e.getMessage());
    }
  }

  /**
   * Вход во встречу через дверь {@code door} ({@code create}, {@code link}, {@code code}, {@code
   * rejoin}, {@code saved}); {@code ok} — впустили. Возврат в ту же встречу ({@code rejoin}) входом
   * не считается — плохая связь не должна выглядеть ростом звонков.
   */
  public void entered(
      String profileHash, String addressKey, ClientKind client, String door, boolean ok) {
    var day = today();
    var key = key(profileHash, addressKey, day);
    if (key == null) return;
    remember(profileHash, client);
    boolean counts = !"rejoin".equals(door);
    try {
      touch(key, day, client, profileHash == null, ok && counts);
      if (!ok) bump(key, day, client, "join_failures", 1);
      else if (counts) bump(key, day, client, door.equals("create") ? "creates" : "joins", 1);
    } catch (DataAccessException e) {
      log.warn("Аналитика: вход не записан: {}", e.getMessage());
    }
  }

  /** Человек увидел {@code count} ошибок (сводка {@code client-errors}). */
  public void errors(String profileHash, ClientKind client, int count) {
    if (profileHash == null || count <= 0) return;
    var day = today();
    var key = key(profileHash, null, day);
    try {
      touch(key, day, client, false, false);
      bump(key, day, client, "errors", count);
    } catch (DataAccessException e) {
      log.warn("Аналитика: ошибки не записаны: {}", e.getMessage());
    }
  }

  // ── Наблюдатель комнаты: присутствие и интеграции ────────────────────────────────────────────

  @Override
  public void changed(RoomState room, String event, long now) {
    if (room.closedAt != null) {
      flushAll(room, now);
      return;
    }
    var state = presence.computeIfAbsent(room.id, id -> new Presence());
    var connected = new HashMap<String, String>();
    for (var member : room.members.values()) {
      if (!member.human() || member.status != RoomState.Status.CONNECTED) continue;
      var profile = room.profiles.get(member.id);
      if (profile != null) connected.put(member.id, profile);
    }
    try {
      for (var gone : new ArrayList<>(state.since().keySet()))
        if (!connected.containsKey(gone)) {
          var profile = room.profiles.get(gone);
          long since = state.since().remove(gone);
          if (profile != null) presence(profile, since, now);
        }
      for (var id : connected.keySet()) state.since().putIfAbsent(id, now);
      var kinds = Activity.integrations(room);
      var fresh = new ArrayList<String>();
      for (var kind : kinds) if (state.integrations().add(kind)) fresh.add(kind);
      if (!fresh.isEmpty())
        for (var profile : new HashSet<>(connected.values())) {
          var day = day(now);
          var key = key(profile, null, day);
          touch(key, day, client(profile), false, false);
          bump(key, day, client(profile), "integrations", fresh.size());
        }
    } catch (DataAccessException e) {
      log.warn("Аналитика: присутствие не записано: {}", e.getMessage());
    }
  }

  @Override
  public void closed(RoomState room, String reason, long now) {
    flushAll(room, now);
  }

  private void flushAll(RoomState room, long now) {
    var state = presence.remove(room.id);
    if (state == null) return;
    try {
      for (var entry : state.since().entrySet()) {
        var profile = room.profiles.get(entry.getKey());
        if (profile != null) presence(profile, entry.getValue(), now);
      }
    } catch (DataAccessException e) {
      log.warn("Аналитика: присутствие не записано: {}", e.getMessage());
    }
  }

  private void presence(String profile, long since, long now) {
    long seconds = Math.max(0, now - since) / 1000;
    if (seconds == 0) return;
    var day = day(now);
    var key = key(profile, null, day);
    touch(key, day, client(profile), false, false);
    bump(key, day, client(profile), "presence_seconds", seconds);
  }

  // ── Уборка ───────────────────────────────────────────────────────────────────────────────────

  /** Забыть строки старше срока ({@code stream.retention.analytics}); сколько забыто. */
  public int sweep(long now) {
    int days = jdbc.sql("DELETE FROM visitor_days WHERE expires_at<=?").param(now).update();
    int visitors = jdbc.sql("DELETE FROM visitors WHERE expires_at<=?").param(now).update();
    return days + visitors;
  }

  // ── Внутреннее ───────────────────────────────────────────────────────────────────────────────

  /** Ключ посетителя: по профилю — стабильный; без профиля — отпечаток адреса на этот день. */
  String key(String profileHash, String addressKey, LocalDate day) {
    if (profileHash != null) return secrets.derive("analytics:" + profileHash);
    if (addressKey == null) return null;
    return secrets.derive("analytics-day:" + day + ":" + addressKey);
  }

  private void remember(String profileHash, ClientKind client) {
    if (profileHash == null || client == null) return;
    if (clients.size() >= CLIENT_MEMORY) clients.clear();
    clients.put(profileHash, client);
  }

  private ClientKind client(String profileHash) {
    return clients.getOrDefault(profileHash, ClientKind.UNKNOWN);
  }

  private LocalDate today() {
    return day(clock.millis());
  }

  private static LocalDate day(long millis) {
    return LocalDate.ofInstant(Instant.ofEpochMilli(millis), ZoneOffset.UTC);
  }

  private long expiry(long now) {
    return now + config.retention().analytics().toMillis();
  }

  /**
   * Строка посетителя: обновить «виделись», срок и первый звонок; нет строки — создать. Без {@code
   * ON CONFLICT}: его нет у H2 тестов, а гонка двух вставок одного ключа ловится по дубликату.
   */
  private void touch(
      String key, LocalDate day, ClientKind client, boolean anonymous, boolean called) {
    long now = clock.millis();
    int updated =
        jdbc.sql(
                "UPDATE visitors SET last_seen_at=?, expires_at=?, first_called_at=COALESCE("
                    + "first_called_at, ?) WHERE visitor_key=?")
            .params(now, expiry(now), called ? now : null, key)
            .update();
    if (updated > 0) return;
    try {
      jdbc.sql(
              "INSERT INTO visitors(visitor_key,first_seen_at,first_day,first_client,first_os,"
                  + "first_called_at,last_seen_at,anonymous,expires_at) VALUES(?,?,?,?,?,?,?,?,?)")
          .params(
              key,
              now,
              day,
              client.client(),
              client.os(),
              called ? now : null,
              now,
              anonymous,
              expiry(now))
          .update();
    } catch (org.springframework.dao.DuplicateKeyException race) {
      touch(key, day, client, anonymous, called);
    }
  }

  /** Прибавить к счётчикам строки дня; нет строки — создать с этими же значениями. */
  private void bump(String key, LocalDate day, ClientKind client, Object... columnsAndDeltas) {
    long now = clock.millis();
    var set = new StringBuilder();
    var params = new ArrayList<Object>();
    var columns = new StringBuilder();
    var values = new StringBuilder();
    var inserts = new ArrayList<Object>();
    for (int i = 0; i < columnsAndDeltas.length; i += 2) {
      var column = (String) columnsAndDeltas[i];
      var delta = ((Number) columnsAndDeltas[i + 1]).longValue();
      if (delta == 0) continue;
      set.append(column).append('=').append(column).append("+?,");
      params.add(delta);
      columns.append(',').append(column);
      values.append(",?");
      inserts.add(delta);
    }
    if (params.isEmpty()) return;
    params.add(client.client());
    params.add(client.os());
    params.add(expiry(now));
    params.add(day);
    params.add(key);
    int updated =
        jdbc.sql(
                "UPDATE visitor_days SET "
                    + set
                    + "client=?, os=?, expires_at=? WHERE day_utc=? AND visitor_key=?")
            .params(params)
            .update();
    if (updated > 0) return;
    var all = new ArrayList<Object>(List.of(day, key, client.client(), client.os(), expiry(now)));
    all.addAll(inserts);
    try {
      jdbc.sql(
              "INSERT INTO visitor_days(day_utc,visitor_key,client,os,expires_at"
                  + columns
                  + ") VALUES(?,?,?,?,?"
                  + values
                  + ")")
          .params(all)
          .update();
    } catch (org.springframework.dao.DuplicateKeyException race) {
      bump(key, day, client, columnsAndDeltas);
    }
  }
}
