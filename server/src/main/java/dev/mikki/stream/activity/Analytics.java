package dev.mikki.stream.activity;

import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.room.RoomObserver;
import dev.mikki.stream.room.RoomState;
import jakarta.annotation.PreDestroy;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Аналитика продукта (R210, {@code docs/architecture/admin-analytics.md} §2): строка на посетителя
 * ({@code visitors}) и строка на посетителя за день ({@code visitor_days}, V16). Считает, а не
 * показывает: отчёт строит {@link AnalyticsReport}.
 *
 * <p>ЛИЧНОСТЬ (Р-121). Посетитель — профиль устройства ({@code X-Cord-Profile}) или пользователь
 * Telegram, от имени которого действует бот ({@code actor:tg:…}, уже HMAC номера). Ключ — HMAC
 * секретом сервера: стабильный, иначе ни «новых», ни «вернувшихся», ни когорт не сосчитать. Адреса
 * здесь нет вовсе — даже отпечатком: запрос без профиля в аналитику не попадает (свои клиенты
 * профиль шлют всегда, без него ходят только скрипты).
 *
 * <p>БУФЕР. События складываются в память и раз в 10 с ({@link AnalyticsSchedule}) ложатся в базу
 * одним проходом — не в транзакции встречи и не в запросе человека: вход во встречу не ждёт
 * аналитики и не ломается от её сбоя, а у PostgreSQL ошибка внутри транзакции встречи откатила бы
 * саму встречу. Не записанное (база недоступна) возвращается в буфер и пробуется снова; при
 * остановке ядра буфер дописывается ({@link #shutdown}).
 *
 * <p>ПРИСУТСТВИЕ. Наблюдатель комнаты помнит, с какого момента каждый участник с профилем на связи;
 * каждый проход буфера досчитывает открытые отрезки до «сейчас», отрезок через полночь режется по
 * дням. Наблюдатель зовётся внутри транзакции комнаты — изменение применяется только после её
 * фиксации, откаченная встреча аналитику не трогает.
 *
 * <p>Ядро одно на машину (compose), поэтому писатель один и гонок вставки нет; на случай второго
 * экземпляра вставка, проигравшая гонку, повторяется обновлением.
 */
@Component
public class Analytics implements RoomObserver {
  private static final Logger log = LoggerFactory.getLogger(Analytics.class);

  /** Сколько клиентов профилей помнить для присутствия; дальше — забываются самые давние. */
  static final int CLIENT_MEMORY = 50_000;

  /** Сколько строк «посетитель × день» держать в буфере; больше — новые события теряются. */
  static final int BUFFER_LIMIT = 100_000;

  /** Сколько раз пробовать записать строку, прежде чем выбросить её с предупреждением. */
  static final int ATTEMPTS = 5;

  /** Комната без людей на связи забывается, если о ней ничего не слышно сутки. */
  static final long STALE_ROOM_MS = 24 * 3600_000L;

  private final JdbcClient jdbc;
  private final Secrets secrets;
  private final AnalyticsProperties config;
  private final Clock clock;
  private final Object lock = new Object();

  // Под lock.
  private Map<Slot, Tally> pending = new HashMap<>();
  private final Map<String, Watched> rooms = new HashMap<>();
  private final LinkedHashMap<String, ClientKind> clients =
      new LinkedHashMap<>(1024, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, ClientKind> eldest) {
          return size() > CLIENT_MEMORY;
        }
      };
  private long dropped;

  /** Строка буфера: посетитель за день. */
  record Slot(LocalDate day, String key) {}

  /** Приращения строки дня и строки посетителя. */
  static final class Tally {
    ClientKind client;
    boolean called;
    long visits, prejoins, creates, joins, failures, presence, integrations, errors;
    int attempts;

    void client(ClientKind kind) {
      if (kind != null && (client == null || "other".equals(client.client()))) client = kind;
    }

    void add(Tally other) {
      client(other.client);
      called |= other.called;
      visits += other.visits;
      prejoins += other.prejoins;
      creates += other.creates;
      joins += other.joins;
      failures += other.failures;
      presence += other.presence;
      integrations += other.integrations;
      errors += other.errors;
      attempts = Math.max(attempts, other.attempts);
    }
  }

  /** Отрезок «на связи»: чей и с какого момента (мс), ещё не засчитанный. */
  private record Open(String key, long since) {}

  /** Что наблюдатель помнит о встрече: открытые отрезки и какие интеграции кто уже застал. */
  private static final class Watched {
    final Map<String, Open> open = new HashMap<>();
    final Map<String, Set<String>> seen = new HashMap<>();
    long touched;
  }

  public Analytics(JdbcClient jdbc, Secrets secrets, AnalyticsProperties config, Clock clock) {
    this.jdbc = jdbc;
    this.secrets = secrets;
    this.config = config;
    this.clock = clock;
  }

  // ── События ──────────────────────────────────────────────────────────────────────────────────

  /** Открыл сайт или приложение ({@code open}) или дошёл до предвхода ({@code prejoin}). */
  public void visit(String profileHash, ClientKind client, String stage) {
    var key = key(profileHash, null);
    if (key == null) return;
    boolean open = "open".equals(stage);
    record(
        key,
        client,
        t -> {
          if (open) t.visits++;
          else t.prejoins++;
        });
  }

  /**
   * Вход во встречу через дверь {@code door} ({@code create}, {@code link}, {@code code}, {@code
   * rejoin}, {@code saved}); {@code ok} — впустили. {@code entrant} — ключ входящего из {@code
   * ClientAddress.entrant}: им приходит пользователь Telegram без профиля. Возврат в ту же встречу
   * ({@code rejoin}) входом не считается — плохая связь не должна выглядеть ростом звонков.
   */
  public void entered(
      String profileHash, String entrant, ClientKind client, String door, boolean ok) {
    var key = key(profileHash, entrant);
    if (key == null) return;
    record(
        key,
        client,
        t -> {
          if (!ok) t.failures++;
          else {
            t.called = true;
            if ("create".equals(door)) t.creates++;
            else if (!"rejoin".equals(door)) t.joins++;
          }
        });
  }

  /** Человек увидел {@code count} ошибок (сводка {@code client-errors}, R180). */
  public void errors(String profileHash, ClientKind client, int count) {
    if (count <= 0) return;
    var key = key(profileHash, null);
    if (key == null) return;
    record(key, client, t -> t.errors += count);
  }

  // ── Наблюдатель комнаты ──────────────────────────────────────────────────────────────────────

  @Override
  public void changed(RoomState room, String event, long now) {
    if (!config.enabled()) return;
    if (room.closedAt != null) {
      closed(room, "closed", now);
      return;
    }
    var connected = new HashMap<String, String>();
    for (var member : room.members.values()) {
      if (!member.human() || member.status != RoomState.Status.CONNECTED) continue;
      var key = key(room.profiles.get(member.id), null);
      if (key != null) connected.put(member.id, key);
    }
    var kinds = Activity.integrations(room);
    var id = room.id;
    afterCommit(() -> observe(id, connected, kinds, false, now));
  }

  @Override
  public void closed(RoomState room, String reason, long now) {
    if (!config.enabled()) return;
    var id = room.id;
    afterCommit(() -> observe(id, Map.of(), List.of(), true, now));
  }

  private void observe(
      String roomId, Map<String, String> connected, List<String> kinds, boolean closed, long now) {
    synchronized (lock) {
      var watched = rooms.get(roomId);
      if (watched == null) {
        if (closed || connected.isEmpty()) return;
        watched = new Watched();
        rooms.put(roomId, watched);
      }
      watched.touched = now;
      for (var it = watched.open.entrySet().iterator(); it.hasNext(); ) {
        var entry = it.next();
        var open = entry.getValue();
        if (open.key().equals(connected.get(entry.getKey()))) continue;
        credit(open.key(), open.since(), now);
        it.remove();
      }
      for (var entry : connected.entrySet())
        watched.open.putIfAbsent(entry.getKey(), new Open(entry.getValue(), now));
      if (!kinds.isEmpty())
        for (var key : new HashSet<>(connected.values())) {
          var seen = watched.seen.computeIfAbsent(key, k -> new HashSet<>());
          int fresh = 0;
          for (var kind : kinds) if (seen.add(kind)) fresh++;
          if (fresh > 0) tally(day(now), key).integrations += fresh;
        }
      if (closed) rooms.remove(roomId);
    }
  }

  /**
   * Засчитать отрезок {@code [since, now)} целыми секундами, разрезав по дням пояса; вернуть начало
   * незасчитанного остатка (меньше секунды).
   */
  private long credit(String key, long since, long now) {
    long start = since;
    while (now - start >= 1000) {
      var day = day(start);
      long midnight = day.plusDays(1).atStartOfDay(config.zone()).toInstant().toEpochMilli();
      long end = Math.min(now, midnight);
      long seconds = (end - start) / 1000;
      if (seconds == 0) {
        // Меньше секунды до полуночи — этот обрезок не в счёт, отрезок продолжается с полуночи.
        if (end == now) break;
        start = end;
        continue;
      }
      tally(day, key).presence += seconds;
      start += seconds * 1000;
    }
    return start;
  }

  // ── Запись ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Записать буфер: досчитать открытые отрезки до «сейчас» и разложить строки по таблицам. Сколько
   * строк записано.
   */
  public int flush() {
    long now = clock.millis();
    Map<Slot, Tally> batch;
    synchronized (lock) {
      for (var it = rooms.values().iterator(); it.hasNext(); ) {
        var watched = it.next();
        if (watched.open.isEmpty() && now - watched.touched > STALE_ROOM_MS) {
          it.remove();
          continue;
        }
        for (var entry : watched.open.entrySet()) {
          var open = entry.getValue();
          entry.setValue(new Open(open.key(), credit(open.key(), open.since(), now)));
        }
      }
      if (pending.isEmpty()) return 0;
      batch = pending;
      pending = new HashMap<>();
    }
    int written = 0;
    var failed = new HashMap<Slot, Tally>();
    DataAccessException failure = null;
    var slots = new ArrayList<>(batch.keySet());
    slots.sort(Comparator.comparing(Slot::day).thenComparing(Slot::key));
    for (var slot : slots) {
      var tally = batch.get(slot);
      try {
        write(slot, tally, now);
        written++;
      } catch (DataAccessException e) {
        failure = e;
        if (++tally.attempts < ATTEMPTS) failed.put(slot, tally);
      }
    }
    if (failure != null)
      log.warn(
          "Аналитика: {} строк не записано, {} вернутся в буфер: {}",
          slots.size() - written,
          failed.size(),
          failure.getMessage());
    if (!failed.isEmpty())
      synchronized (lock) {
        for (var entry : failed.entrySet())
          pending.merge(
              entry.getKey(),
              entry.getValue(),
              (fresh, old) -> {
                old.add(fresh);
                return old;
              });
      }
    return written;
  }

  /** Остановка ядра: дописать буфер вместе с открытыми отрезками. */
  @PreDestroy
  public void shutdown() {
    try {
      flush();
    } catch (RuntimeException e) {
      log.warn("Аналитика: буфер при остановке не записан: {}", e.getMessage());
    }
  }

  private void write(Slot slot, Tally t, long now) {
    var day = slot.day();
    var client = t.client == null ? ClientKind.UNKNOWN : t.client;
    var calledDay = t.called ? day : null;
    long dayExpiry = dayStart(day.plusDays(1)) + config.retention().toMillis();
    for (int attempt = 0; ; attempt++) {
      // Строка из буфера бывает старше записанной (вернулась после сбоя базы) — поэтому LEAST и
      // GREATEST, а не «первый — тот, что был».
      var update =
          t.called
              ? jdbc.sql(
                      "UPDATE visitors SET first_day=LEAST(first_day, ?), last_day=GREATEST(last_day,"
                          + " ?), first_called_day=LEAST(COALESCE(first_called_day, ?), ?),"
                          + " expires_at=GREATEST(expires_at, ?) WHERE visitor_key=?")
                  .params(day, day, day, day, dayExpiry, slot.key())
              : jdbc.sql(
                      "UPDATE visitors SET first_day=LEAST(first_day, ?), last_day=GREATEST(last_day,"
                          + " ?), expires_at=GREATEST(expires_at, ?) WHERE visitor_key=?")
                  .params(day, day, dayExpiry, slot.key());
      if (update.update() > 0) break;
      try {
        jdbc.sql(
                "INSERT INTO visitors(visitor_key,first_day,first_client,first_os,first_called_day,"
                    + "last_day,expires_at) VALUES(?,?,?,?,?,?,?)")
            .params(slot.key(), day, client.client(), client.os(), calledDay, day, dayExpiry)
            .update();
        break;
      } catch (DuplicateKeyException race) {
        if (attempt > 0) throw race;
      }
    }
    for (int attempt = 0; ; attempt++) {
      int updated =
          jdbc.sql(
                  "UPDATE visitor_days SET visits=visits+?, prejoins=prejoins+?, creates=creates+?,"
                      + " joins=joins+?, join_failures=join_failures+?,"
                      + " presence_seconds=presence_seconds+?, integrations=integrations+?,"
                      + " errors=errors+?, client=CASE WHEN client='other' THEN ? ELSE client END,"
                      + " os=CASE WHEN os='other' THEN ? ELSE os END WHERE local_day=? AND"
                      + " visitor_key=?")
              .params(
                  t.visits,
                  t.prejoins,
                  t.creates,
                  t.joins,
                  t.failures,
                  t.presence,
                  t.integrations,
                  t.errors,
                  client.client(),
                  client.os(),
                  day,
                  slot.key())
              .update();
      if (updated > 0) return;
      try {
        jdbc.sql(
                "INSERT INTO visitor_days(local_day,visitor_key,client,os,visits,prejoins,creates,"
                    + "joins,join_failures,presence_seconds,integrations,errors,expires_at)"
                    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .params(
                day,
                slot.key(),
                client.client(),
                client.os(),
                t.visits,
                t.prejoins,
                t.creates,
                t.joins,
                t.failures,
                t.presence,
                t.integrations,
                t.errors,
                dayExpiry)
            .update();
        return;
      } catch (DuplicateKeyException race) {
        if (attempt > 0) throw race;
      }
    }
  }

  /** Забыть строки старше срока ({@code stream.analytics.retention}); сколько забыто. */
  public int sweep(long now) {
    int days = jdbc.sql("DELETE FROM visitor_days WHERE expires_at<=?").param(now).update();
    int visitors = jdbc.sql("DELETE FROM visitors WHERE expires_at<=?").param(now).update();
    return days + visitors;
  }

  // ── Внутреннее ───────────────────────────────────────────────────────────────────────────────

  /**
   * Ключ посетителя: HMAC хэша профиля, без профиля — HMAC ключа пользователя Telegram ({@code
   * actor:…}); иначе (адрес, служба без актора) — {@code null}: такой запрос не считается.
   */
  String key(String profileHash, String entrant) {
    if (!config.enabled()) return null;
    if (profileHash != null) return secrets.derive("analytics:" + profileHash);
    if (entrant != null && entrant.startsWith("actor:"))
      return secrets.derive("analytics:" + entrant);
    return null;
  }

  private interface Change {
    void apply(Tally tally);
  }

  private void record(String key, ClientKind client, Change change) {
    var day = day(clock.millis());
    synchronized (lock) {
      if (client != null && !"other".equals(client.client())) clients.put(key, client);
      var tally = tally(day, key);
      tally.client(client);
      change.apply(tally);
    }
  }

  /** Строка буфера; под lock. Буфер полон — строка-заглушка, которая никуда не попадёт. */
  private Tally tally(LocalDate day, String key) {
    var slot = new Slot(day, key);
    var tally = pending.get(slot);
    if (tally != null) return tally;
    tally = new Tally();
    tally.client(clients.get(key));
    if (pending.size() >= BUFFER_LIMIT) {
      if (dropped++ % 10_000 == 0)
        log.warn("Аналитика: буфер полон ({} строк), события теряются", pending.size());
      return tally;
    }
    pending.put(slot, tally);
    return tally;
  }

  /** Применить после фиксации транзакции комнаты; без транзакции — сразу. */
  private static void afterCommit(Runnable action) {
    if (TransactionSynchronizationManager.isSynchronizationActive())
      TransactionSynchronizationManager.registerSynchronization(
          new TransactionSynchronization() {
            @Override
            public void afterCommit() {
              action.run();
            }
          });
    else action.run();
  }

  LocalDate day(long millis) {
    return LocalDate.ofInstant(Instant.ofEpochMilli(millis), config.zone());
  }

  private long dayStart(LocalDate day) {
    return day.atStartOfDay(config.zone()).toInstant().toEpochMilli();
  }
}
