package dev.mikki.stream.activity;

import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.room.Contracts;
import dev.mikki.stream.room.RetentionMeter;
import dev.mikki.stream.room.RoomObserver;
import dev.mikki.stream.room.RoomRepository;
import dev.mikki.stream.room.RoomState;
import dev.mikki.stream.shared.Problem;
import jakarta.annotation.PreDestroy;
import java.time.Clock;
import java.util.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Журнал участников встреч (Р-134, {@code meeting_participants}, V18) — метаданные: кто (имя во
 * встрече, отпечаток устройства), откуда (полный IP-адрес, тип клиента и система, медиаузел), с кем
 * (встреча: код и название) и когда (вход и выход). Строка на каждый вход через дверь ядра ({@code
 * api.Entries}); живёт {@code stream.retention.metadata} — год от входа. Содержимого здесь нет.
 *
 * <p>ВНЕ ТРАНЗАКЦИИ ВСТРЕЧИ, как буфер аналитики ({@link Analytics}). Вход ложится в память после
 * того, как встреча его зафиксировала, выход — после фиксации перемены комнаты ({@link #changed});
 * в базу буфер уходит одним проходом раз в 10 с ({@link AnalyticsSchedule}) и при остановке ядра.
 * Вход во встречу не ждёт журнала и не ломается от его сбоя: у PostgreSQL ошибка внутри транзакции
 * встречи откатила бы саму встречу.
 *
 * <p>ВЫХОД. Наблюдатель помнит, кто из записанных сейчас во встрече; перестал занимать место
 * (вышел, истёк срок восстановления, удалён, встреча кончилась) — у строки появляется {@code
 * left_at}. После перезапуска ядра открытые строки поднимаются из базы, а сверка раз в пять минут
 * ({@link #sweep}) закрывает строки, чьих людей во встрече уже нет: выход, случившийся, пока ядро
 * лежало, или вход, записанный позже выхода.
 */
@Component
public class Participants implements RoomObserver {
  private static final Logger log = LoggerFactory.getLogger(Participants.class);

  /** Сколько строк держать в буфере; больше — новые входы теряются с предупреждением. */
  static final int BUFFER_LIMIT = 50_000;

  /** Сколько строк отдаётся за раз пульту. */
  public static final int PAGE = 100;

  private final JdbcClient jdbc;
  private final TransactionTemplate tx;
  private final Clock clock;
  private final StreamProperties config;
  private final RoomRepository rooms;
  private final RetentionMeter retention;
  private final Object lock = new Object();
  private final Object flushing = new Object();

  // Под lock: ещё не записанные строки, выходы записанных и кто из записанных сейчас во встрече.
  private Map<String, Row> pending = new LinkedHashMap<>();
  private Map<String, Long> leaves = new LinkedHashMap<>();
  private final Map<String, Map<String, String>> open = new HashMap<>();
  private long dropped;

  /** Строка журнала, как её видит пульт. {@code leftAt} — null, пока человек во встрече. */
  public record Row(
      String id,
      String roomId,
      String roomCode,
      String title,
      String participantId,
      String name,
      String profileHash,
      String ip,
      String client,
      String os,
      String door,
      String mediaNode,
      long joinedAt,
      Long leftAt) {
    Row left(long at) {
      return new Row(
          id,
          roomId,
          roomCode,
          title,
          participantId,
          name,
          profileHash,
          ip,
          client,
          os,
          door,
          mediaNode,
          joinedAt,
          at);
    }
  }

  public record Page(List<Row> items, String next) {}

  /**
   * Что показать: встреча (номер или код), период входа, адрес (начало), страницы — по {@code
   * (joined_at, id)} назад.
   */
  public record Filter(
      String roomId,
      String roomCode,
      Long from,
      Long to,
      String ip,
      String cursor,
      Integer limit) {}

  public Participants(
      JdbcClient jdbc,
      TransactionTemplate tx,
      Clock clock,
      StreamProperties config,
      RoomRepository rooms,
      RetentionMeter retention) {
    this.jdbc = jdbc;
    this.tx = tx;
    this.clock = clock;
    this.config = config;
    this.rooms = rooms;
    this.retention = retention;
  }

  // ── Вход и выход ─────────────────────────────────────────────────────────────────────────────

  /**
   * Человек вошёл через дверь {@code door} ({@code create}, {@code link}, {@code code}, {@code
   * rejoin}, {@code saved}) — после фиксации входа. Повтор той же расписки (тот же участник, строка
   * ещё открыта) второй строки не даёт.
   */
  public void joined(
      String door, Contracts.Admission admission, String ip, String profileHash, ClientKind kind) {
    try {
      var snapshot = admission.snapshot();
      var participant = admission.participantId();
      String name =
          snapshot.participants().stream()
              .filter(p -> p.id().equals(participant))
              .map(Contracts.Participant::name)
              .findFirst()
              .orElse(null);
      var client = kind == null ? ClientKind.UNKNOWN : kind;
      var row =
          new Row(
              UUID.randomUUID().toString(),
              admission.roomId(),
              snapshot.code(),
              cut(snapshot.title(), 200),
              participant,
              cut(name, 64),
              profileHash,
              cut(ip, 64),
              client.client(),
              client.os(),
              cut(door, 8),
              cut(snapshot.mediaNode(), 64),
              clock.millis(),
              null);
      synchronized (lock) {
        var inRoom = open.computeIfAbsent(row.roomId(), k -> new HashMap<>());
        if (inRoom.containsKey(participant)) return;
        if (pending.size() >= BUFFER_LIMIT) {
          if (dropped++ % 1000 == 0)
            log.warn("Журнал участников: буфер полон ({} строк), входы теряются", pending.size());
          return;
        }
        inRoom.put(participant, row.id());
        pending.put(row.id(), row);
      }
    } catch (RuntimeException e) {
      log.warn("Журнал участников: вход не записан: {}", e.toString());
    }
  }

  @Override
  public void changed(RoomState room, String event, long now) {
    try {
      Set<String> tracked;
      synchronized (lock) {
        var inRoom = open.get(room.id);
        if (inRoom == null || inRoom.isEmpty()) return;
        tracked = Set.copyOf(inRoom.keySet());
      }
      var gone = new ArrayList<String>();
      for (var participant : tracked) {
        var member = room.members.get(participant);
        if (room.closedAt != null || member == null || !member.occupiesSeat())
          gone.add(participant);
      }
      if (gone.isEmpty()) return;
      var id = room.id;
      afterCommit(() -> left(id, gone, now));
    } catch (RuntimeException e) {
      // Журнал не роняет встречу: его отказ в транзакции комнаты откатил бы её саму.
      log.warn("Журнал участников: выход не учтён: {}", e.toString());
    }
  }

  @Override
  public void closed(RoomState room, String reason, long now) {
    try {
      var id = room.id;
      afterCommit(() -> left(id, null, now));
    } catch (RuntimeException e) {
      log.warn("Журнал участников: конец встречи не учтён: {}", e.toString());
    }
  }

  /** Вышли {@code participants} ({@code null} — все: встреча кончилась). */
  private void left(String roomId, Collection<String> participants, long at) {
    synchronized (lock) {
      var inRoom = open.get(roomId);
      if (inRoom == null) return;
      var who = participants == null ? List.copyOf(inRoom.keySet()) : participants;
      for (var participant : who) {
        var rowId = inRoom.remove(participant);
        if (rowId == null) continue;
        var row = pending.get(rowId);
        if (row != null) pending.put(rowId, row.left(at));
        else leaves.put(rowId, at);
      }
      if (inRoom.isEmpty()) open.remove(roomId);
    }
  }

  // ── Запись ───────────────────────────────────────────────────────────────────────────────────

  /** Записать буфер одной транзакцией; сколько строк записано и закрыто. */
  public int flush() {
    synchronized (flushing) {
      Map<String, Row> rows;
      Map<String, Long> closing;
      synchronized (lock) {
        if (pending.isEmpty() && leaves.isEmpty()) return 0;
        rows = pending;
        closing = leaves;
        pending = new LinkedHashMap<>();
        leaves = new LinkedHashMap<>();
      }
      try {
        tx.executeWithoutResult(
            status -> {
              for (var row : rows.values()) insert(row);
              for (var entry : closing.entrySet())
                jdbc.sql("UPDATE meeting_participants SET left_at=? WHERE id=? AND left_at IS NULL")
                    .params(entry.getValue(), entry.getKey())
                    .update();
            });
      } catch (RuntimeException e) {
        // База не приняла — всё обратно в буфер: следующий проход попробует снова. Выход,
        // случившийся
        // за это время, уже лежит в новом буфере и побеждает.
        synchronized (lock) {
          rows.forEach(pending::putIfAbsent);
          closing.forEach(leaves::putIfAbsent);
        }
        log.warn(
            "Журнал участников: база не приняла запись, повтор через проход: {}", e.toString());
        return 0;
      }
      return rows.size() + closing.size();
    }
  }

  private void insert(Row row) {
    jdbc.sql(
            "INSERT INTO meeting_participants(id,room_id,room_code,title,participant_id,"
                + "display_name,profile_hash,ip,client,os,door,media_node,joined_at,left_at)"
                + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .params(
            row.id(),
            row.roomId(),
            row.roomCode(),
            row.title(),
            row.participantId(),
            row.name(),
            row.profileHash(),
            row.ip(),
            row.client(),
            row.os(),
            row.door(),
            row.mediaNode(),
            row.joinedAt(),
            row.leftAt())
        .update();
  }

  /** Остановка ядра: дописать буфер. */
  @PreDestroy
  public void shutdown() {
    try {
      flush();
    } catch (RuntimeException e) {
      log.warn("Журнал участников: буфер при остановке не записан: {}", e.getMessage());
    }
  }

  /** Запуск: кто по журналу ещё во встречах — чтобы их выход записался и после перезапуска. */
  @EventListener(ApplicationReadyEvent.class)
  public void restore() {
    try {
      var rows =
          jdbc.sql(
                  "SELECT id, room_id, participant_id FROM meeting_participants WHERE left_at IS"
                      + " NULL")
              .query((rs, n) -> new String[] {rs.getString(1), rs.getString(2), rs.getString(3)})
              .list();
      synchronized (lock) {
        for (var row : rows)
          open.computeIfAbsent(row[1], k -> new HashMap<>()).putIfAbsent(row[2], row[0]);
      }
    } catch (RuntimeException e) {
      log.warn("Журнал участников: открытые строки не подняты: {}", e.toString());
    }
  }

  // ── Срок и сверка ────────────────────────────────────────────────────────────────────────────

  /**
   * Раз в пять минут ({@code ActivityRollup}): сверить открытые строки со встречами и забыть строки
   * старше срока метаданных. Сколько забыто.
   */
  public int sweep(long now) {
    // Закрытое сверкой уходит в базу следующим проходом буфера: здесь транзакция итогов, и сбой
    // записи журнала не должен откатывать их.
    reconcile(now);
    int forgotten =
        jdbc.sql("DELETE FROM meeting_participants WHERE joined_at<=?")
            .param(now - config.retention().metadata().toMillis())
            .update();
    retention.deleted("participant", forgotten);
    return forgotten;
  }

  /** Строки, чьих людей во встрече уже нет (или нет самой встречи), закрываются. */
  private void reconcile(long now) {
    Map<String, Set<String>> tracked = new HashMap<>();
    synchronized (lock) {
      open.forEach((room, inRoom) -> tracked.put(room, Set.copyOf(inRoom.keySet())));
    }
    for (var entry : tracked.entrySet()) {
      RoomState room;
      try {
        room = rooms.get(entry.getKey(), false);
      } catch (Problem missing) {
        left(entry.getKey(), null, now);
        continue;
      } catch (RuntimeException e) {
        continue;
      }
      if (room.closedAt != null) {
        left(room.id, null, room.closedAt);
        continue;
      }
      var gone = new ArrayList<String>();
      for (var participant : entry.getValue()) {
        var member = room.members.get(participant);
        if (member == null || !member.occupiesSeat()) gone.add(participant);
      }
      if (!gone.isEmpty()) left(room.id, gone, now);
    }
  }

  // ── Чтение ───────────────────────────────────────────────────────────────────────────────────

  public Page query(Filter filter) {
    flush();
    var where = new StringBuilder(" WHERE 1=1");
    var params = new ArrayList<Object>();
    if (filter.roomId() != null && filter.roomId().matches("[0-9a-f-]{36}")) {
      where.append(" AND room_id=?");
      params.add(filter.roomId());
    }
    if (filter.roomCode() != null && filter.roomCode().matches("[0-9]{9}")) {
      where.append(" AND room_code=?");
      params.add(filter.roomCode());
    }
    if (filter.from() != null) {
      where.append(" AND joined_at>=?");
      params.add(filter.from());
    }
    if (filter.to() != null) {
      where.append(" AND joined_at<?");
      params.add(filter.to());
    }
    if (filter.ip() != null && filter.ip().matches("[0-9A-Fa-f.:]{1,64}")) {
      where.append(" AND ip LIKE ?");
      params.add(filter.ip() + "%");
    }
    if (filter.cursor() != null && filter.cursor().matches("\\d{1,19}\\.[0-9a-f-]{36}")) {
      var parts = filter.cursor().split("\\.");
      long at = Long.parseLong(parts[0]);
      where.append(" AND (joined_at<? OR (joined_at=? AND id<?))");
      params.add(at);
      params.add(at);
      params.add(parts[1]);
    }
    int limit = Math.clamp(filter.limit() == null ? PAGE : filter.limit(), 1, 1000);
    var items =
        jdbc.sql(
                "SELECT * FROM meeting_participants"
                    + where
                    + " ORDER BY joined_at DESC, id DESC LIMIT "
                    + (limit + 1))
            .params(params)
            .query(Participants::map)
            .list();
    String next = null;
    if (items.size() > limit) {
      items = items.subList(0, limit);
      var last = items.getLast();
      next = last.joinedAt() + "." + last.id();
    }
    return new Page(items, next);
  }

  private static Row map(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
    return new Row(
        rs.getString("id"),
        rs.getString("room_id"),
        rs.getString("room_code"),
        rs.getString("title"),
        rs.getString("participant_id"),
        rs.getString("display_name"),
        rs.getString("profile_hash"),
        rs.getString("ip"),
        rs.getString("client"),
        rs.getString("os"),
        rs.getString("door"),
        rs.getString("media_node"),
        rs.getLong("joined_at"),
        rs.getObject("left_at", Long.class));
  }

  private static String cut(String value, int max) {
    return value == null ? null : value.substring(0, Math.min(max, value.length()));
  }

  /**
   * После фиксации транзакции комнаты; без транзакции — сразу. Отказ не доходит до того, кто менял
   * комнату.
   */
  private static void afterCommit(Runnable action) {
    Runnable safe =
        () -> {
          try {
            action.run();
          } catch (RuntimeException e) {
            log.warn("Журнал участников: перемена комнаты не учтена: {}", e.toString());
          }
        };
    if (TransactionSynchronizationManager.isSynchronizationActive())
      TransactionSynchronizationManager.registerSynchronization(
          new TransactionSynchronization() {
            @Override
            public void afterCommit() {
              safe.run();
            }
          });
    else safe.run();
  }
}
