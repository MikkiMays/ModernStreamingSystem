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
            "SELECT room_id,member_id,saved_at FROM favorites WHERE profile_hash=? ORDER BY sort_order, saved_at DESC, room_id")
        .param(key(credential))
        .query(
            (rs, n) -> {
              var room = rooms.read(rs.getString("room_id"));
              var member = room.members.get(rs.getString("member_id"));
              // Исключённый участник тоже может вернуться: `participant.remove` заканчивает
              // встречу, а не знакомство с комнатой. Пусто здесь бывает по другой причине —
              // запись об участнике не пережила срок хранения комнаты.
              return new Favorite(
                  room.id,
                  room.title,
                  room.code,
                  rs.getLong("saved_at"),
                  room.closedAt != null,
                  member != null);
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
    // Числа комнат в избранном здесь нет намеренно. Это список на **своём** сервере, и его
    // длина — дело хозяина сервера, а не приложения: пять записей по паре десятков байт не
    // экономят ничего, зато «удалите одну, чтобы добавить новую» стоило человеку выбора.
    long first =
        repository
            .jdbc()
            .sql("SELECT COALESCE(MIN(sort_order), 0) FROM favorites WHERE profile_hash=?")
            .param(key)
            .query(Long.class)
            .single();
    repository
        .jdbc()
        .sql(
            "INSERT INTO favorites(profile_hash,room_id,member_id,saved_at,sort_order) VALUES(?,?,?,?,?)")
        .params(key, roomId, member.id, rooms.now(), first - 1)
        .update();
  }

  @Transactional
  public void reorder(String credential, List<String> roomIds) {
    var profile = key(credential);
    if (roomIds == null
        || roomIds.stream().anyMatch(Objects::isNull)
        || new HashSet<>(roomIds).size() != roomIds.size()) {
      throw new Problem(400, "FAVORITE_ORDER_INVALID", "Комнаты в списке не должны повторяться");
    }
    // Save/remove share the global lock; row locks also serialize cascade deletion on expiry.
    repository.lockGlobal();
    var current =
        repository
            .jdbc()
            .sql("SELECT room_id FROM favorites WHERE profile_hash=? ORDER BY room_id FOR UPDATE")
            .param(profile)
            .query(String.class)
            .list();
    if (!new HashSet<>(current).equals(new HashSet<>(roomIds))) {
      throw Problem.conflict("FAVORITES_CHANGED", "Список комнат изменился. Обновите избранное");
    }
    for (int position = 0; position < roomIds.size(); position++) {
      int updated =
          repository
              .jdbc()
              .sql("UPDATE favorites SET sort_order=? WHERE profile_hash=? AND room_id=?")
              .params(position, profile, roomIds.get(position))
              .update();
      if (updated != 1)
        throw Problem.conflict("FAVORITES_CHANGED", "Список комнат изменился. Обновите избранное");
    }
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
