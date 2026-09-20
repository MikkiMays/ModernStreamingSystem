package dev.mikki.stream.room;

import dev.mikki.stream.shared.Json;
import dev.mikki.stream.shared.Problem;
import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class RoomRepository {
  private final JdbcClient jdbc;

  public RoomRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public void lockGlobal() {
    jdbc.sql("SELECT id FROM system_lock WHERE id=1 FOR UPDATE").query(Integer.class).single();
  }

  public RoomState get(String id, boolean lock) {
    return jdbc.sql("SELECT state FROM rooms WHERE id=:id" + (lock ? " FOR UPDATE" : ""))
        .param("id", id)
        .query(String.class)
        .optional()
        .map(s -> Json.read(s, RoomState.class))
        .orElseThrow(() -> new Problem(404, "ROOM_NOT_FOUND", "Комната не найдена"));
  }

  public void insert(RoomState room, long now) {
    jdbc.sql("INSERT INTO rooms(id,state,updated_at,room_code,last_seen_at) VALUES(?,?,?,?,?)")
        .params(room.id, Json.write(room), now, room.code, room.lastSeenAt(now))
        .update();
  }

  public void save(RoomState room, long now) {
    jdbc.sql("UPDATE rooms SET state=?, updated_at=?, room_code=?, last_seen_at=? WHERE id=?")
        .params(Json.write(room), now, room.code, room.lastSeenAt(now), room.id)
        .update();
  }

  public List<RoomState> all() {
    return jdbc.sql("SELECT state FROM rooms").query(String.class).list().stream()
        .map(s -> Json.read(s, RoomState.class))
        .toList();
  }

  /**
   * Только идентификаторы.
   *
   * <p>Проход сроков ходит по комнатам раз в секунду и каждую всё равно перечитывает под замком —
   * разбирать ради списка снимок каждой из них значит разобрать его дважды. На тридцати комнатах
   * это тридцать лишних разборов JSON в секунду, и самый большой снимок здесь — пятьдесят килобайт.
   */
  public List<String> ids() {
    return jdbc.sql("SELECT id FROM rooms").query(String.class).list();
  }

  /**
   * Поправить отметку последнего входа, не трогая снимок.
   *
   * <p>{@code <>} в условии — не украшение: без него запуск переписывал бы каждую комнату, а
   * приводить в порядок нужно только те, у которых значение разошлось. Обычно это ноль строк.
   */
  public void touch(String roomId, long lastSeenAt) {
    jdbc.sql("UPDATE rooms SET last_seen_at=? WHERE id=? AND last_seen_at<>?")
        .params(lastSeenAt, roomId, lastSeenAt)
        .update();
  }

  public String roomForCode(String code) {
    return jdbc.sql("SELECT id FROM rooms WHERE room_code=?")
        .param(code)
        .query(String.class)
        .optional()
        .orElseThrow(() -> new Problem(404, "CODE_INVALID", "Проверьте код встречи"));
  }

  public boolean codeExists(String code) {
    return jdbc.sql("SELECT COUNT(*) FROM rooms WHERE room_code=?")
            .param(code)
            .query(Long.class)
            .single()
        > 0;
  }

  public JdbcClient jdbc() {
    return jdbc;
  }

  public boolean saved(String roomId) {
    return jdbc.sql("SELECT COUNT(*) FROM favorites WHERE room_id=?")
            .param(roomId)
            .query(Long.class)
            .single()
        > 0;
  }
}
