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
    jdbc.sql("INSERT INTO rooms(id,state,updated_at,room_code) VALUES(?,?,?,?)")
        .params(room.id, Json.write(room), now, room.code)
        .update();
  }

  public void save(RoomState room, long now) {
    jdbc.sql("UPDATE rooms SET state=?, updated_at=?, room_code=? WHERE id=?")
        .params(Json.write(room), now, room.code, room.id)
        .update();
  }

  public List<RoomState> all() {
    return jdbc.sql("SELECT state FROM rooms").query(String.class).list().stream()
        .map(s -> Json.read(s, RoomState.class))
        .toList();
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
