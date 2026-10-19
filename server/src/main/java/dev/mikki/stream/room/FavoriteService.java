package dev.mikki.stream.room;

import dev.mikki.stream.access.Entrant;
import dev.mikki.stream.access.Identity;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Problem;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class FavoriteService {
  public record Favorite(
      String roomId,
      String title,
      String code,
      long savedAt,
      boolean closed,
      boolean canJoin,
      String groupId,
      boolean pinned,
      String alias) {}

  private final RoomRepository repository;
  private final RoomService rooms;
  private final StreamProperties config;

  public FavoriteService(RoomRepository repository, RoomService rooms, StreamProperties config) {
    this.repository = repository;
    this.rooms = rooms;
    this.config = config;
  }

  /**
   * Профиль избранного — тот же секрет устройства, что {@code X-Cord-Profile}, и тот же хэш
   * ({@link Identity}). Не private: группы ({@code FavoriteGroupService}) должны узнавать профиль
   * ровно тем же ключом.
   */
  String key(String credential) {
    var hash = Identity.profileHash(credential.replaceFirst("^Bearer ", ""));
    if (hash == null) throw Problem.forbidden();
    return hash;
  }

  public List<Favorite> list(String credential) {
    return repository
        .jdbc()
        // Группа читается через JOIN, а не прямо из group_id: ссылка на исчезнувшую группу
        // должна вернуться пустой, иначе комната пропала бы из всех списков сразу.
        .sql(
            """
            SELECT f.room_id,f.member_id,f.saved_at,g.id AS group_id,f.pinned,f.alias
            FROM favorites f
            LEFT JOIN favorite_groups g ON g.profile_hash=f.profile_hash AND g.id=f.group_id
            WHERE f.profile_hash=? ORDER BY f.sort_order, f.saved_at DESC, f.room_id""")
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
                  member != null,
                  rs.getString("group_id"),
                  rs.getBoolean("pinned"),
                  rs.getString("alias"));
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
    /*
     Десять комнат на профиль — решение владельца (T06, П3), и число живёт в настройках сервера
     (`stream.favorites.max-saved`), а не здесь.

     Считается под тем же общим замком, что и запись: двенадцать одновременных «сохранить»
     проходят по очереди, и одиннадцатая видит десять. Уже сохранённое сверх предела — например,
     до того, как предел появился, — не удаляется: отказ получает только новое, пока список не
     станет короче. Ответ несёт само число, чтобы интерфейс сказал «10 из 10», не зашивая его, а
     текст отказа — те же слова, что подсказка у звезды на главной (E02).
    */
    int max = config.favorites().maxSaved();
    if (repository
            .jdbc()
            .sql("SELECT COUNT(*) FROM favorites WHERE profile_hash=?")
            .param(key)
            .query(Long.class)
            .single()
        >= max)
      throw new Problem(
          409,
          "FAVORITES_FULL",
          "В избранном уже " + max + " " + roomsWord(max) + ". Уберите одну, чтобы добавить эту",
          Map.of("max", max));
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

  /** «комната», «комнаты», «комнат» — предел настраивается, и слово должно согласоваться с числом. */
  static String roomsWord(int count) {
    int tens = count % 100, ones = count % 10;
    if (tens >= 11 && tens <= 14) return "комнат";
    if (ones == 1) return "комната";
    if (ones >= 2 && ones <= 4) return "комнаты";
    return "комнат";
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

  /** Без профиля входящего — для служб и тестов; транзакция своя, как у соседней двери. */
  @Transactional
  public Contracts.Admission join(String credential, String roomId, Contracts.Rejoin request) {
    return join(credential, roomId, request, Entrant.UNKNOWN);
  }

  /**
   * Войти в сохранённую встречу. Профиль избранного здесь — ключ к записи, а одна активная встреча
   * (T52) решается по {@code X-Cord-Profile} входящего, как в любой другой двери: служба, входящая
   * от имени Telegram-беседы своим профилем избранного, этого заголовка не присылает.
   */
  @Transactional
  public Contracts.Admission join(
      String credential, String roomId, Contracts.Rejoin request, Entrant entrant) {
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
        () -> rooms.joinSaved(roomId, memberId, request, entrant));
  }
}
