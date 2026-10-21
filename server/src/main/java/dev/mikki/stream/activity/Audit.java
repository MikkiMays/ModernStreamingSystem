package dev.mikki.stream.activity;

import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.room.RoomObserver;
import dev.mikki.stream.room.RoomState;
import dev.mikki.stream.shared.Json;
import java.time.Clock;
import java.util.*;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Журнал аудита: кто что сделал во встрече и на сервере ({@code docs/observability.md} §10).
 *
 * <p>ЧТО ПИШЕТСЯ. Действия — перечисление: создание и завершение встречи, входы и отказы во входе,
 * исключение участника ведущим, вход владельца и его рычаги, блоки и автоблоки, крупные загрузки.
 * Подробности ({@code details}) — только перечислимые поля и числа: вид, причина, размер.
 *
 * <p>ЧЕГО НЕТ И НЕ БУДЕТ (П8). Текста сообщений, имён и содержимого файлов, ссылок и названий
 * кинозала и музыки, названий встреч, ходов игр. Адрес — только отпечатком ({@code
 * Secrets.address}), профиль — хэшем. Имя участника — на момент события и на срок журнала ({@code
 * stream.retention.audit}): по нему владелец разбирает жалобу.
 *
 * <p>Пишется в транзакции того, кто зовёт: откатился вход — откатилась и строка о нём.
 */
@Component
public class Audit implements RoomObserver {
  /** Сколько строк отдаётся за раз на странице «Активность». */
  public static final int PAGE = 100;

  private final JdbcClient jdbc;
  private final StreamProperties config;
  private final Clock clock;

  public Audit(JdbcClient jdbc, StreamProperties config, Clock clock) {
    this.jdbc = jdbc;
    this.config = config;
    this.clock = clock;
  }

  /** Строка журнала до записи. Изменяемая — собирается по шагам там, где известны подробности. */
  public static final class Entry {
    private final String action;
    private String outcome = "ok";
    private String code;
    private String roomId;
    private String roomCode;
    private String targetId;
    private String actorKind = "system";
    private String actorId;
    private String actorName;
    private String ipHash;
    private String profileHash;
    private final Map<String, Object> details = new LinkedHashMap<>();

    private Entry(String action) {
      this.action = action;
    }

    public static Entry of(String action) {
      return new Entry(action);
    }

    public Entry denied(String code) {
      this.outcome = "denied";
      this.code = code;
      return this;
    }

    public Entry room(String id, String code) {
      this.roomId = id;
      this.roomCode = code;
      return this;
    }

    public Entry room(RoomState room) {
      return room(room.id, room.code);
    }

    public Entry target(String id) {
      this.targetId = id;
      return this;
    }

    public Entry actor(String kind, String id, String name) {
      this.actorKind = kind;
      this.actorId = id;
      this.actorName = name == null ? null : name.substring(0, Math.min(64, name.length()));
      return this;
    }

    public Entry from(String ipHash, String profileHash) {
      this.ipHash = ipHash;
      this.profileHash = profileHash;
      return this;
    }

    public Entry detail(String key, Object value) {
      if (value != null) details.put(key, value);
      return this;
    }
  }

  /** Строка журнала, как её видит страница «Активность». */
  public record Event(
      long id,
      long at,
      String action,
      String outcome,
      String code,
      String roomId,
      String roomCode,
      String targetId,
      String actorKind,
      String actorId,
      String actorName,
      String ipHash,
      String profileHash,
      Map<String, Object> details) {}

  public record Page(List<Event> items, String next) {}

  /**
   * Что показать: период, группа действий ({@code room}, {@code participant}, {@code admin}, {@code
   * block}, …), код встречи, исход, отпечаток адреса; страницы — по {@code (at, id)} назад.
   */
  public record Filter(
      Long from,
      Long to,
      String group,
      String roomCode,
      String outcome,
      String ipHash,
      String roomId,
      String cursor,
      Integer limit) {}

  public void record(Entry e) {
    long now = clock.millis();
    var details = e.details.isEmpty() ? null : Json.write(e.details);
    // Подробности — перечислимые поля и числа, им тысячи знаков хватает с запасом; обрезанный JSON
    // не прочитался бы, поэтому вместо обрезка — пометка.
    if (details != null && details.length() > 1000) details = "{\"truncated\":true}";
    jdbc.sql(
            "INSERT INTO audit_events(happened_at,expires_at,action,outcome,code,room_id,room_code,"
                + "target_id,actor_kind,actor_id,actor_name,ip_hash,profile_hash,details)"
                + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .params(
            now,
            now + config.retention().audit().toMillis(),
            e.action,
            e.outcome,
            e.code,
            e.roomId,
            e.roomCode,
            e.targetId,
            e.actorKind,
            e.actorId,
            e.actorName,
            e.ipHash,
            e.profileHash,
            details)
        .update();
  }

  public Page query(Filter filter) {
    var where = new StringBuilder(" WHERE 1=1");
    var params = new ArrayList<Object>();
    if (filter.from() != null) {
      where.append(" AND happened_at>=?");
      params.add(filter.from());
    }
    if (filter.to() != null) {
      where.append(" AND happened_at<?");
      params.add(filter.to());
    }
    if (filter.group() != null && filter.group().matches("[a-z]{2,16}")) {
      where.append(" AND action LIKE ?");
      params.add(filter.group() + ".%");
    }
    if (filter.roomCode() != null && filter.roomCode().matches("[0-9]{9}")) {
      where.append(" AND room_code=?");
      params.add(filter.roomCode());
    }
    if (filter.roomId() != null && filter.roomId().matches("[0-9a-f-]{36}")) {
      where.append(" AND room_id=?");
      params.add(filter.roomId());
    }
    if (filter.outcome() != null && filter.outcome().matches("ok|denied|error")) {
      where.append(" AND outcome=?");
      params.add(filter.outcome());
    }
    if (filter.ipHash() != null && filter.ipHash().matches("[A-Za-z0-9_-]{6,64}")) {
      where.append(" AND ip_hash LIKE ?");
      params.add(filter.ipHash() + "%");
    }
    if (filter.cursor() != null && filter.cursor().matches("\\d{1,19}\\.\\d{1,19}")) {
      var parts = filter.cursor().split("\\.");
      where.append(" AND (happened_at<? OR (happened_at=? AND id<?))");
      long at = Long.parseLong(parts[0]);
      params.add(at);
      params.add(at);
      params.add(Long.parseLong(parts[1]));
    }
    int limit = Math.clamp(filter.limit() == null ? PAGE : filter.limit(), 1, 1000);
    var items =
        jdbc.sql(
                "SELECT * FROM audit_events"
                    + where
                    + " ORDER BY happened_at DESC, id DESC LIMIT "
                    + (limit + 1))
            .params(params)
            .query(this::map)
            .list();
    String next = null;
    if (items.size() > limit) {
      items = items.subList(0, limit);
      var last = items.getLast();
      next = last.at() + "." + last.id();
    }
    return new Page(items, next);
  }

  /** Последний вход этого участника — отпечатки, по которым его можно заблокировать. */
  public Optional<Event> lastJoin(String roomId, String memberId) {
    return jdbc.sql(
            "SELECT * FROM audit_events WHERE room_id=? AND target_id=? AND outcome='ok' AND"
                + " action IN ('participant.joined','room.created') ORDER BY happened_at DESC, id"
                + " DESC LIMIT 1")
        .params(roomId, memberId)
        .query(this::map)
        .optional();
  }

  /** Сколько входов и отказов во входе было за промежуток — для итогов дня. */
  public long[] joins(long from, long to) {
    return jdbc.sql(
            "SELECT SUM(CASE WHEN outcome='ok' THEN 1 ELSE 0 END), SUM(CASE WHEN outcome='ok' THEN"
                + " 0 ELSE 1 END) FROM audit_events WHERE action IN"
                + " ('participant.joined','room.created') AND happened_at>=? AND happened_at<?")
        .params(from, to)
        .query((rs, i) -> new long[] {rs.getLong(1), rs.getLong(2)})
        .single();
  }

  public int sweep(long now) {
    return jdbc.sql("DELETE FROM audit_events WHERE expires_at<=?").param(now).update();
  }

  @Override
  public void closed(RoomState room, String reason, long now) {
    record(
        Entry.of("room.closed")
            .room(room)
            .actor(
                "server".equals(reason) ? "admin" : "host".equals(reason) ? "host" : "system",
                null,
                null)
            .detail("reason", reason)
            .detail(
                "seconds",
                room.startedAt == null ? null : Math.max(0, (now - room.startedAt) / 1000)));
  }

  @Override
  public void acted(
      RoomState room, RoomState.Member actor, String action, RoomState.Member target, long now) {
    record(
        Entry.of(action)
            .room(room)
            .actor("host", actor.id, actor.name)
            .target(target.id)
            .detail("targetName", target.name));
  }

  @SuppressWarnings("unchecked")
  private Event map(java.sql.ResultSet rs, int row) throws java.sql.SQLException {
    var details = rs.getString("details");
    return new Event(
        rs.getLong("id"),
        rs.getLong("happened_at"),
        rs.getString("action"),
        rs.getString("outcome"),
        rs.getString("code"),
        rs.getString("room_id"),
        rs.getString("room_code"),
        rs.getString("target_id"),
        rs.getString("actor_kind"),
        rs.getString("actor_id"),
        rs.getString("actor_name"),
        rs.getString("ip_hash"),
        rs.getString("profile_hash"),
        details == null ? Map.of() : Json.read(details, Map.class));
  }
}
