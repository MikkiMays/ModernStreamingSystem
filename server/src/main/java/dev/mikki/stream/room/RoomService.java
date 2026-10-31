package dev.mikki.stream.room;

import static dev.mikki.stream.room.Contracts.*;
import static dev.mikki.stream.room.RoomState.Status.*;

import dev.mikki.stream.access.Entrant;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.room.Permissions.Action;
import dev.mikki.stream.shared.Json;
import dev.mikki.stream.shared.Problem;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.*;
import java.util.function.Predicate;
import java.util.function.Supplier;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class RoomService {
  private final RoomRepository rooms;
  private final StreamProperties config;
  private final Secrets secrets;
  private final Clock clock;
  private final GameClock games;
  private final ApplicationEventPublisher events;
  private final RateLimits limits;
  private final List<RoomObserver> observers;
  private final Maintenance maintenance;
  private final SecureRandom codeRandom = new SecureRandom();

  /**
   * Последний номер события каждой комнаты, зафиксированный в базе этим процессом.
   *
   * <p>Секундный проход сокетов ({@code RoomSocket.catchUp}) сверяет с ним номер каждого сокета и
   * идёт в базу только за отставшими. Раньше каждый открытый сокет раз в секунду делал два запроса
   * (A13 модели угроз), и шестьсот сокетов одного ключа выбирали весь пул соединений.
   */
  private final Map<String, Long> sequences = new java.util.concurrent.ConcurrentHashMap<>();

  /** Когда показывающий в последний раз прислал кадр превью: ключ «комната:участник». */
  private final Map<String, Long> previewAt = new java.util.concurrent.ConcurrentHashMap<>();

  /** Чаще этого кадры превью не рассылаются. */
  public static final long PREVIEW_INTERVAL_MS = 2000;

  public RoomService(
      RoomRepository rooms,
      StreamProperties config,
      Secrets secrets,
      Clock clock,
      GameClock games,
      ApplicationEventPublisher events,
      RateLimits limits,
      List<RoomObserver> observers,
      Maintenance maintenance) {
    this.rooms = rooms;
    this.config = config;
    this.secrets = secrets;
    this.clock = clock;
    this.games = games;
    this.events = events;
    this.limits = limits;
    this.observers = List.copyOf(observers);
    this.maintenance = maintenance;
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

  /*
   Двери без профиля — для служб и тестов. Каждая помечена @Transactional сама: вызов соседнего
   метода изнутри бина мимо прокси транзакции не открывает, и общий замок без неё не держится.
  */
  @Transactional
  public Admission create(Create request) {
    return create(request, Entrant.UNKNOWN);
  }

  @Transactional
  public Admission create(Create request, Entrant entrant) {
    // Предел в час — до общего замка: пачка запросов скрипта получает отказ, не вставая в очередь
    // перед людьми (A1). Здесь только сверка, шаг счётчика — после удачи: отказ не съедает предел.
    var origin = origin(entrant);
    var address = entrant.address();
    var hour = config.abuse();
    if ((address != null && limits.exhausted("rooms:ip:" + address, hour.perIp().roomsCreated()))
        || (entrant.profileHash() != null
            && limits.exhausted(
                "rooms:profile:" + entrant.profileHash(), hour.perProfile().roomsCreated())))
      throw new Problem(
          429, "ROOMS_PER_HOUR", "Слишком много новых встреч за час. Попробуйте позже");
    rooms.lockGlobal();
    return receipt(
        "create",
        request.commandId(),
        request,
        Admission.class,
        () -> {
          if (!config.admissionOpen())
            throw new Problem(503, "DRAINING", "Сервер временно не принимает новые комнаты");
          // Дренаж перед выкаткой (W1b): новых встреч нет, идущие доигрывают, вход в них открыт.
          if (maintenance.on()) throw maintenance.refusal();
          var room = new RoomState();
          room.id = UUID.randomUUID().toString();
          // Здесь — до подсчёта слотов, а не после, как в остальных дверях: человек, который один
          // держит встречу и согласился из неё выйти, освобождает слот себе же. Откажет подсчёт —
          // выход откатится вместе со всем остальным.
          oneMeeting(room.id, entrant);
          var busy = rooms.all().stream().filter(r -> r.busy(now())).toList();
          if (busy.size() >= config.maxRooms())
            throw new Problem(429, "ROOM_LIMIT", "Все комнаты заняты. Попробуйте позже");
          openRooms(busy, origin, entrant.profileHash());
          room.code = newCode();
          room.title = Names.title(request.title());
          room.createdAt = now();
          room.approvalRequired = request.approvalRequired();
          room.integrationsAllowed = !Boolean.FALSE.equals(request.integrationsAllowed());
          room.createdFrom = origin;
          room.createdBy = entrant.profileHash();
          var member = newMember(room, request.name(), true, request.commandId(), entrant);
          var url = invite(room);
          rooms.insert(room, now());
          emit(room, "room.changed", EventPayload.changed());
          rooms.save(room, now());
          if (address != null) limits.hit("rooms:ip:" + address, hour.perIp().roomsCreated());
          if (entrant.profileHash() != null)
            limits.hit("rooms:profile:" + entrant.profileHash(), hour.perProfile().roomsCreated());
          return admission(room, member, request.commandId(), url);
        });
  }

  /**
   * Ключ адреса входящего, как его хранит комната: HMAC секретом сервера, а не сам адрес (П8). По
   * нему считается, сколько встреч с этого адреса сейчас открыто, и блокирует владелец сервера.
   */
  private String origin(Entrant entrant) {
    return secrets.address(entrant.address());
  }

  /**
   * Сколько встреч одного адреса и одного профиля одновременно занимают место на сервере (A1).
   *
   * <p>Без этого предела пять запросов с одного адреса раз в тридцать секунд держали все {@code
   * max-rooms} сервера: встреча считается, пока она моложе тридцати секунд, а скрипту ничего не
   * стоит создавать новые. Считается то же, что считает {@code max-rooms}, — {@link
   * RoomState#busy}.
   */
  private void openRooms(List<RoomState> all, String origin, String profile) {
    var abuse = config.abuse();
    // Встреча, из которой создатель уже ушёл и где никого нет, не считается, даже если она моложе
    // тридцати секунд: человек, передумавший и создавший новую, — не скрипт.
    var busy = all.stream().filter(r -> r.seatedHumans() > 0).toList();
    if (origin != null
        && busy.stream().filter(r -> origin.equals(r.createdFrom)).count()
            >= abuse.perIp().openRooms())
      throw new Problem(
          429, "OPEN_ROOMS", "С этого адреса уже идёт несколько встреч. Завершите одну из них");
    if (profile != null
        && busy.stream().filter(r -> profile.equals(r.createdBy)).count()
            >= abuse.perProfile().openRooms())
      throw new Problem(429, "OPEN_ROOMS", "У вас уже идут встречи. Завершите одну из них");
  }

  private String newCode() {
    String code;
    do {
      code = String.format(Locale.ROOT, "%09d", codeRandom.nextInt(1_000_000_000));
    } while (rooms.codeExists(code));
    return code;
  }

  /**
   * Что старым комнатам проставляется при запуске.
   *
   * <p>Код встречи — комнатам, заведённым до того, как коды появились. Отметка последнего входа —
   * всем: миграция не умеет считать её из снимка (одно и то же выражение должно работать и в
   * Postgres, и в H2 у тестов) и ставит туда {@code updated_at}, а он у комнаты, которую годами
   * переписывала уборка, означает «сегодня». Решения об удалении это не касается — их принимает
   * {@link Lifecycle} по свежему снимку, — но запрос «что скоро удалится» неделю показывал бы
   * пусто. Здесь столбец один раз приводится к тому, что говорит сам снимок.
   *
   * <p>Дальше он поддерживается сам: {@code save} пишет его при каждом изменении комнаты.
   */
  @org.springframework.context.event.EventListener(
      org.springframework.boot.context.event.ApplicationReadyEvent.class)
  @Transactional
  public void adoptLegacyRooms() {
    rooms.lockGlobal();
    for (var old : rooms.all())
      if (old.code == null) {
        var room = lock(old.id);
        room.code = newCode();
        rooms.save(room, now());
      } else rooms.touch(old.id, old.lastSeenAt(now()));
  }

  @Transactional
  public Admission joinCode(JoinCode request) {
    return joinCode(request, Entrant.UNKNOWN);
  }

  @Transactional
  public Admission joinCode(JoinCode request, Entrant entrant) {
    var address = entrant.address();
    if (address != null
        && limits.exhausted("code-miss:" + address, config.abuse().perIp().codeMisses()))
      throw new Problem(
          429,
          "CODE_MISSES",
          "Слишком много неверных кодов. Попробуйте позже или войдите по ссылке");
    // Код ищется до общего замка: перебор не встаёт в очередь перед теми, кто создаёт встречи и
    // входит по ссылке (A3). Замок берётся только под найденную комнату.
    var found = rooms.findForCode(request.code());
    if (found.isEmpty()) throw codeMiss(address);
    boolean shield = shielded();
    rooms.lockGlobal();
    var room = lock(found.get());
    // Завершённая встреча отвечает тем же, что и несуществующий код: иначе по разнице 410 и 404
    // перебором находились бы коды сохранённых встреч.
    if (room.closedAt != null) throw codeMiss(address);
    return receipt(
        "code:" + room.id,
        request.commandId(),
        request,
        Admission.class,
        () -> {
          requireOpen(room);
          checkDoor(room);
          oneMeeting(room.id, entrant);
          var member = newMember(room, request.name(), false, request.commandId(), entrant);
          // «Щит»: пока сервер отбивается от перебора, верный код ведёт к двери ведущего, а не
          // внутрь. Угаданный код тогда ничего не даёт без согласия того, кто во встрече.
          if (shield && member.approved) {
            member.approved = false;
            member.status = WAITING;
            member.recoveryDeadline = null;
          }
          // Код — такое же приглашение, как ссылка, и решает про них обоих одна настройка
          // комнаты. Раньше вход по коду ждал подтверждения **всегда**, и выбор «По ссылке и
          // коду — сразу» не значил ничего: правильный номер не открывал дверь, пока хозяин
          // не нажмёт кнопку. Теперь ждёт ровно тот, кого попросили подождать.
          member.codeRequest = !member.approved;
          seat(room, member, entrant.address());
          room.emptySince = null;
          emit(room, "room.changed", EventPayload.changed());
          rooms.save(room, now());
          return admission(room, member, request.commandId(), null);
        });
  }

  /** Ключ серверного счётчика промахов кодом — по нему включается «щит» (A3). */
  private static final String SERVER_MISSES = "code-miss:server";

  /**
   * Промах кодом: шаг счётчиков адреса и сервера и один и тот же ответ на «нет такого кода» и
   * «встреча завершена».
   */
  private Problem codeMiss(String address) {
    var abuse = config.abuse();
    if (address != null) limits.hit("code-miss:" + address, abuse.perIp().codeMisses());
    limits.hit(SERVER_MISSES, abuse.server().codeMisses());
    return new Problem(404, "CODE_INVALID", "Проверьте код встречи");
  }

  /**
   * Включён ли «щит»: промахов кодом по всему серверу больше {@code abuse.server.code-misses}. Пока
   * он включён, вход по коду идёт через допуск ведущего, а задача «не бот» дороже.
   */
  public boolean shielded() {
    return limits.exhausted(SERVER_MISSES, config.abuse().server().codeMisses());
  }

  /**
   * Частота чата у человека (A6): свой предел сообщений, отдельный от общего предела команд, и одно
   * и то же сообщение подряд не чаще, чем раз в {@code chat-repeat}. Отказ получает только он —
   * остальные пишут дальше.
   */
  private void chatAllowed(RoomState room, RoomState.Member member, String text, String address) {
    var abuse = config.abuse().perMember();
    var last =
        rooms
            .jdbc()
            .sql(
                "SELECT content, created_at FROM messages WHERE room_id=? AND participant_id=?"
                    + " ORDER BY created_at DESC LIMIT 1")
            .params(room.id, member.id)
            .query((row, i) -> Map.entry(row.getString(1), row.getLong(2)))
            .optional();
    if (last.isPresent()
        && last.get().getKey().equals(text)
        && now() - last.get().getValue() < abuse.chatRepeat().toMillis())
      throw new Problem(429, "CHAT_REPEAT", "Это сообщение уже отправлено. Подождите немного");
    if (limits.exceeded("chat:" + member.id, abuse.chatMessages()))
      throw new Problem(429, "CHAT_RATE", "Слишком много сообщений подряд. Подождите минуту");
    // То же на адрес (A6): у каждой вкладки свой предел участника, и десяток вкладок одного скрипта
    // писали бы вдесятеро больше человека. Предел адреса щедрее — за NAT офис.
    if (address != null
        && limits.exceeded("chat-ip:" + address, config.abuse().perIp().chatMessages()))
      throw new Problem(
          429, "CHAT_RATE_IP", "С этого адреса пишут слишком часто. Подождите минуту");
  }

  /** Снять «щит» досрочно — рычаг владельца сервера (E10) и уборка в тестах. */
  public void forgetCodeMisses() {
    limits.reset(SERVER_MISSES, config.abuse().server().codeMisses());
  }

  @Transactional
  public Admission rejoin(String roomId, String credential, Rejoin request) {
    return rejoin(roomId, credential, request, Entrant.UNKNOWN);
  }

  @Transactional
  public Admission rejoin(String roomId, String credential, Rejoin request, Entrant entrant) {
    rooms.lockGlobal();
    var room = lock(roomId);
    var previous = authenticate(room, credential, true);
    return returnMember(room, previous, request, false, entrant);
  }

  @Transactional
  public Admission joinSaved(String roomId, String memberId, Rejoin request) {
    return joinSaved(roomId, memberId, request, Entrant.UNKNOWN);
  }

  @Transactional
  public Admission joinSaved(String roomId, String memberId, Rejoin request, Entrant entrant) {
    rooms.lockGlobal();
    var room = lock(roomId);
    var member = room.members.get(memberId);
    if (member == null) throw Problem.forbidden();
    return returnMember(room, member, request, true, entrant);
  }

  private Admission returnMember(
      RoomState room, RoomState.Member previous, Rejoin request, boolean saved, Entrant entrant) {
    return receipt(
        "rejoin:" + room.id + ":" + previous.id,
        request.commandId(),
        request,
        Admission.class,
        () -> {
          if (saved && room.closedAt != null) {
            if (room.closedByServer != null && now() < room.closedByServer)
              throw new Problem(
                  403,
                  "CLOSED_BY_SERVER",
                  "Встречу завершил владелец сервера — открыть её снова пока нельзя",
                  Map.of("until", room.closedByServer));
            room.closedByServer = null;
            freezeHistory(room, room.closedAt);
            room.closedAt = null;
            room.mediaDrained = false;
            // Открытая заново встреча — новая встреча: её время идёт с нового начала, и потолок
            // длительности тоже считается заново.
            room.startedAt = null;
            room.openedAt = now();
            room.endsAt = null;
            room.cinemaTraffic = null;
          }
          requireOpen(room);
          if (previous.replacedBy != null)
            throw Problem.conflict("SESSION_REPLACED", "Этот вход уже заменён новой сессией");
          // A fresh media identity fences late leave RPCs and old client callbacks.
          // The room, conversation and host rights survive an explicit return.
          var status = previous.status;
          previous.status = LEFT;
          checkDoor(room);
          oneMeeting(room.id, entrant);
          // Старый клиент профиля не присылает — вернувшийся остаётся тем профилем, каким был.
          var member =
              newMember(
                  room,
                  request.name(),
                  previous.owner,
                  request.commandId(),
                  entrant.profileHash() != null
                      ? entrant
                      : new Entrant(room.profiles.get(previous.id), null, entrant.address()));
          member.codeRequest = previous.codeRequest;
          /*
           Исключение заканчивает встречу для человека, а не знакомство с комнатой.

           Раньше статус REMOVED закрывал дверь навсегда: сохранённая комната показывала
           «доступ отозван», а прежний вход больше не работал — и это при том, что та же
           ссылка-приглашение пускала того же человека обратно новым участником. Одно и то же
           действие означало то запрет, то паузу, в зависимости от того, какой дверью пойти.

           Теперь оно означает одно: выйти отсюда сейчас. Вернуться можно тем же путём, каким
           заходят все, — и ровно на тех же условиях: комната с подтверждением спросит
           ведущего снова, а прежнее согласие исключённому не наследуется. Ведущему, которому
           нужен настоящий запрет, отвечает подтверждение входа: оно и есть «не пускать».
          */
          var returning = status == REMOVED;
          member.approved =
              previous.owner
                  || (!returning && previous.approved)
                  || (!previous.codeRequest && !room.approvalRequired && status != WAITING);
          member.status = member.approved ? JOINING : WAITING;
          member.recoveryDeadline = member.approved ? now() + config.joinSeconds() * 1000L : null;
          room.waitingFrom.remove(previous.id);
          seat(room, member, entrant.address());
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
          // Вернувшийся — тот же человек с новым идентификатором. Место за столом и фишки
          // принадлежат человеку, а не сессии: без этой строки стул с деньгами остался бы
          // пустовать до конца игры, а его хозяин сидел бы рядом зрителем.
          if (room.poker != null) room.poker.rebind(previous.id, member.id, member.name);
          if (room.durak != null) room.durak.rebind(previous.id, member.id, member.name);
          if (room.chess != null) room.chess.rebind(previous.id, member.id, member.name);
          if (room.gartic != null) room.gartic.rebind(previous.id, member.id, member.name);
          room.emptySince = null;
          emit(room, "room.changed", EventPayload.changed());
          rooms.save(room, now());
          return admission(room, member, request.commandId(), null);
        });
  }

  /**
   * Открыта ли дверь для входящего: сервер принимает, у сервера есть слот для встречи, у встречи не
   * кончились входы. Место во встрече или очередь у двери решает {@link #seat} — когда уже ясно,
   * войдёт человек сразу или будет ждать допуска.
   */
  private void checkDoor(RoomState room) {
    if (!config.admissionOpen())
      throw new Problem(503, "DRAINING", "Сервер завершает действующие встречи");
    if (!room.busy(now())
        && rooms.all().stream().filter(r -> !r.id.equals(room.id) && r.busy(now())).count()
            >= config.maxRooms())
      throw new Problem(429, "ROOM_LIMIT", "Все комнаты заняты. Попробуйте позже");
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
                      && now() - m.joinedAt > config.retention().messages().toMillis());
      room.profiles.keySet().retainAll(room.members.keySet());
    }
    if (room.members.size() >= 500)
      throw new Problem(429, "SESSION_LIMIT", "Достигнут лимит входов за время встречи");
  }

  /**
   * Место во встрече или очередь у двери для только что вошедшего {@code member} (уже в комнате, со
   * своим статусом).
   *
   * <p>Место — только для людей. Бот его не занимает: иначе встреча с музыкой вмещала бы на одного
   * человека меньше, чем написано в настройках (T06, П3). SFU пускает на четыре подключения больше
   * предела — как раз для ботов и переходных сессий.
   *
   * <p>Ожидающий допуска места не занимает (A5): у двери свой потолок {@code meeting.waiting} и не
   * больше {@code per-ip.waiting-per-room} заявок с одного адреса. Место он получает, когда ведущий
   * его впустит, — и только если оно есть ({@link #admitWaiting}).
   */
  private void seat(RoomState room, RoomState.Member member, String address) {
    if (!member.human()) return;
    if (member.status != WAITING) {
      if (room.seatedHumans() > config.maxParticipants()) throw roomFull();
      return;
    }
    room.waitingFrom
        .keySet()
        .removeIf(id -> room.members.get(id) == null || room.members.get(id).status != WAITING);
    if (room.waitingHumans() > config.meeting().waiting())
      throw Problem.conflict(
          "WAITING_FULL", "Зал ожидания встречи заполнен. Попробуйте чуть позже");
    if (address == null) return;
    var from = secrets.address(address);
    if (room.waitingFrom.values().stream().filter(from::equals).count()
        >= config.abuse().perIp().waitingPerRoom())
      throw new Problem(
          429, "WAITING_LIMIT", "С этого адреса уже ждут в зале ожидания этой встречи");
    room.waitingFrom.put(member.id, from);
  }

  /** Ведущий впускает ожидающего — если во встрече есть место (A5). */
  private void admitWaiting(RoomState room, RoomState.Member target) {
    target.approved = true;
    target.status = JOINING;
    target.recoveryDeadline = now() + config.joinSeconds() * 1000L;
    room.waitingFrom.remove(target.id);
    if (target.human() && room.seatedHumans() > config.maxParticipants()) throw roomFull();
  }

  private Problem roomFull() {
    return Problem.conflict(
        "ROOM_FULL", "Во встрече нет свободных мест (предел — " + config.maxParticipants() + ")");
  }

  @Transactional
  public Admission join(String roomId, Join request) {
    return join(roomId, request, Entrant.UNKNOWN);
  }

  @Transactional
  public Admission join(String roomId, Join request, Entrant entrant) {
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
          checkDoor(room);
          oneMeeting(room.id, entrant);
          var member = newMember(room, request.name(), false, request.commandId(), entrant);
          seat(room, member, entrant.address());
          room.emptySince = null;
          emit(room, "room.changed", EventPayload.changed());
          rooms.save(room, now());
          return admission(room, member, request.commandId(), null);
        });
  }

  /**
   * Приглашение от бота — одно на комнату, пока оно живо (A11 модели угроз).
   *
   * <p>Раньше каждый {@code /meet} выдавал новое, и сотня команд от любого участника группы
   * выбирала потолок в сто приглашений комнаты на сутки: ведущий больше не мог пригласить никого.
   * Ссылка выводится из номера приглашения и секрета сервера, поэтому ту же ссылку можно выдать
   * снова, не храня её. Отозванное или почти истёкшее — повод выдать новое.
   */
  @Transactional
  public String serviceInvite(String roomId) {
    var room = lock(roomId);
    requireOpen(room);
    var held = room.botInvite == null ? null : room.invites.get(room.botInvite);
    if (held != null && !held.revoked() && held.expiresAt() > now() + 3_600_000L)
      return inviteUrl(room, held.id());
    room.botInvite = newInvite(room);
    var url = inviteUrl(room, room.botInvite);
    emit(room, "room.changed", EventPayload.changed());
    rooms.save(room, now());
    return url;
  }

  /**
   * Служба кинозала: встреча выбрала {@code percent} процентов своего потолка трафика (A8).
   *
   * <p>Ядро трафик не считает — считает служба, она же и отказывает сверх потолка. Здесь только
   * память для снимка: всем во встрече — плашка, и тем, кто войдёт позже. Доля только растёт,
   * повтор ничего не меняет; завершённой встрече сообщать нечего.
   */
  @Transactional
  public void cinemaTraffic(String roomId, int percent) {
    var room = lock(roomId);
    if (room.closedAt != null) return;
    if (room.cinemaTraffic != null && room.cinemaTraffic >= percent) return;
    room.cinemaTraffic = percent;
    emit(room, "room.changed", EventPayload.changed());
    rooms.save(room, now());
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
    Permissions.require(room, member, Action.ROOM_SETTINGS);
    requireOpen(room);
    // Проверка та же, что при создании: @NotBlank отсекает пустое и одни пробелы, @Size —
    // длину. Дублировать её здесь значило бы завести второе место, где она может разойтись.
    room.title = Names.title(settings.title());
    room.approvalRequired = settings.approvalRequired();
    emit(room, "room.changed", EventPayload.changed());
    rooms.save(room, now());
    return snapshotFor(room, member);
  }

  @Transactional
  public Snapshot integrationSettings(String roomId, String credential, boolean enabled) {
    var room = lock(roomId);
    var member = authenticate(room, credential);
    Permissions.require(room, member, Action.ROOM_INTEGRATIONS);
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
          stageBusy(room, Occupant.CINEMA);
          checkDoor(room);
          var member = newMember(room, "Музыка", false, commandId, Entrant.UNKNOWN);
          member.service = "music";
          member.approved = true;
          member.status = JOINING;
          member.recoveryDeadline = now() + config.joinSeconds() * 1000L;
          emit(room, "room.changed", EventPayload.changed());
          rooms.save(room, now());
          return admission(room, member, commandId, null);
        });
  }

  private RoomState.Member newMember(
      RoomState room, String name, boolean owner, UUID commandId, Entrant entrant) {
    var m = new RoomState.Member();
    m.id = UUID.randomUUID().toString();
    m.name = Names.person(name);
    m.owner = owner;
    m.joinedAt = now();
    m.status = (!owner && room.approvalRequired) ? WAITING : JOINING;
    m.approved = m.status == JOINING;
    m.recoveryDeadline = m.status == JOINING ? now() + config.joinSeconds() * 1000L : null;
    m.secretHash =
        Secrets.hash(secrets.derive("session:" + room.id + ":" + m.id + ":" + commandId));
    room.members.put(m.id, m);
    if (entrant.profileHash() != null) room.profiles.put(m.id, entrant.profileHash());
    return m;
  }

  /**
   * Одна активная встреча на профиль устройства (T52, П13).
   *
   * <p>Стоит в каждой двери во встречу — создать, по ссылке, по коду, вернуться, из избранного —
   * под общим замком ({@code lockGlobal}): две вкладки, входящие одновременно в две встречи,
   * проходят её по очереди, и вторая уже видит первую.
   *
   * <p>Живое участие этого профиля в другой открытой встрече ({@link RoomState#engages}) — отказ
   * {@code 409 ALREADY_IN_MEETING} с её названием. Повтор с {@code X-Cord-Leave}, называющим ровно
   * эту встречу, закрывает прежнее участие обычным выходом — остальные видят и слышат его как любой
   * другой — и пускает. Всё это одна транзакция: откажи дверь дальше, выход откатится вместе со
   * входом. Та же встреча во второй вкладке — не вторая встреча; боты и вход без профиля правила не
   * знают.
   */
  private void oneMeeting(String roomId, Entrant entrant) {
    var profile = entrant.profileHash();
    if (!config.meeting().oneActivePerProfile() || profile == null) return;
    long at = now();
    var elsewhere =
        rooms.all().stream().filter(r -> !r.id.equals(roomId) && r.engages(profile, at)).toList();
    for (var other : elsewhere)
      if (!other.id.equals(entrant.leave()))
        throw new Problem(
            409,
            "ALREADY_IN_MEETING",
            "Вы уже во встрече «" + other.title + "»",
            Map.of("roomId", other.id, "title", other.title));
    for (var other : elsewhere) leaveFor(other.id, profile);
  }

  /** Выход профиля из встречи — тот же, что по кнопке «Выйти», для каждой его вкладки в ней. */
  private void leaveFor(String roomId, String profile) {
    var room = lock(roomId);
    for (var member : room.members.values())
      if (member.human() && member.occupiesSeat() && profile.equals(room.profiles.get(member.id)))
        depart(member);
    emit(room, "room.changed", EventPayload.changed());
    rooms.save(room, now());
    // Сокеты той встречи узнают о выходе сразу после фиксации, а не на следующем проходе.
    events.publishEvent(new RoomChanged(room.id));
  }

  /**
   * Человек ушёл сам: место свободно, показ и срок восстановления сняты, старые вызовы отсечены.
   */
  static void depart(RoomState.Member member) {
    member.status = LEFT;
    member.generation++;
    member.screen = false;
    member.recoveryDeadline = null;
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
            current.watch(),
            current.poker(),
            current.durak(),
            current.pokerGamesAt(),
            current.durakGamesAt(),
            current.chess(),
            current.gartic(),
            current.you(),
            current.startedAt(),
            current.endsAt(),
            current.cinemaTraffic());
    return new Admission(
        room.id,
        member.id,
        member.id + "." + secrets.derive("session:" + room.id + ":" + member.id + ":" + commandId),
        inviteUrl,
        config.recoverySeconds(),
        initial);
  }

  private String invite(RoomState room) {
    return inviteUrl(room, newInvite(room));
  }

  /** Новое приглашение комнаты; возвращает его номер — по нему выводится ссылка. */
  private String newInvite(RoomState room) {
    if (room.invites.size() >= 100)
      room.invites.values().removeIf(i -> i.revoked() || i.expiresAt() <= now());
    if (room.invites.size() >= 100)
      throw new Problem(429, "INVITE_LIMIT", "Слишком много приглашений");
    var id = UUID.randomUUID().toString();
    var token = secrets.derive("invite:" + room.id + ":" + id);
    room.invites.put(
        id,
        new RoomState.Invite(
            id,
            Secrets.hash(token),
            now(),
            now() + config.retention().messages().toMillis(),
            false));
    return id;
  }

  private String inviteUrl(RoomState room, String inviteId) {
    return config.publicUrl()
        + "/join/"
        + room.id
        + "#invite="
        + secrets.derive("invite:" + room.id + ":" + inviteId);
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
    if (room.closedAt != null
        && now() >= room.closedAt + config.retention().closedHistory().toMillis())
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
        createdAt + config.retention().messages().toMillis(),
        room.closedAt == null
            ? Long.MAX_VALUE
            : room.closedAt + config.retention().closedHistory().toMillis());
  }

  public Snapshot snapshot(RoomState room) {
    return snapshot(room, null);
  }

  /**
   * Снимок комнаты глазами конкретного участника.
   *
   * <p>Участник здесь нужен для двух вещей: карт и прав. Всё остальное в комнате — общее, и
   * показывать его по-разному незачем; карты же принадлежат тому, кому их раздали, а права — тому,
   * у кого они есть ({@code you}). Снимок «для всех» не содержит ни того, ни другого ({@code viewer
   * == null} — это взгляд постороннего).
   */
  private Snapshot snapshot(RoomState room, RoomState.Member viewer) {
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
            .params(room.id, now() - config.retention().messages().toMillis())
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
        watch(room),
        room.poker == null ? null : room.poker.view(viewer == null ? null : viewer.id, now()),
        room.durak == null ? null : room.durak.view(viewer == null ? null : viewer.id, now()),
        lastGameAt(room),
        lastDurakAt(room),
        room.chess == null ? null : room.chess.view(viewer == null ? null : viewer.id, now()),
        room.gartic == null ? null : room.gartic.view(viewer == null ? null : viewer.id, now()),
        viewer == null
            ? null
            : new RoomYou(Permissions.granted(room, viewer), presenceBy(room, viewer)),
        room.startedAt,
        room.endsAt,
        room.cinemaTraffic);
  }

  /**
   * До какого момента человеку ответить на «Вы ещё здесь?», или null, если его не спрашивали (A2).
   * Срок — от последнего присутствия: {@code presence-check} молчания и {@code presence-answer} на
   * ответ.
   */
  private Long presenceBy(RoomState room, RoomState.Member viewer) {
    if (!room.presenceAsked.contains(viewer.id)) return null;
    var meeting = config.meeting();
    return room.presence.getOrDefault(viewer.id, viewer.joinedAt)
        + meeting.presenceCheck().toMillis()
        + meeting.presenceAnswer().toMillis();
  }

  /**
   * Когда в этой беседе последний раз доиграли.
   *
   * <p>ОДНО ЧИСЛО ВМЕСТО ИСТОРИИ. Сами итоги в снимок не ложатся — это килобайты таблиц на каждое
   * чужое повышение, — но знать, что история изменилась, браузеру необходимо: иначе он спрашивает
   * её в тот самый миг, когда игра кончилась, получает пустой список и больше не возвращается. Эта
   * метка меняется ровно в момент записи, чем бы игра ни кончилась, и по ней список перечитывается
   * сам.
   */
  private static long lastGameAt(RoomState room) {
    if (room.pokerGames == null || room.pokerGames.isEmpty()) return 0;
    return room.pokerGames.get(room.pokerGames.size() - 1).finishedAt();
  }

  /** То же самое для дурака: когда в этой беседе последний раз доиграли партию. */
  private static long lastDurakAt(RoomState room) {
    if (room.durakGames == null || room.durakGames.isEmpty()) return 0;
    return room.durakGames.get(room.durakGames.size() - 1).finishedAt();
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

  /**
   * Что с недавними встречами человека (R148). Комнату, которой нет, или историю, которая уже
   * удалена, ядро называет {@code gone}; на чужой или отозванный пропуск не отвечает ничего — так
   * пачка пропусков не становится способом узнать о чужих встречах. Ушедший участник годится: его
   * пропуск и есть тот, с которым возвращаются ({@code rejoin}).
   */
  public List<Contracts.Presence> presence(List<Contracts.PresenceRoom> query) {
    var answers = new ArrayList<Contracts.Presence>();
    for (var item : query) {
      var id = item.roomId().toString();
      try {
        var room = read(id);
        authenticate(room, item.credential(), true);
        var people =
            (int)
                room.members.values().stream()
                    .filter(
                        m ->
                            m.human()
                                && (m.status == RoomState.Status.CONNECTED
                                    || m.status == RoomState.Status.RECOVERING))
                    .count();
        var state = room.closedAt != null ? "closed" : people > 0 ? "live" : "open";
        answers.add(new Contracts.Presence(id, state, people, room.title, room.code));
      } catch (Problem refused) {
        if (refused.status() == 404 || refused.status() == 410)
          answers.add(new Contracts.Presence(id, "gone", 0, null, null));
      }
    }
    return answers;
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
    var current = snapshot(room, member);
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
        // Ожидающий в дверях ещё не во встрече: что комната смотрит и во что играет — такая же
        // её жизнь, как переписка, и до разрешения войти он этого не видит. Прошлые игры — тем
        // более: история беседы начинается после того, как в неё пустили.
        null,
        null,
        null,
        0,
        0,
        null,
        null,
        // Права — свои, как и у допущенного: у ожидающего их список пуст, и браузеру незачем
        // угадывать это по статусу.
        current.you(),
        // Сколько встреча идёт — не её жизнь, а её часы: их видно и из-за двери.
        current.startedAt(),
        current.endsAt(),
        current.cinemaTraffic());
  }

  @Transactional
  public Ack command(String roomId, String credential, Command command) {
    return command(roomId, credential, command, null);
  }

  /**
   * Команда участника; {@code address} — ключ пределов того, кто её прислал ({@code
   * ClientAddress}), или null у служб и тестов: по нему чат считается и на адрес (A6).
   */
  @Transactional
  public Ack command(String roomId, String credential, Command command, String address) {
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
            case "leave" -> depart(member);
            case "profile.avatar" -> {
              member.avatar = avatar(command.text());
              emit(room, "room.changed", EventPayload.changed());
            }
            case "close" -> {
              Permissions.require(room, member, Action.ROOM_CLOSE);
              close(room, "host");
            }
            /*
             «Я здесь» (A2): человек ответил на «Вы ещё здесь?» или браузер сам сказал, что за ним
             кто-то есть — говорил, двигал мышь, жал клавиши, держал камеру. Срок присутствия
             начинается заново, плашка гаснет.
            */
            case "presence.confirm" -> {
              requireActive(room, member);
              room.presence.put(member.id, now());
              room.presenceAsked.remove(member.id);
            }
            case "invite.create" -> {
              Permissions.require(room, member, Action.INVITE_MANAGE);
              requireOpen(room);
              value = invite(room);
            }
            case "invite.revoke" -> {
              Permissions.require(room, member, Action.INVITE_MANAGE);
              requireOpen(room);
              room.invites.replaceAll(
                  (id, i) ->
                      new RoomState.Invite(
                          i.id(), i.secretHash(), i.createdAt(), i.expiresAt(), true));
            }
            case "participant.remove", "participant.approve" -> {
              Permissions.require(
                  room,
                  member,
                  command.type().equals("participant.remove")
                      ? Action.PARTICIPANT_REMOVE
                      : Action.PARTICIPANT_APPROVE);
              requireOpen(room);
              var target = room.members.get(command.targetId());
              if (target == null || target.owner) throw Problem.forbidden();
              if (command.type().equals("participant.remove")) {
                target.status = REMOVED;
                target.screen = false;
                target.generation++;
                target.recoveryDeadline = null;
                for (var observer : observers)
                  observer.acted(room, member, "participant.removed", target, now());
              } else if (target.status == WAITING) {
                admitWaiting(room, target);
              }
            }
            case "screen.preview" -> {
              requireActive(room, member);
              // Кадр шлёт только тот, кто сейчас показывает; чаще раза в две секунды — молча
              // отбрасывается (клиент шлёт раз в пять, предел — страховка от залпа).
              if (!member.screen) throw Problem.conflict("SCREEN_ENDED", "Демонстрация завершена");
              if (command.image() == null || command.image().isBlank())
                throw new Problem(400, "INVALID_COMMAND", "Некорректная команда");
              var key = room.id + ":" + member.id;
              var last = previewAt.get(key);
              if (last == null || now() - last >= PREVIEW_INTERVAL_MS) {
                previewAt.put(key, now());
                events.publishEvent(new ScreenPreview(room.id, member.id, command.image()));
              }
              return new Ack(command.commandId(), true, room.sequence, null);
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
              Permissions.require(room, member, Action.WATCH_OPEN);
              // Активная интеграция в комнате одна. Музыка и кинозал спорят за одно и то же —
              // за уши участников, — и «добавились обе» означает два звука разом, из которых
              // не выключить ни один.
              stageBusy(
                  room,
                  Occupant.NEW_GAME,
                  Occupant.OTHER_SERVICE,
                  Occupant.POKER_TABLE,
                  Occupant.DURAK_TABLE);
              if (command.provider() == null
                  || command.kind() == null
                  || command.contentId() == null
                  || command.contentId().isBlank())
                throw new Problem(400, "WATCH_INVALID", "Нечего открывать");
              // Эфир есть не у всех площадок: ivi отдаёт только запись, и «channel» для него —
              // не эфир без начала, а нечего открывать. Отказ тот же, что у пустых полей:
              // площадке, куда нечего заходить, не важно, чего именно не хватило.
              if (command.kind().equals("channel")
                  && !WATCH_LIVE_PROVIDERS.contains(command.provider()))
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
               Пауза — общая, и это решение, а не упрощение.

               Раньше пульт принадлежал принёсшему видео: остальные смотрели, как чужая рука
               ставит паузу, и «отойду на минуту» означало просить об этом вслух. Смотрят
               вместе не десять незнакомцев, а свои — и «каждый может нажать паузу для всех»
               ближе к тому, как это происходит в одной комнате с одним телевизором. Право то
               же самое, что и на всё остальное постороннее в комнате: ведущему всегда,
               остальным — пока комната разрешает интеграции.

               Своим у каждого остаётся то, о чём договариваться не с кем: громкость и
               качество приёма. Их комната не хранит вовсе.
              */
              Permissions.require(room, member, Action.WATCH_CONTROL);
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
              Permissions.require(room, member, Action.WATCH_CLOSE);
              room.watch = null;
            }
            /*
             Покер. Сцена в комнате одна, и стол занимает её целиком — как кинозал. Поэтому
             открыть их вместе нельзя, и проверка стоит с обеих сторон. А вот музыка столу не
             мешает: она в ушах, он на экране, и играть под музыку — это ровно то, чего от
             домашней игры и ждут.

             ПРАВО ОТКРЫТЬ И ПРАВО ИГРАТЬ — РАЗНЫЕ. Принести стол во встречу, убрать его,
             раздать и поменять настройки может тот, кому комната разрешила интеграции. А сесть
             и сходить — любой участник: игра, в которую пускают одного ведущего, не игра.
            */
            case "poker.open" -> {
              requireActive(room, member);
              requireOpen(room);
              Permissions.require(room, member, Action.POKER_OPEN);
              stageBusy(room, Occupant.NEW_GAME, Occupant.CINEMA, Occupant.DURAK_TABLE);
              if (room.poker != null) throw Problem.conflict("POKER_OPEN", "Стол уже открыт");
              room.poker =
                  dev.mikki.stream.game.Table.open(
                      member.id,
                      command.option(),
                      now(),
                      command.chips() == null ? 0 : command.chips());
            }
            case "poker.close" -> {
              requireActive(room, member);
              dealer(room, member);
              // Стол уносят вместе с фишками, а итог игры остаётся: иначе «убрать стол» означало
              // бы стереть то, что за ним происходило полчаса.
              archiveGame(room, "closed", now());
              room.poker = null;
            }
            case "poker.sit" ->
                table(room).sit(member.id, member.name, command.seat(), active(room, member));
            case "poker.stand" -> table(room).stand(member.id, active(room, member));
            case "poker.deal" -> {
              dealer(room, member);
              table(room).deal(active(room, member));
            }
            // «Продолжить»: вскрытие убирается со стола, а раздаёт по-прежнему человек.
            case "poker.next" -> {
              dealer(room, member);
              table(room).next(active(room, member));
            }
            case "poker.act" ->
                table(room)
                    .act(
                        member.id,
                        command.option(),
                        command.chips() == null ? 0 : command.chips(),
                        active(room, member));
            case "poker.settings" -> {
              dealer(room, member);
              table(room).configure(command.option(), command.chips(), active(room, member));
            }
            case "poker.rebuy" ->
                table(room)
                    .rebuy(
                        member.id,
                        command.chips() == null ? 0 : command.chips(),
                        active(room, member));
            case "poker.reveal" -> table(room).reveal(member.id, active(room, member));
            /*
             Дурак. Те же права и та же сцена, что у покера: принести стол, убрать и раздать
             может тот, кому комната разрешила интеграции, а сесть и сходить — любой участник.

             ЧЕГО ЗДЕСЬ НЕТ ПО СРАВНЕНИЮ С ПОКЕРОМ. Истории: партия кончается дураком, и всё,
             что от неё остаётся, — это разговор за столом. Писать в снимок комнаты таблицу с
             одной строкой «кто проиграл» значило бы завести архив ради факта, который все
             только что видели.
            */
            case "durak.open" -> {
              requireActive(room, member);
              requireOpen(room);
              Permissions.require(room, member, Action.DURAK_OPEN);
              stageBusy(room, Occupant.NEW_GAME, Occupant.CINEMA, Occupant.POKER_TABLE);
              if (room.durak != null) throw Problem.conflict("DURAK_OPEN", "Стол уже открыт");
              room.durak =
                  dev.mikki.stream.game.Durak.open(
                      member.id,
                      command.option(),
                      now(),
                      command.chips() == null ? 36 : command.chips().intValue());
            }
            case "durak.close" -> {
              requireActive(room, member);
              fool(room, member);
              // Доигранная партия остаётся в истории, даже если стол унесли сразу после неё.
              archiveDurak(room, now());
              room.durak = null;
            }
            case "durak.sit" ->
                durak(room).sit(member.id, member.name, command.seat(), active(room, member));
            case "durak.stand" -> durak(room).stand(member.id, active(room, member));
            case "durak.react" ->
                durak(room).react(member.id, command.option(), active(room, member));
            case "durak.deal" -> {
              fool(room, member);
              durak(room).deal(active(room, member));
            }
            case "durak.act" ->
                durak(room)
                    .act(
                        member.id,
                        command.option(),
                        command.card(),
                        command.under(),
                        active(room, member));
            case "durak.settings" -> {
              fool(room, member);
              durak(room).configure(command.option(), command.chips(), active(room, member));
            }
            case "chess.open" -> {
              requireActive(room, member);
              Permissions.require(room, member, Action.CHESS_OPEN);
              gameStageAvailable(room);
              room.chess =
                  dev.mikki.stream.game.Chess.open(member.id, member.name, command.option(), now());
            }
            case "chess.close" -> {
              requireActive(room, member);
              chessHost(room, member);
              gameIdentity(chess(room).id, command.contentId());
              room.chess = null;
            }
            case "chess.sit" -> {
              requireActive(room, member);
              gameIdentity(chess(room).id, command.contentId());
              room.chess.sit(member.id, member.name, command.seat(), now());
            }
            case "chess.stand" -> {
              requireActive(room, member);
              gameIdentity(chess(room).id, command.contentId());
              room.chess.stand(member.id, now());
            }
            case "chess.start" -> {
              requireActive(room, member);
              chessHost(room, member);
              room.chess.start(command.contentId(), now());
            }
            case "chess.settings" -> {
              requireActive(room, member);
              chessHost(room, member);
              gameIdentity(room.chess.id, command.contentId());
              room.chess.configure(command.option(), now());
            }
            case "chess.move" -> {
              requireActive(room, member);
              chess(room)
                  .move(
                      member.id, command.contentId(), command.positionMs(), command.text(), now());
            }
            case "chess.act" -> {
              requireActive(room, member);
              chess(room)
                  .act(
                      member.id,
                      command.contentId(),
                      command.positionMs(),
                      command.option(),
                      command.text(),
                      now());
            }
            case "gartic.open" -> {
              requireActive(room, member);
              Permissions.require(room, member, Action.GARTIC_OPEN);
              gameStageAvailable(room);
              room.gartic =
                  dev.mikki.stream.game.Gartic.open(
                      member.id, member.name, command.option(), now());
            }
            case "gartic.close",
                "gartic.join",
                "gartic.leave",
                "gartic.settings",
                "gartic.start",
                "gartic.choose",
                "gartic.draw",
                "gartic.canvas",
                "gartic.guess",
                "gartic.submit",
                "gartic.reveal" -> {
              requireActive(room, member);
              var drawing = gartic(room);
              gameIdentity(drawing.gameId, command.contentId());
              switch (command.type()) {
                case "gartic.close" -> {
                  Permissions.require(room, member, Action.GARTIC_MANAGE);
                  room.gartic = null;
                }
                case "gartic.join" -> drawing.join(member.id, member.name, now());
                case "gartic.leave" -> drawing.leave(member.id, now());
                case "gartic.settings" -> {
                  Permissions.require(room, member, Action.GARTIC_MANAGE);
                  drawing.configure(command.option(), command.chips(), now());
                }
                case "gartic.start" -> {
                  Permissions.require(room, member, Action.GARTIC_MANAGE);
                  drawing.start(now());
                }
                case "gartic.choose" ->
                    drawing.choose(
                        member.id, gameNumber(command.chips()), gameTurn(command), now());
                case "gartic.draw" ->
                    drawing.draw(member.id, command.text(), gameTurn(command), now());
                case "gartic.canvas" ->
                    drawing.canvas(member.id, command.option(), gameTurn(command), now());
                case "gartic.guess" ->
                    drawing.guess(member.id, command.text(), gameTurn(command), now());
                case "gartic.submit" ->
                    drawing.submit(member.id, command.text(), gameTurn(command), now());
                case "gartic.reveal" -> {
                  Permissions.require(room, member, Action.GARTIC_MANAGE);
                  drawing.reveal(
                      gameNumber(command.chips()),
                      command.seat() == null ? 0 : command.seat(),
                      gameTurn(command),
                      now());
                }
                default -> throw new IllegalStateException("Unhandled drawing command");
              }
            }
            case "message.send" -> {
              requireActive(room, member);
              if (command.text() == null || command.text().isBlank())
                throw new Problem(400, "EMPTY_MESSAGE", "Введите сообщение");
              if (member.human()) chatAllowed(room, member, command.text().strip(), address);
              // Кольцо, а не стена (A6): сверх потолка уходят старейшие. Раньше на тысячном
              // сообщении сервер отказывал всем, и один участник мог заглушить чат на сутки.
              long stored =
                  rooms
                      .jdbc()
                      .sql("SELECT COUNT(*) FROM messages WHERE room_id=?")
                      .param(room.id)
                      .query(Long.class)
                      .single();
              int cap = config.chat().roomHistory();
              if (stored >= cap)
                rooms
                    .jdbc()
                    .sql(
                        "DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE room_id=?"
                            + " ORDER BY created_at, id LIMIT ?)")
                    .params(room.id, stored - cap + 1)
                    .update();
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
                room.markStarted(now());
              }
            }
            default -> throw new Problem(400, "UNKNOWN_COMMAND", "Неизвестная команда");
          }
          emit(room, "room.changed", EventPayload.changed());
          rooms.save(room, now());
          // Стол мог назначить себе срок — конец хода, паузу перед следующей раздачей. Часы
          // узнают об этом сразу, а не через секунду, когда до комнаты дойдёт общий проход.
          games.schedule(room.id, gameDeadline(room));
          return new Ack(command.commandId(), true, room.sequence, value);
        });
  }

  /** The room lock and receipt also serialize concurrent host requests and retries. */
  @Transactional
  public Ack muteMicrophone(String roomId, String credential, Command command, Runnable mute) {
    var room = lock(roomId);
    var member = authenticate(room, credential);
    Permissions.require(room, member, Action.PARTICIPANT_MUTE);
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

  /**
   * Сложить игру в историю беседы.
   *
   * <p>ОДНА ДВЕРЬ НА ВСЕ КОНЦЫ ИГРЫ, и это главное про этот метод. Игра кончается по-разному — за
   * столом остался один, стол убрали руками, за столом десять минут никого не было, встречу
   * завершили, — и записать её нужно ровно один раз в любом из этих случаев. Отметка стоит на самом
   * столе ({@code archived}), поэтому второй вызов ничего не делает, сколько бы концов ни совпало.
   *
   * <p>Игра без единой раздачи в историю не идёт: стол, который принесли и убрали, — это не «игра с
   * нулевой статистикой», а отсутствие игры.
   */
  static void archiveGame(RoomState room, String ending, long now) {
    var table = room.poker;
    if (table == null || table.archived || table.handNumber == 0) return;
    table.archived = true;
    if (room.pokerGames == null) room.pokerGames = new java.util.ArrayList<>();
    room.pokerGames.add(dev.mikki.stream.game.Standings.of(table, ending, now));
    while (room.pokerGames.size() > RoomState.POKER_HISTORY) room.pokerGames.remove(0);
  }

  /**
   * Сложить сыгранную партию дурака в историю беседы.
   *
   * <p>КОНЕЦ ЗДЕСЬ ОДИН, И ЭТИМ ДУРАК ПРОЩЕ ПОКЕРА. У покера их четыре — победитель, убранный стол,
   * пустой стол, конец встречи, — потому что фишки надо записать в любом случае. Партия дурака
   * записывается, только если она доиграна до дурака: прерванная партия — это не «игра с
   * неизвестным результатом», а отсутствие результата. Поэтому единственное условие — {@code phase
   * == over}, а отметка на столе не даёт записать её дважды.
   */
  static void archiveDurak(RoomState room, long now) {
    var table = room.durak;
    if (table == null || table.archived || !"over".equals(table.phase)) return;
    table.archived = true;
    if (room.durakGames == null) room.durakGames = new java.util.ArrayList<>();
    room.durakGames.add(dev.mikki.stream.game.DurakStandings.of(table, now));
    while (room.durakGames.size() > RoomState.DURAK_HISTORY) room.durakGames.remove(0);
  }

  /** Партии дурака этой беседы — отдельной ручкой, по той же причине, что и покерные игры. */
  public List<dev.mikki.stream.game.DurakSummary> durakGames(String roomId, String credential) {
    var room = read(roomId);
    authenticate(room, credential);
    return room.durakGames == null ? List.of() : List.copyOf(room.durakGames);
  }

  /**
   * История игр беседы.
   *
   * <p>Отдельная ручка, а не поле снимка: итоги десяти игр — это килобайты таблиц, которые
   * пересылать на каждое чужое повышение незачем. Их спрашивают тогда, когда открывают историю.
   */
  public List<dev.mikki.stream.game.GameSummary> games(String roomId, String credential) {
    var room = read(roomId);
    authenticate(room, credential);
    return room.pokerGames == null ? List.of() : List.copyOf(room.pokerGames);
  }

  /**
   * Ближайший срок, который назначила себе игра комнаты.
   *
   * <p>Сцена одна, и стол на ней тоже один, — но брать из двух полей ближайшее дешевле, чем помнить
   * об этом в каждом месте, где срок ставится. Ноль означает «будить незачем».
   */
  static long gameDeadline(RoomState room) {
    return java.util.stream.LongStream.of(
            room.poker == null ? 0 : room.poker.deadline,
            room.durak == null ? 0 : room.durak.deadline,
            room.chess == null ? 0 : room.chess.deadline,
            room.gartic == null ? 0 : room.gartic.deadline)
        .filter(value -> value > 0)
        .min()
        .orElse(0);
  }

  /**
   * Кто в комнате занимает то место, которое не делят вдвоём.
   *
   * <p>Кинозал, покерный стол, стол дурака и новая игра (шахматы или рисовалки) — это одна и та же
   * «сцена» комнаты: она одна, и они конкурируют за неё все со всеми. Музыка на сцену не выходит,
   * зато вместе с кинозалом спорит за отдельный ресурс — «уши»: звук иначе звучал бы дважды разом,
   * и ни один было бы не выключить.
   *
   * <p>Раньше у каждой пары был свой рукописный {@code if}, и один и тот же текст ошибки
   * копировался в них заново — «кинозал» трижды, «покерный стол» и «стол дурака» по два раза. Здесь
   * у каждого занятого места один код и один текст, а «открыть» лишь перечисляет, с кем оно делит
   * сцену или уши.
   */
  private enum Occupant {
    CINEMA(r -> r.watch != null, "Во встрече открыт кинозал. Сначала закройте его"),
    POKER_TABLE(r -> r.poker != null, "Во встрече открыт покерный стол. Сначала закройте его"),
    DURAK_TABLE(r -> r.durak != null, "Во встрече открыт стол дурака. Сначала закройте его"),
    NEW_GAME(
        r -> r.chess != null || r.gartic != null,
        "Во встрече уже открыта игра. Сначала закройте её"),
    OTHER_SERVICE(
        r -> r.members.values().stream().anyMatch(m -> m.service != null && m.occupiesSeat()),
        "Во встрече уже есть другая интеграция. Сначала уберите её");

    private final Predicate<RoomState> present;
    private final String message;

    Occupant(Predicate<RoomState> present, String message) {
      this.present = present;
      this.message = message;
    }
  }

  /** Бросает {@code INTEGRATION_BUSY} на первом занятом месте из перечисленных — в этом порядке. */
  private static void stageBusy(RoomState room, Occupant... occupants) {
    for (var occupant : occupants)
      if (occupant.present.test(room)) throw Problem.conflict("INTEGRATION_BUSY", occupant.message);
  }

  private static void gameStageAvailable(RoomState room) {
    stageBusy(room, Occupant.NEW_GAME);
    if (room.watch != null || room.poker != null || room.durak != null)
      throw Problem.conflict("INTEGRATION_BUSY", "Сначала закройте текущую игру или кинозал");
  }

  /**
   * Распоряжаться доской может её ведущий и создатель встречи ({@link Permissions}); доска при этом
   * должна быть — команда без неё отвечает {@code CHESS_CLOSED}, как и раньше, до проверки права.
   */
  private static void chessHost(RoomState room, RoomState.Member member) {
    chess(room);
    Permissions.require(room, member, Action.CHESS_MANAGE);
  }

  private static void gameIdentity(String actual, String expected) {
    if (!Objects.equals(actual, expected))
      throw Problem.conflict("GAME_STALE", "Игра уже изменилась. Дождитесь обновления");
  }

  private static long gameTurn(Command command) {
    if (command.positionMs() == null)
      throw new Problem(400, "GAME_TURN_REQUIRED", "Не указан текущий этап игры");
    return command.positionMs();
  }

  private static int gameNumber(Long value) {
    if (value == null || value < 0 || value > Integer.MAX_VALUE)
      throw new Problem(400, "GAME_OPTION_REQUIRED", "Выберите вариант игры");
    return value.intValue();
  }

  private static dev.mikki.stream.game.Chess chess(RoomState room) {
    if (room.chess == null) throw Problem.conflict("CHESS_CLOSED", "Шахматная доска уже закрыта");
    return room.chess;
  }

  private static dev.mikki.stream.game.Gartic gartic(RoomState room) {
    if (room.gartic == null)
      throw Problem.conflict("GARTIC_CLOSED", "Игра в рисование уже закрыта");
    return room.gartic;
  }

  /** Стол, который точно есть. Команда игре без стола — это не ошибка правил, а опоздание. */
  private static dev.mikki.stream.game.Table table(RoomState room) {
    if (room.poker == null) throw Problem.conflict("POKER_CLOSED", "Стол уже убрали из встречи");
    return room.poker;
  }

  /**
   * Кто распоряжается столом: тот, кто его принёс, и ведущий встречи ({@link Permissions}).
   *
   * <p>Ведущий здесь не «начальник», а запасной выход: принёсший стол мог закрыть вкладку, и без
   * этого правила игра осталась бы без того, кто раздаёт, до конца встречи.
   */
  private void dealer(RoomState room, RoomState.Member member) {
    requireActive(room, member);
    table(room);
    Permissions.require(room, member, Action.POKER_MANAGE);
  }

  /** Стол дурака, который точно есть. */
  private static dev.mikki.stream.game.Durak durak(RoomState room) {
    if (room.durak == null) throw Problem.conflict("DURAK_CLOSED", "Стол уже убрали из встречи");
    return room.durak;
  }

  /** Кто распоряжается столом дурака: принёсший его и ведущий встречи. То же, что у покера. */
  private void fool(RoomState room, RoomState.Member member) {
    requireActive(room, member);
    durak(room);
    Permissions.require(room, member, Action.DURAK_MANAGE);
  }

  /** Участник во встрече и вправе действовать; возвращает время, которым это и произошло. */
  private long active(RoomState room, RoomState.Member member) {
    requireActive(room, member);
    return now();
  }

  /** Подпись к открытому ролику: без управляющих символов и не длиннее строки заголовка. */
  private static String label(String value) {
    if (value == null) return null;
    var text = value.replaceAll("\\p{Cntrl}", " ").strip();
    return text.isEmpty() ? null : text.substring(0, Math.min(120, text.length()));
  }

  /**
   * Сколько места картинка профиля занимает в снимке комнаты.
   *
   * <p>Это же число знает браузер ({@code web/src/core/avatar.ts}): он подбирает размер и качество
   * так, чтобы уложиться ровно в него. Оно одно на обе стороны — и должно таким оставаться.
   */
  private static final int AVATAR_URI = 3500;

  /**
   * Тот же предел, но в байтах самой картинки.
   *
   * <p>Считается из {@link #AVATAR_URI}, а не назначается отдельно, и это починка: раньше здесь
   * стояло 2400 байт — меньше, чем помещается в 3500 символов base64. Больше половины картинок
   * проходили проверку у себя и отвергались здесь, а отказ никому не показывался: человек видел
   * свою картинку в настройках и не видел её в комнате. Два предела на одно и то же — это всегда
   * одна такая щель.
   */
  private static final int AVATAR_BYTES = AVATAR_URI * 3 / 4;

  /**
   * An avatar is shown to everyone in the room, so what arrives is checked rather than trusted.
   * Only a base64 data URI of a known image type is accepted, the payload must actually decode, and
   * the size is bounded so a picture can never become a way to push bulk data through the snapshot.
   * An empty value clears the picture.
   */
  private static String avatar(String value) {
    if (value == null || value.isBlank()) return null;
    var text = value.strip();
    var comma = text.indexOf(',');
    if (comma < 0 || text.length() > AVATAR_URI)
      throw new Problem(400, "INVALID_AVATAR", "Не удалось прочитать картинку");
    var header = text.substring(0, comma);
    if (!header.equals("data:image/webp;base64")
        && !header.equals("data:image/png;base64")
        && !header.equals("data:image/jpeg;base64"))
      throw new Problem(400, "INVALID_AVATAR", "Не удалось прочитать картинку");
    try {
      var bytes = java.util.Base64.getDecoder().decode(text.substring(comma + 1));
      if (bytes.length == 0 || bytes.length > AVATAR_BYTES)
        throw new Problem(400, "INVALID_AVATAR", "Не удалось прочитать картинку");
    } catch (IllegalArgumentException e) {
      throw new Problem(400, "INVALID_AVATAR", "Не удалось прочитать картинку");
    }
    return text;
  }

  /**
   * Завершить встречу. {@code reason} — почему: {@code host} (ведущий), {@code empty} (все ушли),
   * {@code unused} (никто не вышел на связь), {@code ceiling} (потолок длительности), {@code
   * server} (владелец сервера). Причину видят статистика и журнал, участникам она не показывается.
   */
  public void close(RoomState room, String reason) {
    if (room.closedAt != null) return;
    room.closedAt = now();
    // Смотреть и играть вместе больше некому: закрытая комната не должна открывать ни плеер,
    // ни стол тому, кто зайдёт в неё за историей переписки.
    room.watch = null;
    archiveGame(room, "meeting", room.closedAt);
    room.poker = null;
    archiveDurak(room, room.closedAt);
    room.durak = null;
    room.chess = null;
    room.gartic = null;
    games.forget(room.id);
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
    room.presence.clear();
    room.presenceAsked.clear();
    room.idleSince = null;
    for (var observer : observers) observer.closed(room, reason, room.closedAt);
  }

  /**
   * Владелец сервера завершает встречу со страницы «Активность» (E10-B): то же, что «Завершить для
   * всех» у ведущего, — гаснут кино, музыка и столы, все выходят.
   */
  @Transactional
  /**
   * Завершить встречу рычагом владельца сервера. {@code hold} — на сколько её не открыть из
   * избранного ({@link RoomState#closedByServer}); ставится и у уже завершённой встречи.
   */
  public RoomState closeByServer(String roomId, java.time.Duration hold) {
    var room = lock(roomId);
    room.closedByServer = now() + hold.toMillis();
    if (room.closedAt != null) {
      rooms.save(room, now());
      return room;
    }
    close(room, "server");
    emit(room, "room.changed", EventPayload.changed());
    rooms.save(room, now());
    events.publishEvent(new RoomChanged(room.id));
    return room;
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
              config.retention().messages().toMillis(),
              endedAt + config.retention().closedHistory().toMillis(),
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
    for (var observer : observers) observer.changed(room, type, event.occurredAt());
    rooms
        .jdbc()
        .sql("DELETE FROM room_events WHERE room_id=? AND sequence<=?")
        .params(room.id, room.sequence - config.eventHistoryLimit())
        .update();
    published(room.id, event.sequence());
  }

  /**
   * Запомнить номер события, когда он станет виден в базе: после фиксации транзакции, а без неё —
   * сразу. Номер из откатившейся транзакции не запоминается — иначе сокеты комнаты каждую секунду
   * искали бы событие, которого нет.
   */
  private void published(String roomId, long sequence) {
    Runnable remember = () -> sequences.merge(roomId, sequence, Math::max);
    if (org.springframework.transaction.support.TransactionSynchronizationManager
        .isSynchronizationActive())
      org.springframework.transaction.support.TransactionSynchronizationManager
          .registerSynchronization(
              new org.springframework.transaction.support.TransactionSynchronization() {
                @Override
                public void afterCommit() {
                  remember.run();
                }
              });
    else remember.run();
  }

  /**
   * Последний зафиксированный номер события комнаты, известный этому процессу, или -1. Сокет с
   * номером не меньше этого догонять нечего — базу можно не спрашивать.
   */
  public long latest(String roomId) {
    return sequences.getOrDefault(roomId, -1L);
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
      // Снимок собирается на того, кто его просит: общий пересылать нельзя — в нём были бы
      // чужие карты.
      return new Replay(true, snapshotFor(room, member), List.of());
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
            now() + config.retention().messages().toMillis(),
            roomId)
        .update();
    return response;
  }
}
