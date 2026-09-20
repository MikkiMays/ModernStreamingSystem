package dev.mikki.stream.room;

import static dev.mikki.stream.room.RoomState.Status.*;

import dev.mikki.stream.config.StreamProperties;
import java.util.Objects;
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

  /**
   * Просроченное в общих таблицах — один раз за проход, а не на каждую комнату.
   *
   * <p>Раньше эти три удаления стояли внутри {@link #sweepRoom}, и порог у них общий для всего
   * сервера: комната в условии не участвует. То есть на тридцати комнатах база получала девяносто
   * одинаковых запросов в секунду вместо трёх, и двадцать девять из каждых тридцати заведомо ничего
   * не находили.
   */
  @Transactional
  public void sweepLedger() {
    long now = service.now();
    rooms
        .jdbc()
        .sql("DELETE FROM messages WHERE created_at<=? OR expires_at<=?")
        .params(now - config.retention().messages().toMillis(), now)
        .update();
    rooms.jdbc().sql("DELETE FROM room_events WHERE expires_at<=?").param(now).update();
    rooms.jdbc().sql("DELETE FROM command_receipts WHERE expires_at<=?").param(now).update();
  }

  @Transactional
  public void sweepRoom(String id) {
    var room = service.lock(id);
    long now = service.now();
    boolean changed = false;
    // Отдельно от `changed`: не всякая правка состояния — новость для участников. Истёкшее
    // приглашение видно только серверу, и рассылать ради него `room.changed` незачем — а вот
    // сохранить надо, иначе следующий проход вычистит его заново, и так каждую секунду.
    boolean dirty = false;
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
    if (room.invites.values().removeIf(i -> i.expiresAt() <= now)) dirty = true;
    /*
     Все разошлись — гасим и то, что играло.

     Комната не закрывается сразу: ей отведены минуты на «я сейчас вернусь», и всё это время
     кино продолжало идти в пустом зале. Никто его не видел, но сервер тянул сегменты, а
     вернувшийся попадал в середину чужого фильма вместо своей встречи. Служебные участники
     здесь не считаются: музыкальный бот — это не зритель, и оставаться ради него не для кого
     (он и сам уходит, не услышав людей минуту).

     Место для восстановления связи уже учтено: пока человек переподключается, он занимает
     место, и до «никого нет» дело не доходит.
    */
    boolean watched =
        room.members.values().stream().anyMatch(m -> m.service == null && m.occupiesSeat());
    if (room.watch != null && !watched) {
      room.watch = null;
      changed = true;
    }
    if (room.closedAt == null) {
      boolean occupied = room.members.values().stream().anyMatch(RoomState.Member::occupiesSeat);
      var emptyBefore = room.emptySince;
      if (occupied) room.emptySince = null;
      else if (room.emptySince == null) room.emptySince = now;
      if (!Objects.equals(emptyBefore, room.emptySince)) dirty = true;
      if (!occupied
          && ((!room.everConnected && now - room.createdAt >= config.unusedRoomSeconds() * 1000L)
              || (room.everConnected
                  && room.emptySince != null
                  && now - room.emptySince >= config.emptyRoomSeconds() * 1000L))) {
        service.close(room);
        changed = true;
      }
    }
    if (changed) {
      service.emit(room, "room.changed", Contracts.EventPayload.changed());
      dirty = true;
    }
    // Записываем только когда есть что записать. Раньше строка стояла безусловно, и это
    // значило: каждая комната переписывается раз в секунду до конца своих дней. Тридцать
    // сохранённых комнат — это тридцать обновлений в секунду и мегабайт с лишним WAL,
    // вечно, при том что не менялось ничего. Заодно `updated_at` снова значит «менялась»,
    // а не «уборка проходила мимо».
    if (dirty) rooms.save(room, now);
    if (room.closedAt == null) return;
    /*
     Сколько завершённой встрече ещё жить — решает один вопрос: сохранил ли её себе хоть кто-то.

     НЕ СОХРАНИЛ НИКТО — держать не для кого, и она уходит вместе с разговором (по умолчанию
     `stream.retention.unsaved-room: immediately`). Раньше такая комната лежала ещё час, и
     единственным, кто об этом знал, был диск.

     СОХРАНИЛ ХОТЯ БЫ ОДИН — начинается отсчёт от последнего входа человека, а не от закрытия:
     пока во встречу заходят, она остаётся, сколько бы месяцев ей ни было. Неделя тишины — и
     она уходит у всех разом, потому что записи избранного стоят на `ON DELETE CASCADE`.
     Отдельного «убрать у всех» здесь нет и быть не должно: список избранного — это ссылки на
     комнату, а не её копии. Убрал последний из избранного — встреча снова несохранённая, и
     срок у неё соответствующий.

     История уходит своим сроком (`closed-history`) и не может пережить саму комнату: удаление
     встречи уносит переписку в том же проходе.
    */
    var keep = config.retention();
    long roomUntil =
        rooms.saved(id)
            ? room.lastSeenAt(now) + keep.savedRoom().toMillis()
            : room.closedAt + keep.unsavedRoom().toMillis();
    if (now < room.closedAt + keep.closedHistory().toMillis() && now < roomUntil) return;
    rooms.jdbc().sql("DELETE FROM room_events WHERE room_id=?").param(id).update();
    rooms.jdbc().sql("DELETE FROM messages WHERE room_id=?").param(id).update();
    rooms.jdbc().sql("DELETE FROM command_receipts WHERE room_id=?").param(id).update();
    // Вложения переживают комнату только физически: пока файл лежит на диске, строка о нём
    // нужна, иначе он станет ничьим. Минутный проход `AttachmentService` уносит просроченные
    // файлы сам, и комната уходит следующим заходом — позже, но без мусора на диске.
    if (now >= roomUntil
        && rooms
                .jdbc()
                .sql("SELECT COUNT(*) FROM attachments WHERE room_id=?")
                .param(id)
                .query(Long.class)
                .single()
            == 0) rooms.jdbc().sql("DELETE FROM rooms WHERE id=?").param(id).update();
  }
}
