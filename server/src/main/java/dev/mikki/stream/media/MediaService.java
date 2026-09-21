package dev.mikki.stream.media;

import static dev.mikki.stream.room.RoomState.Status.*;

import com.auth0.jwt.JWT;
import com.auth0.jwt.algorithms.Algorithm;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.room.*;
import dev.mikki.stream.shared.Problem;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class MediaService {
  private final RoomService rooms;
  private final RoomRepository repository;
  private final MediaGateway gateway;
  private final StreamProperties config;

  public MediaService(
      RoomService rooms, RoomRepository repository, MediaGateway gateway, StreamProperties config) {
    this.rooms = rooms;
    this.repository = repository;
    this.gateway = gateway;
    this.config = config;
  }

  public Contracts.MediaToken token(String id, String credential) {
    var room = rooms.read(id);
    var member = rooms.authenticate(room, credential);
    rooms.requireActive(room, member);
    return gateway.token(room, member);
  }

  @Transactional
  public Contracts.Ack screen(String id, String credential, UUID commandId, boolean enabled) {
    var room = rooms.lock(id);
    var member = rooms.authenticate(room, credential);
    rooms.requireActive(room, member);
    return rooms.receipt(
        "screen:" + id + ":" + member.id,
        commandId,
        enabled,
        Contracts.Ack.class,
        () -> {
          if (member.screen != enabled) {
            if (enabled
                && room.members.values().stream().filter(m -> m.screen && m.mediaAllowed()).count()
                    >= config.maxScreens())
              throw Problem.conflict("SCREEN_LIMIT", "Уже транслируются два экрана");
            gateway.permissions(id, member.id, enabled);
            member.screen = enabled;
            member.screenId = enabled ? UUID.randomUUID().toString() : null;
            member.screenStarted = false;
            member.firstViewer = false;
            rooms.emit(room, "room.changed", Contracts.EventPayload.changed());
            repository.save(room, rooms.now());
          }
          return new Contracts.Ack(commandId, true, room.sequence, member.screenId);
        });
  }

  /** Called only by Caddy on the private network for each external signaling handshake. */
  public void authorizeSignaling(String rawToken) {
    try {
      var jwt =
          JWT.require(Algorithm.HMAC256(config.livekitSecret()))
              .withIssuer(config.livekitKey())
              .build()
              .verify(rawToken);
      var grants = jwt.getClaim("video").asMap();
      if (grants == null || !Boolean.TRUE.equals(grants.get("roomJoin"))) throw Problem.forbidden();
      var room = rooms.read((String) grants.get("room"));
      var member = room.members.get(jwt.getSubject());
      if (member == null) throw Problem.forbidden();
      rooms.requireActive(room, member);
      var sources = grants.get("canPublishSources");
      if (!(sources instanceof List<?> requested)
          || !MediaGateway.sources(member.screen).containsAll(requested)) throw Problem.forbidden();
      if (Boolean.TRUE.equals(grants.get("roomAdmin"))
          || Boolean.TRUE.equals(grants.get("canPublishData"))) throw Problem.forbidden();
    } catch (Exception e) {
      throw Problem.forbidden();
    }
  }

  @Transactional
  public void webhook(
      String roomId, String participantId, String sid, String type, long occurredAt) {
    var room = rooms.lock(roomId);
    var member = room.members.get(participantId);
    if (member == null || !member.mediaAllowed() || occurredAt <= member.observedAt) return;
    if (member.recoveryDeadline != null && rooms.now() >= member.recoveryDeadline) return;
    if (type.equals("participant_joined")) {
      if (member.clientReportedLoss) return;
      member.status = CONNECTED;
      member.mediaSid = sid;
      member.generation++;
      member.recoveryDeadline = null;
      room.everConnected = true;
    } else if (type.equals("participant_left")
        && sid.equals(member.mediaSid)
        && member.status == CONNECTED) {
      member.status = RECOVERING;
      member.recoveryDeadline = rooms.now() + config.recoverySeconds() * 1000L;
    } else return;
    member.observedAt = occurredAt;
    rooms.emit(room, "room.changed", Contracts.EventPayload.changed());
    repository.save(room, rooms.now());
  }

  /** Reconcile publications from clients that predate the explicit screen.started command. */
  @Transactional
  public void screenObserved(String roomId, String participantId, String sid) {
    var room = rooms.lock(roomId);
    var member = room.members.get(participantId);
    if (room.closedAt != null
        || member == null
        || !member.mediaAllowed()
        || !member.screen
        || member.screenStarted
        || !java.util.Objects.equals(sid, member.mediaSid)) return;
    if (member.screenId == null) member.screenId = UUID.randomUUID().toString();
    member.screenStarted = true;
    rooms.emit(room, "screen.started", Contracts.EventPayload.screen(member.screenId, member.id));
    repository.save(room, rooms.now());
  }

  @Transactional
  public void observe(String roomId, Map<String, String> present, long observedAt) {
    var room = rooms.lock(roomId);
    boolean changed = false;
    if (room.closedAt != null && present.isEmpty()) room.mediaDrained = true;
    for (var member : room.members.values()) {
      if (observedAt <= member.observedAt) continue;
      member.observedAt = observedAt;
      if (member.mediaAllowed()) {
        if (member.recoveryDeadline != null && rooms.now() >= member.recoveryDeadline) {
          member.status = EXPIRED;
          member.screen = false;
          member.generation++;
          member.recoveryDeadline = null;
          changed = true;
        } else if (present.containsKey(member.id)) {
          /*
           МНЕНИЕ КЛИЕНТА О СВЯЗИ — НЕ ВЕЧНОЕ.

           `clientReportedLoss` существует потому, что браузер знает о своей связи больше, чем
           SFU: участник может числиться в комнате, а звук и картинка у него уже не идут. Но
           снимать этот флаг умел только сам браузер — и на телефоне с погашенным экраном это
           означало вот что: страница успела сказать «связь потерялась», и её заморозили. SFU
           всё это время видит участника на месте, а сказать «восстановилось» некому — через
           двадцать секунд человек выпадал из встречи, лежа в кармане с живым соединением.

           Поэтому у мнения есть срок: первую половину окна восстановления верим браузеру,
           дальше — тому, что видит SFU. Разговор в кармане продолжается, а настоящая потеря
           по-прежнему кончается выходом: участника, которого SFU не видит, никто не спасает.
          */
          boolean stale =
              member.recoveryDeadline != null
                  && rooms.now() > member.recoveryDeadline - config.recoverySeconds() * 500L;
          if (member.status != CONNECTED && (!member.clientReportedLoss || stale)) {
            member.status = CONNECTED;
            member.clientReportedLoss = false;
            member.recoveryDeadline = null;
            member.generation++;
            changed = true;
          }
          member.mediaSid = present.get(member.id);
          room.everConnected = true;
        } else if (member.status == CONNECTED) {
          member.status = RECOVERING;
          member.recoveryDeadline = rooms.now() + config.recoverySeconds() * 1000L;
          changed = true;
        }
      }
    }
    if (changed) rooms.emit(room, "room.changed", Contracts.EventPayload.changed());
    repository.save(room, rooms.now());
  }
}
