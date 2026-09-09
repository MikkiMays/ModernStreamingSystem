package dev.mikki.stream.room;

import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.shared.Problem;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class FavoriteService {
  public record Favorite(
      String roomId, String title, String code, long savedAt, boolean closed, boolean canJoin) {}

  private final RoomRepository repository;
  private final RoomService rooms;

  public FavoriteService(RoomRepository repository, RoomService rooms) {
    this.repository = repository;
    this.rooms = rooms;
  }

  private String key(String credential) {
    String value = credential.replaceFirst("^Bearer ", "");
    if (!value.matches("[A-Za-z0-9_-]{43}")) throw Problem.forbidden();
    return Secrets.hash(value);
  }

  public List<Favorite> list(String credential) {
    return repository
        .jdbc()
        .sql(
            "SELECT room_id,member_id,saved_at FROM favorites WHERE profile_hash=? ORDER BY saved_at DESC")
        .param(key(credential))
        .query(
            (rs, n) -> {
              var room = rooms.read(rs.getString("room_id"));
              var member = room.members.get(rs.getString("member_id"));
              return new Favorite(
                  room.id,
                  room.title,
                  room.code,
                  rs.getLong("saved_at"),
                  room.closedAt != null,
                  member != null && member.status != RoomState.Status.REMOVED);
            })
        .list();
  }

  @Transactional
  public void save(String profile, String roomId, String roomCredential) {
    repository.lockGlobal();
    var key = key(profile);
    var room = rooms.lock(roomId);
    var member = rooms.authenticate(room, roomCredential);
    if (!rooms.historyAllowed(room, member)) throw Problem.forbidden();
    if (repository
            .jdbc()
            .sql("SELECT COUNT(*) FROM favorites WHERE profile_hash=? AND room_id=?")
            .params(key, roomId)
            .query(Long.class)
            .single()
        > 0) return;
    if (repository
            .jdbc()
            .sql("SELECT COUNT(*) FROM favorites WHERE profile_hash=?")
            .param(key)
            .query(Long.class)
            .single()
        >= 5)
      throw Problem.conflict(
          "FAVORITE_LIMIT", "В избранном уже пять комнат. Удалите одну, чтобы добавить новую.");
    repository
        .jdbc()
        .sql("INSERT INTO favorites(profile_hash,room_id,member_id,saved_at) VALUES(?,?,?,?)")
        .params(key, roomId, member.id, rooms.now())
        .update();
  }

  @Transactional
  public void remove(String credential, String roomId) {
    repository.lockGlobal();
    repository
        .jdbc()
        .sql("DELETE FROM favorites WHERE profile_hash=? AND room_id=?")
        .params(key(credential), roomId)
        .update();
  }

  @Transactional
  public Contracts.Admission join(String credential, String roomId, Contracts.Rejoin request) {
    repository.lockGlobal();
    var memberId =
        repository
            .jdbc()
            .sql("SELECT member_id FROM favorites WHERE profile_hash=? AND room_id=?")
            .params(key(credential), roomId)
            .query(String.class)
            .optional()
            .orElseThrow(Problem::forbidden);
    // Receipt scope belongs to the stable profile, independent of the replaced media identity.
    return rooms.receipt(
        "favorite:" + roomId + ":" + key(credential),
        request.commandId(),
        request,
        Contracts.Admission.class,
        () -> rooms.joinSaved(roomId, memberId, request));
  }
}
