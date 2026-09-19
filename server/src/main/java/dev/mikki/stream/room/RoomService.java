package dev.mikki.stream.room;

import static dev.mikki.stream.room.Contracts.*;
import static dev.mikki.stream.room.RoomState.Status.*;

import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Json;
import dev.mikki.stream.shared.Problem;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.*;
import java.util.function.Supplier;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class RoomService {
  private final RoomRepository rooms;
  private final StreamProperties config;
  private final Secrets secrets;
  private final Clock clock;
  private final SecureRandom codeRandom = new SecureRandom();

  public RoomService(RoomRepository rooms, StreamProperties config, Secrets secrets, Clock clock) {
    this.rooms = rooms;
    this.config = config;
    this.secrets = secrets;
    this.clock = clock;
  }

  public long now() {
    return clock.millis();
  }

  public RoomState read(String roomId) {
    return rooms.get(roomId, false);
  }

  public RoomState lock(String roomId) {
    return rooms.get(roomId, true);
  }

  @Transactional
  public Admission create(Create request) {
    rooms.lockGlobal();
    return receipt(
        "create",
        request.commandId(),
        request,
        Admission.class,
        () -> {
          if (!config.admissionOpen())
            throw new Problem(503, "DRAINING", "Сервер временно не принимает новые комнаты");
          if (rooms.all().stream()
                  .filter(
                      r ->
                          r.closedAt == null
                              && r.members.values().stream()
                                  .anyMatch(RoomState.Member::occupiesSeat))
                  .count()
              >= config.maxRooms())
            throw new Problem(429, "ROOM_LIMIT", "Все комнаты заняты. Попробуйте позже");
          var room = new RoomState();
          room.id = UUID.randomUUID().toString();
          room.code = newCode();
          room.title = request.title().strip();
          room.createdAt = now();
          room.approvalRequired = request.approvalRequired();
          room.integrationsAllowed = !Boolean.FALSE.equals(request.integrationsAllowed());
          var member = newMember(room, request.name(), true, request.commandId());
          var url = invite(room);
          rooms.insert(room, now());
          emit(room, "room.changed", EventPayload.changed());
          rooms.save(room, now());
          return admission(room, member, request.commandId(), url);
        });
  }

  private String newCode() {
    String code;
    do {
      code = String.format(Locale.ROOT, "%09d", codeRandom.nextInt(1_000_000_000));
    } while (rooms.codeExists(code));
    return code;
  }

  @org.springframework.context.event.EventListener(
      org.springframework.boot.context.event.ApplicationReadyEvent.class)
  @Transactional
  public void assignLegacyCodes() {
    rooms.lockGlobal();
    for (var old : rooms.all())
      if (old.code == null) {
        var room = lock(old.id);
        room.code = newCode();
        rooms.save(room, now());
      }
  }

  @Transactional
  public Admission joinCode(JoinCode request) {
    rooms.lockGlobal();
    var room = lock(rooms.roomForCode(request.code()));
    return receipt(
        "code:" + room.id,
        request.commandId(),
        request,
        Admission.class,
        () -> {
          requireOpen(room);
          checkSeat(room);
          var member = newMember(room, request.name(), false, request.commandId());
          // Код — такое же приглашение, как ссылка, и решает про них обоих одна настройка
          // комнаты. Раньше вход по коду ждал подтверждения **всегда**, и выбор «По ссылке и
          // коду — сразу» не значил ничего: правильный номер не открывал дверь, пока хозяин
          // не нажмёт кнопку. Теперь ждёт ровно тот, кого попросили подождать.
          member.codeRequest = !member.approved;
          room.emptySince = null;
          emit(room, "room.changed", EventPayload.changed());
          rooms.save(room, now());
          return admission(room, member, request.commandId(), null);
        });
  }

  @Transactional
  public Admission rejoin(String roomId, String credential, Rejoin request) {
    rooms.lockGlobal();
    var room = lock(roomId);
    var previous = authenticate(room, credential, true);
    return returnMember(room, previous, request, false);
  }

  @Transactional
  public Admission joinSaved(String roomId, String memberId, Rejoin request) {
    rooms.lockGlobal();
    var room = lock(roomId);
    var member = room.members.get(memberId);
    if (member == null || member.status == REMOVED) throw Problem.forbidden();
    return returnMember(room, member, request, true);
  }

  private Admission returnMember(
      RoomState room, RoomState.Member previous, Rejoin request, boolean saved) {
    return receipt(
        "rejoin:" + room.id + ":" + previous.id,
        request.commandId(),
        request,
        Admission.class,
        () -> {
          if (saved && room.closedAt != null) {
            freezeHistory(room, room.closedAt);
            room.closedAt = null;
            room.mediaDrained = false;
          }
          requireOpen(room);
          if (previous.replacedBy != null)
            throw Problem.conflict("SESSION_REPLACED", "Этот вход уже заменён новой сессией");
          // A fresh media identity fences late leave RPCs and old client callbacks.
          // The room, conversation and host rights survive an explicit return.
          var status = previous.status;
          previous.status = LEFT;
          checkSeat(room);
          var member = newMember(room, request.name(), previous.owner, request.commandId());
          member.codeRequest = previous.codeRequest;
          member.approved =
              previous.owner
                  || previous.approved
                  || (!previous.codeRequest && !room.approvalRequired && status != WAITING);
          member.status = member.approved ? JOINING : WAITING;
          member.recoveryDeadline = member.approved ? now() + config.joinSeconds() * 1000L : null;
          previous.owner = false;
          previous.replacedBy = member.id;
          previous.generation++;
          previous.screen = false;
          previous.recoveryDeadline = null;
          rooms
              .jdbc()
              .sql("UPDATE favorites SET member_id=? WHERE room_id=? AND member_id=?")
              .params(member.id, room.id, previous.id)
              .update();
          room.emptySince = null;
          emit(room, "room.changed", EventPayload.changed());
          rooms.save(room, now());
          return admission(room, member, request.commandId(), null);
        });
  }

  private void checkSeat(RoomState room) {
    if (!config.admissionOpen())
      throw new Problem(503, "DRAINING", "Сервер завершает действующие встречи");
    if (room.members.values().stream().noneMatch(RoomState.Member::occupiesSeat)
        && rooms.all().stream()
                .filter(
                    r ->
                        !r.id.equals(room.id)
                            && r.closedAt == null
                            && r.members.values().stream().anyMatch(RoomState.Member::occupiesSeat))
                .count()
            >= config.maxRooms())
      throw new Problem(429, "ROOM_LIMIT", "Все комнаты заняты. Попробуйте позже");
    if (room.members.values().stream().filter(RoomState.Member::occupiesSeat).count()
        >= config.maxParticipants())
      throw Problem.conflict("ROOM_FULL", "В комнате уже десять участников");
    if (room.members.size() >= 500) {
      var retained =
          new HashSet<>(
              rooms
                  .jdbc()
                  .sql("SELECT member_id FROM favorites WHERE room_id=?")
                  .param(room.id)
                  .query(String.class)
                  .list());
      room.members
          .values()
          .removeIf(
              m ->
                  !m.occupiesSeat()
                      && !retained.contains(m.id)
                      && now() - m.joinedAt > config.retentionSeconds() * 1000L);
    }
    if (room.members.size() >= 500)
      throw new Problem(429, "SESSION_LIMIT", "Достигнут лимит входов за время встречи");
  }

  @Transactional
  public Admission join(String roomId, Join request) {
    rooms.lockGlobal();
    var room = lock(roomId);
    return receipt(
        "join:" + roomId,
        request.commandId(),
        request,
        Admission.class,
        () -> {
          requireOpen(room);
          if (!config.admissionOpen())
            throw new Problem(503, "DRAINING", "Сервер завершает действующие встречи");
          var valid =
              room.invites.values().stream()
                  .anyMatch(
                      i ->
                          !i.revoked()
                              && i.expiresAt() > now()
                              && Secrets.equal(i.secretHash(), Secrets.hash(request.invite())));
          if (!valid) throw new Problem(403, "INVITE_INVALID", "Приглашение истекло или отозвано");
          checkSeat(room);
          var member = newMember(room, request.name(), false, request.commandId());
          room.emptySince = null;
          emit(room, "room.changed", EventPayload.changed());
          rooms.save(room, now());
          return admission(room, member, request.commandId(), null);
        });
  }

  @Transactional
  public String serviceInvite(String roomId) {
    var room = lock(roomId);
    requireOpen(room);
    var url = invite(room);
    emit(room, "room.changed", EventPayload.changed());
    rooms.save(room, now());
    return url;
  }

  /**
   * Название и режим входа встречи, которая уже идёт.
   *
   * <p>Ровно тот же порядок, что у настроек интеграций рядом: взять замок, узнать участника,
   * убедиться, что он ведущий и комната открыта, поменять, объявить. Объявление обязательно —
   * `room.changed` заставляет всех перечитать снимок, и без него новое название знал бы только тот,
   * кто его ввёл.
   */
  @Transactional
  public Snapshot roomSettings(String roomId, String credential, Contracts.RoomSettings settings) {
    var room = lock(roomId);
    var member = authenticate(room, credential);
    owner(member);
    requireOpen(room);
    // Проверка та же, что при создании: @NotBlank отсекает пустое и одни пробелы, @Size —
    // длину. Дублировать её здесь значило бы завести второе место, где она может разойтись.
    room.title = settings.title().strip();
    room.approvalRequired = settings.approvalRequired();
    emit(room, "room.changed", EventPayload.changed());
    rooms.save(room, now());
    return snapshotFor(room, member);
  }

  @Transactional
  public Snapshot integrationSettings(String roomId, String credential, boolean enabled) {
    var room = lock(roomId);
    var member = authenticate(room, credential);
    owner(member);
    requireOpen(room);
    room.integrationsAllowed = enabled;
    emit(room, "room.changed", EventPayload.changed());
    rooms.save(room, now());
    return snapshotFor(room, member);
  }

  /** Worker-only entry point; user authorization is checked before calling this internal API. */
  @Transactional
  public Admission addMusicService(String roomId, UUID commandId) {
    rooms.lockGlobal();
    var room = lock(roomId);
    requireOpen(room);
    return receipt(
        "service:" + roomId,
        commandId,
        "music",
        Admission.class,
        () -> {
          if (room.members.values().stream()
              .anyMatch(m -> "music".equals(m.service) && m.occupiesSeat()))
            throw Problem.conflict("SERVICE_EXISTS", "Музыкальный сервис уже подключён");
          // Та же граница с другой стороны: пока комната смотрит кино, музыке в ней места нет.
          if (room.watch != null)
            throw Problem.conflict(
                "INTEGRATION_BUSY", "Во встрече открыт кинозал. Сначала закройте его");
          checkSeat(room);
          var member = newMember(room, "Музыка", false, commandId);
          member.service = "music";
          member.approved = true;
          member.status = JOINING;
          member.recoveryDeadline = now() + config.joinSeconds() * 1000L;
          emit(room, "room.changed", EventPayload.changed());
          rooms.save(room, now());
          return admission(room, member, commandId, null);
        });
  }

  private RoomState.Member newMember(RoomState room, String name, boolean owner, UUID commandId) {
    var m = new RoomState.Member();
    m.id = UUID.randomUUID().toString();
    m.name = name.strip();
    m.owner = owner;
    m.joinedAt = now();
    m.status = (!owner && room.approvalRequired) ? WAITING : JOINING;
    m.approved = m.status == JOINING;
    m.recoveryDeadline = m.status == JOINING ? now() + config.joinSeconds() * 1000L : null;
    m.secretHash =
        Secrets.hash(secrets.derive("session:" + room.id + ":" + m.id + ":" + commandId));
    room.members.put(m.id, m);
    return m;
  }

  private Admission admission(
      RoomState room, RoomState.Member member, UUID commandId, String inviteUrl) {
    // Admission receipts must not duplicate older chat text beyond its own TTL.
    // The authenticated event channel sends the current message history immediately.
    var current = snapshotFor(room, member);
    var initial =
        new Snapshot(
            current.id(),
            current.title(),
            current.code(),
            current.createdAt(),
            current.closedAt(),
            current.sequence(),
            current.approvalRequired(),
            current.integrationsAllowed(),
            current.participants(),
            List.of(),
            current.serverTime(),
            current.watch());
    return new Admission(
        room.id,
        member.id,
        member.id + "." + secrets.derive("session:" + room.id + ":" + member.id + ":" + commandId),
        inviteUrl,
        config.recoverySeconds(),
        initial);
  }

  private String invite(RoomState room) {
    if (room.invites.size() >= 100)
      room.invites.values().removeIf(i -> i.revoked() || i.expiresAt() <= now());
    if (room.invites.size() >= 100)
      throw new Problem(429, "INVITE_LIMIT", "Слишком много приглашений");
    var id = UUID.randomUUID().toString();
    var token = secrets.derive("invite:" + room.id + ":" + id);
    room.invites.put(
        id,
        new RoomState.Invite(
            id, Secrets.hash(token), now(), now() + config.retentionSeconds() * 1000L, false));
    return config.publicUrl() + "/join/" + room.id + "#invite=" + token;
  }

  public RoomState.Member authenticate(RoomState room, String credential) {
    return authenticate(room, credential, false);
  }

  private RoomState.Member authenticate(RoomState room, String credential, boolean allowReplaced) {
    if (credential == null) throw Problem.forbidden();
    var parts = credential.replaceFirst("^Bearer ", "").split("\\.", 2);
    var member = parts.length == 2 ? room.members.get(parts[0]) : null;
    if (member == null
        || !Secrets.equal(member.secretHash, Secrets.hash(parts[1]))
        || (!allowReplaced && member.replacedBy != null)
        || member.status == REMOVED) throw Problem.forbidden();
    if (room.closedAt != null && now() >= room.closedAt + config.closedRetentionSeconds() * 1000L)
      throw new Problem(410, "HISTORY_EXPIRED", "История встречи удалена");
    return member;
  }

  public void requireActive(RoomState room, RoomState.Member member) {
    requireOpen(room);
    if (!member.mediaAllowed()
        || (member.recoveryDeadline != null && now() >= member.recoveryDeadline))
      throw new Problem(410, "SESSION_ENDED", "Сессия завершена. Войдите в комнату снова");
  }

  public void requireOpen(RoomState room) {
    if (room.closedAt != null) throw new Problem(410, "ROOM_CLOSED", "Встреча завершена");
  }

  public long expiry(long createdAt, RoomState room) {
    return Math.min(
        createdAt + config.retentionSeconds() * 1000L,
        room.closedAt == null
            ? Long.MAX_VALUE
            : room.closedAt + config.closedRetentionSeconds() * 1000L);
  }

  public Snapshot snapshot(RoomState room) {
    var participants =
        room.members.values().stream()
            .filter(m -> m.occupiesSeat())
            .map(
                m ->
                    new Participant(
                        m.id,
                        m.name,
                        m.avatar,
                        m.owner,
                        m.status,
                        m.generation,
                        m.recoveryDeadline,
                        m.screen,
                        m.service,
                        m.screenId,
                        m.screenStarted,
                        m.viewingScreenId))
            .toList();
    var messages =
        rooms
            .jdbc()
            .sql("SELECT * FROM messages WHERE room_id=? AND created_at>? ORDER BY created_at,id")
            .params(room.id, now() - config.retentionSeconds() * 1000L)
            .query(
                (rs, n) ->
                    new RoomState.Message(
                        rs.getString("id"),
                        rs.getString("participant_id"),
                        rs.getString("display_name"),
                        rs.getString("content"),
                        rs.getLong("created_at"),
                        Math.min(
                            expiry(rs.getLong("created_at"), room),
                            rs.getObject("expires_at") == null
                                ? Long.MAX_VALUE
                                : rs.getLong("expires_at"))))
            .list()
            .stream()
            .filter(m -> m.expiresAt() > now())
            .toList();
    return new Snapshot(
        room.id,
        room.title,
        room.code,
        room.createdAt,
        room.closedAt,
        room.sequence,
        room.approvalRequired,
        room.integrationsAllowed,
        participants,
        messages,
        now(),
        watch(room));
  }

  private static Contracts.Watch watch(RoomState room) {
    var watch = room.watch;
    return watch == null
        ? null
        : new Contracts.Watch(
            watch.provider,
            watch.kind,
            watch.contentId,
            watch.title,
            watch.openedBy,
            watch.paused,
            watch.positionMs,
            watch.anchorAt,
            watch.revision);
  }

  public Snapshot snapshot(String roomId, String credential) {
    var room = read(roomId);
    return snapshotFor(room, authenticate(room, credential));
  }

  public boolean historyAllowed(RoomState room, RoomState.Member member) {
    return member.owner
        || member.approved
        || (!member.codeRequest && !room.approvalRequired && member.status != WAITING);
  }

  private Snapshot snapshotFor(RoomState room, RoomState.Member member) {
    var current = snapshot(room);
    if (historyAllowed(room, member)) return current;
    return new Snapshot(
        current.id(),
        current.title(),
        current.code(),
        current.createdAt(),
        current.closedAt(),
        current.sequence(),
        current.approvalRequired(),
        current.integrationsAllowed(),
        current.participants().stream().filter(p -> p.id().equals(member.id)).toList(),
        List.of(),
        current.serverTime(),
        // Ожидающий в дверях ещё не во встрече: что комната смотрит — такая же её жизнь, как
        // переписка, и до разрешения войти он этого не видит.
        null);
  }

  @Transactional
  public Ack command(String roomId, String credential, Command command) {
    var room = lock(roomId);
    var member = authenticate(room, credential);
    return receipt(
        "command:" + roomId + ":" + member.id,
        command.commandId(),
        command,
        Ack.class,
        () -> {
          String value = null;
          switch (command.type()) {
            case "leave" -> {
              member.status = LEFT;
              member.generation++;
              member.screen = false;
              member.recoveryDeadline = null;
            }
            case "profile.avatar" -> {
              member.avatar = avatar(command.text());
              emit(room, "room.changed", EventPayload.changed());
            }
            case "close" -> {
              owner(member);
              close(room);
            }
            case "invite.create" -> {
              owner(member);
              requireOpen(room);
              value = invite(room);
            }
            case "invite.revoke" -> {
              owner(member);
              requireOpen(room);
              room.invites.replaceAll(
                  (id, i) ->
                      new RoomState.Invite(
                          i.id(), i.secretHash(), i.createdAt(), i.expiresAt(), true));
            }
            case "participant.remove", "participant.approve" -> {
              owner(member);
              requireOpen(room);
              var target = room.members.get(command.targetId());
              if (target == null || target.owner) throw Problem.forbidden();
              if (command.type().equals("participant.remove")) {
                target.status = REMOVED;
                target.screen = false;
                target.generation++;
                target.recoveryDeadline = null;
              } else if (target.status == WAITING) {
                target.approved = true;
                target.status = JOINING;
                target.recoveryDeadline = now() + config.joinSeconds() * 1000L;
              }
            }
            case "screen.started" -> {
              requireActive(room, member);
              if (!member.screen || !Objects.equals(member.screenId, command.targetId()))
                throw Problem.conflict("SCREEN_ENDED", "Демонстрация завершена");
              if (!member.screenStarted) {
                member.screenStarted = true;
                emit(room, "screen.started", EventPayload.screen(member.screenId, member.id));
              }
            }
            case "view.open", "view.playing" -> {
              requireActive(room, member);
              var presenter =
                  room.members.values().stream()
                      .filter(
                          m ->
                              m.mediaAllowed()
                                  && m.screen
                                  && m.screenStarted
                                  && m.screenId != null
                                  && m.screenId.equals(command.targetId()))
                      .findFirst()
                      .orElseThrow(
                          () -> Problem.conflict("SCREEN_ENDED", "Демонстрация завершена"));
              if (command.type().equals("view.open")) member.viewingScreenId = presenter.screenId;
              else {
                if (!Objects.equals(member.viewingScreenId, presenter.screenId))
                  throw Problem.conflict("VIEW_CLOSED", "Просмотр закрыт");
                if (!member.id.equals(presenter.id) && !presenter.firstViewer) {
                  presenter.firstViewer = true;
                  emit(
                      room,
                      "screen.first_viewer",
                      EventPayload.screen(presenter.screenId, presenter.id));
                }
              }
            }
            case "view.close" -> {
              requireActive(room, member);
              if (Objects.equals(member.viewingScreenId, command.targetId()))
                member.viewingScreenId = null;
            }
            /*
             Совместный просмотр. Ролик открывается на паузе в начале: пока комната его
             загружает, играть нечему, а «включить» — отдельное решение, которое принимает
             человек и слышат все сразу. Живой эфир открывается играющим: у него нет позиции,
             которую можно было бы поделить, и каждый смотрит собственный край трансляции.
            */
            case "watch.open" -> {
              requireActive(room, member);
              requireOpen(room);
              integrations(room, member);
              // Активная интеграция в комнате одна. Музыка и кинозал спорят за одно и то же —
              // за уши участников, — и «добавились обе» означает два звука разом, из которых
              // не выключить ни один.
              if (room.members.values().stream()
                  .anyMatch(m -> m.service != null && m.occupiesSeat()))
                throw Problem.conflict(
                    "INTEGRATION_BUSY",
                    "Во встрече уже есть другая интеграция. Сначала уберите её");
              if (command.provider() == null
                  || command.kind() == null
                  || command.contentId() == null
                  || command.contentId().isBlank())
                throw new Problem(400, "WATCH_INVALID", "Нечего открывать");
              var watch = new RoomState.Watch();
              watch.provider = command.provider();
              watch.kind = command.kind();
              watch.contentId = command.contentId();
              watch.title = label(command.text());
              watch.openedBy = member.id;
              watch.paused = watch.kind.equals("video");
              watch.positionMs = 0;
              watch.anchorAt = now();
              watch.revision = room.watch == null ? 1 : room.watch.revision + 1;
              room.watch = watch;
            }
            case "watch.play", "watch.pause", "watch.seek" -> {
              requireActive(room, member);
              requireOpen(room);
              var watch = room.watch;
              if (watch == null)
                throw Problem.conflict("WATCH_CLOSED", "Совместный просмотр закрыт");
              /*
               Пультом владеет тот, кто принёс видео, и ведущий. Остальным доступно другое:
               поставить своё вместо этого или закрыть — если комната разрешила интеграции.
               Иначе десять человек нажимают паузу одновременно и никто не смотрит.

               Ушедший пульта с собой не уносит: если открывшего в комнате больше нет, кино
               остаётся на паузе навсегда, и нажать её было бы некому. Осиротевший пульт
               достаётся тем, кому вообще можно трогать интеграции.
              */
              var opener = room.members.get(watch.openedBy);
              var orphaned = opener == null || !opener.occupiesSeat();
              if (orphaned) integrations(room, member);
              else if (!member.owner && !member.id.equals(watch.openedBy))
                throw Problem.forbidden();
              if (!"video".equals(watch.kind))
                throw Problem.conflict(
                    "WATCH_LIVE", "Живой эфир нельзя останавливать и перематывать");
              if (command.positionMs() != null) watch.positionMs = command.positionMs();
              if (command.type().equals("watch.play")) watch.paused = false;
              if (command.type().equals("watch.pause")) watch.paused = true;
              watch.anchorAt = now();
              watch.revision++;
            }
            case "watch.close" -> {
              requireActive(room, member);
              integrations(room, member);
              room.watch = null;
            }
            case "message.send" -> {
              requireActive(room, member);
              if (command.text() == null || command.text().isBlank())
                throw new Problem(400, "EMPTY_MESSAGE", "Введите сообщение");
              if (rooms
                      .jdbc()
                      .sql("SELECT COUNT(*) FROM messages WHERE room_id=?")
                      .param(room.id)
                      .query(Long.class)
                      .single()
                  >= 1000)
                throw new Problem(429, "MESSAGE_LIMIT", "Достигнут лимит сообщений комнаты");
              var msg =
                  new RoomState.Message(
                      UUID.randomUUID().toString(),
                      member.id,
                      member.name,
                      command.text().strip(),
                      now(),
                      expiry(now(), room));
              rooms
                  .jdbc()
                  .sql(
                      "INSERT INTO messages(id,room_id,participant_id,display_name,content,created_at) VALUES(?,?,?,?,?,?)")
                  .params(msg.id(), room.id, member.id, member.name, msg.text(), msg.createdAt())
                  .update();
              emit(room, "message.created", new EventPayload(msg));
            }
            case "media.lost" -> {
              requireActive(room, member);
              if (member.generation == command.generation() && member.status == CONNECTED) {
                member.status = RECOVERING;
                member.clientReportedLoss = true;
                member.recoveryDeadline = now() + config.recoverySeconds() * 1000L;
              }
            }
            case "media.restored" -> {
              requireActive(room, member);
              if (member.generation == command.generation()
                  && (member.status == RECOVERING || member.status == JOINING)) {
                member.status = CONNECTED;
                member.clientReportedLoss = false;
                member.recoveryDeadline = null;
                member.generation++;
                room.everConnected = true;
              }
            }
            default -> throw new Problem(400, "UNKNOWN_COMMAND", "Неизвестная команда");
          }
          emit(room, "room.changed", EventPayload.changed());
          rooms.save(room, now());
          return new Ack(command.commandId(), true, room.sequence, value);
        });
  }

  /** The room lock and receipt also serialize concurrent host requests and retries. */
  @Transactional
  public Ack muteMicrophone(String roomId, String credential, Command command, Runnable mute) {
    var room = lock(roomId);
    var member = authenticate(room, credential);
    owner(member);
    requireActive(room, member);
    var target = room.members.get(command.targetId());
    if (target == null || !target.mediaAllowed()) throw Problem.forbidden();
    return receipt(
        "command:" + roomId + ":" + member.id,
        command.commandId(),
        command,
        Ack.class,
        () -> {
          mute.run();
          return new Ack(command.commandId(), true, room.sequence, null);
        });
  }

  private void owner(RoomState.Member member) {
    if (!member.owner || !member.occupiesSeat()) throw Problem.forbidden();
  }

  /**
   * Кто может <b>принести</b> во встречу постороннее: ведущий всегда, остальные — если комната
   * разрешила интеграции всем. Тот же переключатель управляет ботами: заводить для просмотра второй
   * значило бы спросить дважды об одном и том же.
   *
   * <p>Управление уже открытым — отдельный вопрос и решается не здесь: пультом владеет тот, кто это
   * открыл.
   */
  private void integrations(RoomState room, RoomState.Member member) {
    if (!member.owner && !room.integrationsAllowed) throw Problem.forbidden();
  }

  /** Подпись к открытому ролику: без управляющих символов и не длиннее строки заголовка. */
  private static String label(String value) {
    if (value == null) return null;
    var text = value.replaceAll("\\p{Cntrl}", " ").strip();
    return text.isEmpty() ? null : text.substring(0, Math.min(120, text.length()));
  }

  /**
   * An avatar is shown to everyone in the room, so what arrives is checked rather than trusted.
   * Only a base64 data URI of a known image type is accepted, the payload must actually decode, and
   * the size is bounded well below the command's own limit so a picture can never become a way to
   * push bulk data through the snapshot. An empty value clears the picture.
   */
  private static String avatar(String value) {
    if (value == null || value.isBlank()) return null;
    var text = value.strip();
    var comma = text.indexOf(',');
    if (comma < 0 || text.length() > 3500)
      throw new Problem(400, "INVALID_AVATAR", "Не удалось прочитать картинку");
    var header = text.substring(0, comma);
    if (!header.equals("data:image/webp;base64")
        && !header.equals("data:image/png;base64")
        && !header.equals("data:image/jpeg;base64"))
      throw new Problem(400, "INVALID_AVATAR", "Не удалось прочитать картинку");
    try {
      var bytes = java.util.Base64.getDecoder().decode(text.substring(comma + 1));
      if (bytes.length == 0 || bytes.length > 2400)
        throw new Problem(400, "INVALID_AVATAR", "Не удалось прочитать картинку");
    } catch (IllegalArgumentException e) {
      throw new Problem(400, "INVALID_AVATAR", "Не удалось прочитать картинку");
    }
    return text;
  }

  public void close(RoomState room) {
    if (room.closedAt != null) return;
    room.closedAt = now();
    // Смотреть вместе больше некому: закрытая комната не должна открывать плеер тому, кто
    // зайдёт в неё за историей переписки.
    room.watch = null;
    freezeHistory(room, room.closedAt);
    room.members
        .values()
        .forEach(
            m -> {
              if (m.occupiesSeat()) m.status = LEFT;
              m.generation++;
              m.screen = false;
              m.recoveryDeadline = null;
            });
  }

  private void freezeHistory(RoomState room, long endedAt) {
    for (String table : List.of("messages", "attachments"))
      rooms
          .jdbc()
          .sql(
              "UPDATE "
                  + table
                  + " SET expires_at=LEAST(COALESCE(expires_at,created_at+?),?) WHERE room_id=? AND created_at<=?")
          .params(
              config.retentionSeconds() * 1000L,
              endedAt + config.closedRetentionSeconds() * 1000L,
              room.id,
              endedAt)
          .update();
  }

  public void emit(RoomState room, String type, EventPayload payload) {
    // Keep persisted view state valid after leave, timeout, removal or screen stop.
    for (var member : room.members.values()) {
      if (!member.screen || !member.mediaAllowed()) {
        member.screenId = null;
        member.screenStarted = false;
        member.firstViewer = false;
      }
      if (!member.mediaAllowed()
          || room.members.values().stream()
              .noneMatch(
                  p ->
                      p.screen
                          && p.mediaAllowed()
                          && p.screenId != null
                          && p.screenId.equals(member.viewingScreenId)))
        member.viewingScreenId = null;
    }
    var event = new Event(1, UUID.randomUUID().toString(), ++room.sequence, type, payload, now());
    rooms
        .jdbc()
        .sql("INSERT INTO room_events(room_id,sequence,body,expires_at) VALUES(?,?,?,?)")
        .params(room.id, event.sequence(), Json.write(event), now() + 3600000L)
        .update();
    rooms
        .jdbc()
        .sql("DELETE FROM room_events WHERE room_id=? AND sequence<=?")
        .params(room.id, room.sequence - config.eventHistoryLimit())
        .update();
  }

  public Replay replay(String roomId, String credential, long after) {
    var room = read(roomId);
    var member = authenticate(room, credential);
    if (!historyAllowed(room, member))
      return new Replay(true, snapshotFor(room, member), List.of());
    var events =
        rooms
            .jdbc()
            .sql(
                "SELECT body FROM room_events WHERE room_id=? AND sequence>? AND expires_at>? ORDER BY sequence")
            .params(roomId, after, now())
            .query(String.class)
            .list()
            .stream()
            .map(e -> Json.read(e, Event.class))
            .toList();
    if (after < 0
        || after > room.sequence
        || (!events.isEmpty() && events.getFirst().sequence() != after + 1)
        || (events.isEmpty() && after < room.sequence))
      return new Replay(true, snapshot(room), List.of());
    return new Replay(false, null, events);
  }

  public <T> T receipt(
      String scope, UUID commandId, Object request, Class<T> type, Supplier<T> action) {
    var fingerprint = Secrets.hash(Json.write(request));
    var prior =
        rooms
            .jdbc()
            .sql(
                "SELECT fingerprint,response FROM command_receipts WHERE scope=? AND command_id=? AND expires_at>?")
            .params(scope, commandId.toString(), now())
            .query((rs, n) -> new String[] {rs.getString(1), rs.getString(2)})
            .optional();
    if (prior.isPresent()) {
      if (!prior.get()[0].equals(fingerprint))
        throw Problem.conflict("COMMAND_REUSED", "Идентификатор команды уже использован");
      return Json.read(prior.get()[1], type);
    }
    var response = action.get();
    String roomId =
        response instanceof Admission admission
            ? admission.roomId()
            : Arrays.stream(scope.split(":"))
                .filter(s -> s.matches("[0-9a-f-]{36}"))
                .findFirst()
                .orElse(null);
    rooms
        .jdbc()
        .sql(
            "INSERT INTO command_receipts(scope,command_id,fingerprint,response,expires_at,room_id) VALUES(?,?,?,?,?,?)")
        .params(
            scope,
            commandId.toString(),
            fingerprint,
            Json.write(response),
            now() + config.retentionSeconds() * 1000L,
            roomId)
        .update();
    return response;
  }
}
