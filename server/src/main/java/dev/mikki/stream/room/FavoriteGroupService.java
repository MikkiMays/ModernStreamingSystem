package dev.mikki.stream.room;

import dev.mikki.stream.shared.Problem;
import java.time.Clock;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Группы избранного и личные пометки комнаты (T40): группа, закрепление, своё имя.
 *
 * <p>Всё здесь — личное дело профиля: другой человек не видит ни групп, ни чужих имён комнат, даже
 * если та же комната лежит и у него. Поэтому ключ — тот же хэш профиля, что у избранного, а комната
 * в группе — это поле записи избранного, а не отдельная связь.
 */
@Service
public class FavoriteGroupService {
  /**
   * Предел — ради списка, а не ради базы: больше десяти групп уже не помогают найти комнату, а
   * прячут её. Переименование под предел не попадает: оно ничего не добавляет.
   */
  public static final int MAX_GROUPS = 10;

  /** Самое длинное название группы и своё имя комнаты — по ширине строки списка. */
  public static final int MAX_TITLE = 60;

  public record Group(String id, String title) {}

  private final RoomRepository repository;
  private final FavoriteService favorites;
  private final Clock clock;

  public FavoriteGroupService(RoomRepository repository, FavoriteService favorites, Clock clock) {
    this.repository = repository;
    this.favorites = favorites;
    this.clock = clock;
  }

  public List<Group> list(String credential) {
    return repository
        .jdbc()
        .sql(
            "SELECT id,title FROM favorite_groups WHERE profile_hash=? ORDER BY sort_order, created_at, id")
        .param(favorites.key(credential))
        .query((rs, n) -> new Group(rs.getString("id"), rs.getString("title")))
        .list();
  }

  /** Создаёт группу в конце списка или переименовывает существующую с тем же id. */
  @Transactional
  public void put(String credential, String groupId, String title) {
    var profile = favorites.key(credential);
    var name = text(title);
    if (name == null) throw invalid();
    repository.lockGlobal();
    if (repository
            .jdbc()
            .sql("UPDATE favorite_groups SET title=? WHERE profile_hash=? AND id=?")
            .params(name, profile, groupId)
            .update()
        == 1) return;
    if (repository
            .jdbc()
            .sql("SELECT COUNT(*) FROM favorite_groups WHERE profile_hash=?")
            .param(profile)
            .query(Long.class)
            .single()
        >= MAX_GROUPS) {
      throw Problem.conflict(
          "FAVORITE_GROUPS_FULL", "Групп не больше десяти. Удалите лишнюю, чтобы создать новую");
    }
    long last =
        repository
            .jdbc()
            .sql("SELECT COALESCE(MAX(sort_order), -1) FROM favorite_groups WHERE profile_hash=?")
            .param(profile)
            .query(Long.class)
            .single();
    repository
        .jdbc()
        .sql(
            "INSERT INTO favorite_groups(profile_hash,id,title,sort_order,created_at) VALUES(?,?,?,?,?)")
        .params(profile, groupId, name, last + 1, clock.millis())
        .update();
  }

  /**
   * Удаляет группу, а её комнаты возвращает в общий список. Повторное удаление — не ошибка: второй
   * щелчок или повтор запроса после обрыва связи должны кончаться тем же, что и первый.
   */
  @Transactional
  public void remove(String credential, String groupId) {
    var profile = favorites.key(credential);
    repository.lockGlobal();
    repository
        .jdbc()
        .sql("DELETE FROM favorite_groups WHERE profile_hash=? AND id=?")
        .params(profile, groupId)
        .update();
    repository
        .jdbc()
        .sql("UPDATE favorites SET group_id=NULL WHERE profile_hash=? AND group_id=?")
        .params(profile, groupId)
        .update();
  }

  /** Тот же порядок действий, что у {@link FavoriteService#reorder}: всё или ничего. */
  @Transactional
  public void reorder(String credential, List<String> groupIds) {
    var profile = favorites.key(credential);
    if (groupIds == null
        || groupIds.stream().anyMatch(Objects::isNull)
        || new HashSet<>(groupIds).size() != groupIds.size()) {
      throw new Problem(
          400, "FAVORITE_GROUP_ORDER_INVALID", "Группы в списке не должны повторяться");
    }
    repository.lockGlobal();
    var current =
        repository
            .jdbc()
            .sql("SELECT id FROM favorite_groups WHERE profile_hash=? ORDER BY id FOR UPDATE")
            .param(profile)
            .query(String.class)
            .list();
    // Порядок, собранный по устаревшему списку, молча потерял бы группу, созданную в другой
    // вкладке, — пусть клиент перечитает и повторит.
    if (!new HashSet<>(current).equals(new HashSet<>(groupIds))) throw changed();
    for (int position = 0; position < groupIds.size(); position++) {
      int updated =
          repository
              .jdbc()
              .sql("UPDATE favorite_groups SET sort_order=? WHERE profile_hash=? AND id=?")
              .params(position, profile, groupIds.get(position))
              .update();
      if (updated != 1) throw changed();
    }
  }

  /**
   * Заменяет целиком группу, закрепление и своё имя комнаты. Целиком, а не по одному полю: тогда
   * повтор запроса ничего не портит, а клиенту не нужно отличать «не трогать» от «очистить».
   */
  @Transactional
  public void settings(
      String credential, String roomId, String groupId, boolean pinned, String alias) {
    var profile = favorites.key(credential);
    var name = text(alias);
    repository.lockGlobal();
    if (repository
            .jdbc()
            .sql("SELECT COUNT(*) FROM favorites WHERE profile_hash=? AND room_id=?")
            .params(profile, roomId)
            .query(Long.class)
            .single()
        == 0) {
      throw new Problem(404, "FAVORITE_MISSING", "Комнаты нет в избранном");
    }
    if (groupId != null
        && repository
                .jdbc()
                .sql("SELECT COUNT(*) FROM favorite_groups WHERE profile_hash=? AND id=?")
                .params(profile, groupId)
                .query(Long.class)
                .single()
            == 0) {
      throw Problem.conflict(
          "FAVORITE_GROUP_MISSING", "Такой группы больше нет. Обновите избранное");
    }
    repository
        .jdbc()
        .sql(
            "UPDATE favorites SET group_id=?, pinned=?, alias=? WHERE profile_hash=? AND room_id=?")
        .params(groupId, pinned, name, profile, roomId)
        .update();
  }

  /**
   * Пробелы по краям не часть имени; пустое после обрезки — это «имени нет». Длина проверяется и
   * здесь: службу зовут не только из контроллера.
   */
  private static String text(String value) {
    if (value == null || value.isBlank()) return null;
    var stripped = value.strip();
    if (stripped.length() > MAX_TITLE) throw invalid();
    return stripped;
  }

  private static Problem invalid() {
    return new Problem(400, "INVALID_REQUEST", "Проверьте данные запроса");
  }

  private static Problem changed() {
    return Problem.conflict("FAVORITE_GROUPS_CHANGED", "Группы изменились. Обновите избранное");
  }
}
