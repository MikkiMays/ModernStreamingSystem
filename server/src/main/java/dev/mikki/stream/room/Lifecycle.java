package dev.mikki.stream.room;

import static dev.mikki.stream.room.RoomState.Status.*;

import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Problem;
import java.util.Objects;
import java.util.Optional;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class Lifecycle {
  private final RoomService service;
  private final RoomRepository rooms;
  private final StreamProperties config;
  private final GameClock games;
  private final ApplicationEventPublisher events;

  /**
   * С какого момента этот экземпляр ядра работает.
   *
   * <p>Нужно ровно одному правилу — сроку пустого стола. Простой, случившийся, пока ядро лежало,
   * человеку не принадлежит: вернуться за стол в это время было некуда, и засчитывать эти минуты в
   * десять, после которых игра заканчивается, нечестно.
   */
  private volatile long startedAt;

  public Lifecycle(
      RoomService service,
      RoomRepository rooms,
      StreamProperties config,
      GameClock games,
      ApplicationEventPublisher events) {
    this.service = service;
    this.rooms = rooms;
    this.config = config;
    this.games = games;
    this.events = events;
  }

  @org.springframework.context.event.EventListener(
      org.springframework.boot.context.event.ApplicationReadyEvent.class)
  public void started() {
    startedAt = service.now();
  }

  /** То же, когда события запуска не было: первый проход уборки и есть начало. */
  private long startedAt(long now) {
    if (startedAt == 0) startedAt = now;
    return startedAt;
  }

  /**
   * Двинуть стол, у которого вышел срок: кончился ход, доигрался борд, прошла пауза.
   *
   * <p>Отдельно от секундного прохода и намеренно дёшево: комната читается только тогда, когда её
   * срок действительно настал ({@link GameClock}).
   */
  @Transactional
  public void advanceGame(String roomId) {
    RoomState room;
    try {
      room = service.lock(roomId);
    } catch (Problem missing) {
      games.forget(roomId);
      return;
    }
    if (room.poker == null && room.durak == null && room.chess == null && room.gartic == null) {
      games.forget(roomId);
      return;
    }
    long now = service.now();
    boolean moved = room.poker != null && room.poker.tick(now);
    if (room.durak != null && room.durak.tick(now)) moved = true;
    if (room.chess != null && room.chess.tick(now)) moved = true;
    if (room.gartic != null && room.gartic.tick(now)) moved = true;
    games.schedule(roomId, RoomService.gameDeadline(room));
    if (!moved) return;
    service.emit(room, "room.changed", Contracts.EventPayload.changed());
    rooms.save(room, now);
    events.publishEvent(new RoomChanged(roomId));
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
    /*
     Стол переживает уход всех дольше, чем кино, но не навсегда.

     Кино в пустом зале тянет сегменты с площадки, и гасить его надо сразу. Стол не делает
     ничего: это фишки, лежащие в снимке комнаты. А выйти всем на минуту — обычное дело («я за
     чаем»), и разобрать из-за этого игру с чужими стеками было бы куда хуже. Поэтому у пустого
     стола свой срок — десять минут, — и только по нему игра заканчивается сама.

     Что здесь делается кроме срока: стол узнаёт, кого из сидящих во встрече больше нет. За
     ушедшего он ходит сам — иначе один закрытый браузер держал бы круг все тридцать секунд.
    */
    if (room.poker != null) {
      var present =
          room.members.values().stream()
              .filter(m -> m.service == null && m.occupiesSeat())
              .map(m -> m.id)
              .collect(Collectors.toSet());
      if (room.poker.presence(present, now)) changed = true;
      // Раздающий закрыл вкладку — стол переходит тому, кто рядом, иначе раздать станет некому.
      if (room.poker.hostId != null && !present.contains(room.poker.hostId))
        heir(
                room,
                room.poker.seats.stream()
                    .filter(seat -> seat.taken() && present.contains(seat.memberId))
                    .map(seat -> seat.memberId))
            .ifPresent(
                heir -> {
                  if (!heir.equals(room.poker.hostId)) room.poker.host(heir);
                });
      if (room.poker.tick(now)) changed = true;
      /*
       Игра, которая кончилась сама, уходит в историю сразу — пока стол ещё на сцене.

       Победителя за столом видно, итоги открываются тут же, и это единственный момент, когда
       записать игру можно, ничего не спрашивая: она уже сыграна, а стол ещё цел.
      */
      if ("over".equals(room.poker.phase) && !room.poker.archived) {
        RoomService.archiveGame(room, "winner", now);
        changed = true;
      }
      /*
       Стол, за которым никого.

       Раньше он стоял до конца встречи: люди вставали, уходили, возвращались через час — и
       заставали чужую игру на сцене. Теперь у пустого стола есть срок ({@code Table.LINGER_MS}),
       и до него на сцене видно, сколько осталось. Срок идёт только пока за столом по-настоящему
       никого (ни раздачи, ни присутствующего игрока) и сбрасывается в ноль в тот же миг, как
       кто-то сел или вернулся: случайно завершённая игра — это чужие стеки, которых не вернуть.
      */
      long idleBefore = room.poker.idleSince;
      boolean expired = room.poker.linger(now, startedAt(now));
      if (room.poker.idleSince != idleBefore) changed = true;
      if (expired) {
        RoomService.archiveGame(room, "idle", now);
        room.poker = null;
        games.forget(id);
        changed = true;
      }
    }
    /*
     Стол дурака — тот же срок и та же причина, что у покерного.

     Разница ровно одна: записывать нечего. Партия дурака кончается дураком, и всё, что от неё
     остаётся, люди видели своими глазами. Поэтому здесь нет ни `archiveGame`, ни проверки
     «кончилась ли игра сама»: конец партии виден на сцене и живёт там до следующей раздачи.
    */
    if (room.durak != null) {
      var present =
          room.members.values().stream()
              .filter(m -> m.service == null && m.occupiesSeat())
              .map(m -> m.id)
              .collect(Collectors.toSet());
      if (room.durak.presence(present, now)) changed = true;
      if (room.durak.hostId != null && !present.contains(room.durak.hostId))
        heir(
                room,
                room.durak.seats.stream()
                    .filter(seat -> seat.taken() && present.contains(seat.memberId))
                    .map(seat -> seat.memberId))
            .ifPresent(
                heir -> {
                  if (!heir.equals(room.durak.hostId)) room.durak.host(heir);
                });
      if (room.durak.tick(now)) changed = true;
      /*
       Доигранная партия уходит в историю сразу — пока стол ещё на сцене.

       Это единственный момент, когда записать её можно, ничего не спрашивая: дурак уже назван, а
       стол ещё цел. Следующая раздача снимет отметку, и запись будет своя.
      */
      if ("over".equals(room.durak.phase) && !room.durak.archived) {
        RoomService.archiveDurak(room, now);
        changed = true;
      }
      long idleBefore = room.durak.idleSince;
      boolean expired = room.durak.linger(now, startedAt(now));
      if (room.durak.idleSince != idleBefore) changed = true;
      if (expired) {
        room.durak = null;
        changed = true;
      }
    }
    if (room.chess != null || room.gartic != null) {
      var present =
          room.members.values().stream()
              .filter(m -> m.service == null && m.occupiesSeat())
              .map(m -> m.id)
              .collect(Collectors.toSet());
      var nextHost =
          room.members.values().stream()
              .filter(m -> m.service == null && m.mediaAllowed())
              .sorted(java.util.Comparator.comparing((RoomState.Member m) -> !m.owner))
              .map(m -> m.id)
              .findFirst()
              .orElse(null);
      if (room.chess != null) {
        if (room.chess.presence(present, now)) changed = true;
        if (nextHost != null && !present.contains(room.chess.hostId)) {
          room.chess.host(nextHost);
          changed = true;
        }
        if (room.chess.tick(now)) changed = true;
        long idle = room.chess.idleSince;
        boolean expired = room.chess.linger(now, startedAt(now));
        if (idle != room.chess.idleSince) changed = true;
        if (expired) {
          room.chess = null;
          changed = true;
        }
      }
      if (room.gartic != null) {
        if (room.gartic.presence(present, now)) changed = true;
        if (nextHost != null && !present.contains(room.gartic.hostId)) {
          room.gartic.host(nextHost);
          changed = true;
        }
        if (room.gartic.tick(now)) changed = true;
        long idle = room.gartic.idleSince;
        boolean expired = room.gartic.linger(now, startedAt(now));
        if (idle != room.gartic.idleSince) changed = true;
        if (expired) {
          room.gartic = null;
          changed = true;
        }
      }
    }
    if (room.poker == null && room.durak == null && room.chess == null && room.gartic == null)
      games.forget(id);
    else games.schedule(id, RoomService.gameDeadline(room));
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
    // Объявлять изменение имеет смысл только после записи: до неё снимок ещё прежний.
    if (changed) events.publishEvent(new RoomChanged(id));
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

  /**
   * Кому достаётся стол, чей ведущий ушёл: ведущему встречи, а если его нет — игроку за столом.
   *
   * <p>Раньше наследником мог быть только ведущий встречи. Встреча без него — обычное дело (позвал
   * друзей и вышел), и тогда стол оставался без хозяина: раздать, снять паузу или убрать его было
   * некому. С паузой это становилось тупиком навсегда — часы стоят, встать из-за стола на паузе
   * нельзя, а пустым стол не считается, пока партия идёт. Игрок за столом и так вправе сидеть и
   * ходить; право продолжить игру, которую он уже играет, — не больше этого.
   */
  private static Optional<String> heir(RoomState room, Stream<String> seated) {
    return room.members.values().stream()
        .filter(m -> m.owner && m.service == null && m.occupiesSeat())
        .map(m -> m.id)
        .findFirst()
        .or(() -> seated.findFirst());
  }
}
