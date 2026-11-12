package dev.mikki.stream.media;

import static dev.mikki.stream.room.RoomState.Status.*;

import com.auth0.jwt.JWT;
import com.auth0.jwt.algorithms.Algorithm;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.nodes.LossReports;
import dev.mikki.stream.nodes.MediaNodes;
import dev.mikki.stream.room.*;
import dev.mikki.stream.shared.Problem;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class MediaService {
  private final RoomService rooms;
  private final RoomRepository repository;
  private final MediaGateway gateway;
  private final StreamProperties config;
  private final MediaNodes nodes;
  private final LossReports losses;
  private final TransactionTemplate tx;
  private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(MediaService.class);

  public MediaService(
      RoomService rooms,
      RoomRepository repository,
      MediaGateway gateway,
      StreamProperties config,
      MediaNodes nodes,
      LossReports losses,
      TransactionTemplate tx) {
    this.nodes = nodes;
    this.tx = tx;
    this.losses = losses;
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
    var room = rooms.lockFor(id, credential);
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
              throw Problem.conflict("SCREEN_LIMIT", "Экран уже показывает другой участник");
            gateway.permissions(room, member.id, enabled);
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
    authorizeSignaling(rawToken, null);
  }

  /**
   * {@code node} — узел, принявший сокет ({@code X-Media-Node} от его шлюза, R195): токен комнаты
   * открывает сигналинг только на узле этой комнаты. Пусто — шлюз старый или узел управления: тогда
   * проверяется, что комната и правда на узле управления.
   */
  public void authorizeSignaling(String rawToken, String node) {
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
      var expected = nodes.resolve(room.mediaNode).id();
      var actual = node == null || node.isBlank() ? nodes.control().id() : node;
      if (!expected.equals(actual)) throw Problem.forbidden();
      var sources = grants.get("canPublishSources");
      if (!(sources instanceof List<?> requested)
          || !MediaGateway.sources(member.screen).containsAll(requested)) throw Problem.forbidden();
      if (Boolean.TRUE.equals(grants.get("roomAdmin"))
          || Boolean.TRUE.equals(grants.get("canPublishData"))) throw Problem.forbidden();
    } catch (Exception e) {
      throw Problem.forbidden();
    }
  }

  /**
   * Узел умер (R195, {@code NodeHealth}): каждая открытая встреча этого узла переезжает на лучший
   * живой. Люди на связи помечаются {@code RECOVERING} с обычным окном восстановления — их медиа
   * пропало вместе с узлом, и клиенты в этом окне берут новый токен ({@code /token}) с адресом
   * нового узла. Ссылка, чат, права — не меняются. Мёртвый узел уже исключён из выбора, поэтому
   * {@code choose(null)} даст другой; если живых нет вовсе — комнаты остаются на месте.
   *
   * <p>Каждая комната — в своей транзакции через {@link #tx}: вызов {@link #moveRoom} изнутри бина
   * идёт мимо прокси, {@code @Transactional} там не сработал бы, и замок строки ({@code FOR
   * UPDATE}) отпускался бы сразу после чтения — вход или выход, пришедший во время переезда,
   * затирался бы сохранением переезда (или наоборот).
   */
  public void evacuate(String nodeId) {
    for (var candidate : repository.all()) {
      if (candidate.closedAt != null || !nodes.resolve(candidate.mediaNode).id().equals(nodeId))
        continue;
      var target = nodes.choose(null).node();
      if (target.id().equals(nodeId)) {
        log.warn("room {} stays on dead node {}: no other node is alive", candidate.id, nodeId);
        continue;
      }
      tx.executeWithoutResult(status -> moveRoom(candidate.id, nodeId, target.id()));
    }
  }

  /**
   * Люди узла по снимкам комнат (знаменатель правил отказа узла, {@code NodeHealth}, Р-105): на
   * связи и восстанавливающие связь — их медиа было на этом узле. Восстанавливающие — отдельно:
   * правило C считает только их, подсказка {@code media.stall} статуса не меняет.
   */
  public record People(Set<String> connected, Set<String> recovering) {
    public static final People NONE = new People(Set.of(), Set.of());

    public int size() {
      return connected.size() + recovering.size();
    }

    public boolean isEmpty() {
      return size() == 0;
    }

    public Set<String> all() {
      var all = new HashSet<String>(connected);
      all.addAll(recovering);
      return all;
    }
  }

  /** Люди узла {@code nodeId} в его открытых комнатах — {@link People}. */
  public People onNode(String nodeId) {
    var connected = new HashSet<String>();
    var recovering = new HashSet<String>();
    for (var room : repository.all()) {
      if (room.closedAt != null || !nodes.resolve(room.mediaNode).id().equals(nodeId)) continue;
      for (var member : room.members.values()) {
        if (!member.human()) continue;
        if (member.status == CONNECTED) connected.add(member.id);
        else if (member.status == RECOVERING) recovering.add(member.id);
      }
    }
    return new People(connected, recovering);
  }

  @Transactional
  public void moveRoom(String roomId, String from, String to) {
    var room = rooms.lock(roomId);
    if (room.closedAt != null || !nodes.resolve(room.mediaNode).id().equals(from)) return;
    reassign(room, from, to, "dead");
  }

  /**
   * Переназначить комнату на узел {@code to}: люди на связи — в {@code RECOVERING}, клиенты по
   * росту {@code mediaMoves} берут новый токен и приходят на новый узел ({@code session.ts
   * relocate}).
   */
  private void reassign(RoomState room, String from, String to, String why) {
    room.mediaNode = to;
    room.mediaMoves = (room.mediaMoves == null ? 0 : room.mediaMoves) + 1;
    long deadline = rooms.now() + config.recoverySeconds() * 1000L;
    for (var member : room.members.values())
      if (member.status == CONNECTED) {
        member.status = RECOVERING;
        member.recoveryDeadline = deadline;
        member.mediaSid = null;
      }
    log.warn("room {} moved from {} ({}) to {}", room.id, from, why, to);
    rooms.moved(room, from, to, why);
    rooms.emit(room, "room.changed", Contracts.EventPayload.changed());
    repository.save(room, rooms.now());
  }

  /** Не чаще раза в столько — ручной перевод встречи ({@code server-selection.md} §3.5). */
  public static final long MOVE_INTERVAL_MS = 60_000;

  /**
   * Создатель переводит встречу на другой узел руками (R200 §3.5, Р-104 — право {@code
   * Permissions.Action.MEDIA_MOVE}). Пока это тот же путь, что при смерти узла: переназначение и
   * восстановление у всех (разрыв в пару секунд, клиент говорит об этом честно); тёплый переезд без
   * разрыва — §4 проекта, он заменит {@link #reassign} при фазе {@code switch}. Проверки: узел
   * известен, принимает встречи, не полон; никто не в восстановлении; не чаще раза в минуту. Тот же
   * узел — ничего не делать, ответ успешный.
   */
  @Transactional
  public Contracts.Ack move(String id, String credential, UUID commandId, String to) {
    var room = rooms.lockFor(id, credential);
    var member = rooms.authenticate(room, credential);
    rooms.requireActive(room, member);
    Permissions.require(room, member, Permissions.Action.MEDIA_MOVE);
    return rooms.receipt(
        "media-move:" + id + ":" + member.id,
        commandId,
        to,
        Contracts.Ack.class,
        () -> {
          var from = nodes.resolve(room.mediaNode).id();
          if (from.equals(to)) return new Contracts.Ack(commandId, true, room.sequence, to);
          var target = nodes.available().stream().filter(n -> n.id().equals(to)).findFirst();
          if (target.isEmpty() || nodes.levelOf(target.get()).state().equals("full"))
            throw Problem.conflict("NODE_UNAVAILABLE", "Этот узел сейчас не принимает встречи");
          if (room.members.values().stream().anyMatch(m -> m.status == RECOVERING))
            throw Problem.conflict(
                "MEDIA_MOVE_BUSY", "Встреча восстанавливает связь — попробуйте через минуту");
          var now = rooms.now();
          if (room.mediaMovedAt != null && now - room.mediaMovedAt < MOVE_INTERVAL_MS)
            throw new Problem(
                429, "MEDIA_MOVE_RATE", "Переводить встречу можно не чаще раза в минуту");
          room.mediaMovedAt = now;
          reassign(room, from, to, "manual");
          return new Contracts.Ack(commandId, true, room.sequence, to);
        });
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
      // Вошёл в SFU заново — здоров: отметка беды (Р-105) снимается, даже если `media.restored`
      // не дошёл.
      losses.restored(member.id);
      member.status = CONNECTED;
      member.mediaSid = sid;
      member.generation++;
      member.recoveryDeadline = null;
      room.everConnected = true;
      // Второй человек на связи — встреча началась (T35); бот её не начинает.
      room.markStarted(rooms.now());
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

  /**
   * Сверка с SFU раз в две секунды: кто на связи по мнению узла.
   *
   * <p>ПИШЕТ ТОЛЬКО ИЗМЕНИВШЕЕСЯ. Раньше комната сохранялась на каждом проходе — и в простое ядро
   * переписывало каждую открытую комнату раз в две секунды, не изменив в ней ничего ({@code
   * docs/architecture/core-scale.md} §3.1). Теперь запись — только когда изменилось то, что комната
   * хранит: статус участника, номер его сессии SFU, «на связи хоть раз был», «медиа разошлось».
   * Отметка времени прохода ({@code observedAt}) сама по себе записи не стоит: она ложится вместе с
   * первым настоящим изменением и до тех пор живёт только в этом проходе.
   */
  @Transactional
  public void observe(String roomId, Map<String, String> present, long observedAt) {
    var room = rooms.lock(roomId);
    // `changed` — новость для участников (событие и запись); `dirty` — только запись.
    boolean changed = false;
    boolean dirty = false;
    if (room.closedAt != null && present.isEmpty() && !room.mediaDrained) {
      room.mediaDrained = true;
      dirty = true;
    }
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
            // Снова на связи по SFU — и для отказа узла (Р-105) он больше не в беде.
            losses.restored(member.id);
            member.status = CONNECTED;
            member.clientReportedLoss = false;
            member.recoveryDeadline = null;
            member.generation++;
            changed = true;
          }
          var sid = present.get(member.id);
          if (!java.util.Objects.equals(member.mediaSid, sid)) {
            member.mediaSid = sid;
            dirty = true;
          }
          if (!room.everConnected) {
            room.everConnected = true;
            dirty = true;
          }
        } else if (member.status == CONNECTED) {
          member.status = RECOVERING;
          member.recoveryDeadline = rooms.now() + config.recoverySeconds() * 1000L;
          changed = true;
        }
      }
    }
    // Здесь же встреча получает начало, если двое уже на связи — и тогда, когда они были на связи
    // ещё до образа ядра, который это начало ставит: метка появится на ближайшем проходе.
    if (room.markStarted(rooms.now())) changed = true;
    if (changed) {
      rooms.emit(room, "room.changed", Contracts.EventPayload.changed());
      dirty = true;
    }
    if (dirty) repository.save(room, rooms.now());
  }
}
