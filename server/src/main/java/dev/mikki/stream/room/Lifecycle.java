package dev.mikki.stream.room;

import static dev.mikki.stream.room.RoomState.Status.*;

import dev.mikki.stream.config.StreamProperties;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class Lifecycle {
  private final RoomService service;
  private final RoomRepository rooms;
  private final StreamProperties config;

  public Lifecycle(RoomService service, RoomRepository rooms, StreamProperties config) {
    this.service = service;
    this.rooms = rooms;
    this.config = config;
  }

  @Transactional
  public void sweepRoom(String id) {
    var room = service.lock(id);
    long now = service.now();
    boolean changed = false;
    for (var m : room.members.values()) {
      if (m.mediaAllowed() && m.recoveryDeadline != null && now >= m.recoveryDeadline) {
        m.status = EXPIRED;
        m.generation++;
        m.recoveryDeadline = null;
        m.screen = false;
        changed = true;
      }
      if (m.status == WAITING && now - m.joinedAt >= config.unusedRoomSeconds() * 1000L) {
        m.status = EXPIRED;
        changed = true;
      }
    }
    rooms
        .jdbc()
        .sql("DELETE FROM messages WHERE room_id=? AND (created_at<=? OR expires_at<=?)")
        .params(id, now - config.retentionSeconds() * 1000L, now)
        .update();
    room.invites.values().removeIf(i -> i.expiresAt() <= now);
    if (room.closedAt == null) {
      boolean occupied = room.members.values().stream().anyMatch(RoomState.Member::occupiesSeat);
      if (occupied) room.emptySince = null;
      else if (room.emptySince == null) room.emptySince = now;
      if (!occupied
          && ((!room.everConnected && now - room.createdAt >= config.unusedRoomSeconds() * 1000L)
              || (room.everConnected
                  && room.emptySince != null
                  && now - room.emptySince >= config.emptyRoomSeconds() * 1000L))) {
        service.close(room);
        changed = true;
      }
    }
    if (changed) service.emit(room, "room.changed", Contracts.EventPayload.changed());
    rooms.save(room, now);
    rooms.jdbc().sql("DELETE FROM room_events WHERE expires_at<=?").param(now).update();
    rooms.jdbc().sql("DELETE FROM command_receipts WHERE expires_at<=?").param(now).update();
    if (room.closedAt != null && now >= room.closedAt + config.closedRetentionSeconds() * 1000L) {
      rooms.jdbc().sql("DELETE FROM room_events WHERE room_id=?").param(id).update();
      rooms.jdbc().sql("DELETE FROM messages WHERE room_id=?").param(id).update();
      rooms.jdbc().sql("DELETE FROM command_receipts WHERE room_id=?").param(id).update();
      if (rooms
                  .jdbc()
                  .sql("SELECT COUNT(*) FROM attachments WHERE room_id=?")
                  .param(id)
                  .query(Long.class)
                  .single()
              == 0
          && !rooms.saved(id)) rooms.jdbc().sql("DELETE FROM rooms WHERE id=?").param(id).update();
    }
  }
}
