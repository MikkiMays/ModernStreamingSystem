package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import dev.mikki.stream.access.Entrant;
import dev.mikki.stream.access.Identity;
import dev.mikki.stream.access.InternalKeys;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.api.ClientAddress;
import dev.mikki.stream.attachment.AttachmentService;
import dev.mikki.stream.attachment.TusGateway;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.events.RoomSocket;
import dev.mikki.stream.media.*;
import dev.mikki.stream.room.*;
import dev.mikki.stream.room.Contracts.*;
import dev.mikki.stream.shared.Json;
import dev.mikki.stream.shared.Problem;
import java.net.InetSocketAddress;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;
import org.assertj.core.api.ThrowableAssert;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

/**
 * Антибот (E11-B, {@code docs/abuse-model.md}): пределы на адрес и профиль, промахи кодом, частота
 * чата и кольцо истории, потолок длительности встречи, имена без подмены направления.
 *
 * <p>Контекст тот же, что у {@link RoomServiceTest}, — те же свойства и подмены, — поэтому Spring
 * поднимает его один раз на все три класса. Пределы по умолчанию — из {@code application.yml}.
 * Счётчики пределов живут в памяти процесса и переживают тест, поэтому у каждого теста свои адреса.
 */
@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:rooms;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.event-history-limit=10",
      "stream.files-root=./.local/test-uploads",
      "stream.max-rooms=200",
      // Механизм проверяется на трёх: по умолчанию с адреса — восемь (решение владельца
      // 20.10.2026).
      "stream.abuse.per-ip.open-rooms=3"
    })
@ActiveProfiles("local")
class AbuseLimitsTest {
  @Autowired RoomService rooms;
  @Autowired MediaService media;
  @Autowired Lifecycle lifecycle;
  @Autowired StreamProperties config;
  @Autowired ClientAddress address;
  @Autowired RateLimits limits;
  @Autowired JdbcClient jdbc;
  @Autowired RoomSocket socket;
  @Autowired AttachmentService attachments;
  @MockitoBean MediaGateway gateway;
  @MockitoBean TusGateway tus;
  @MockitoBean Clock clock;
  AtomicLong now = new AtomicLong(System.currentTimeMillis());

  @BeforeEach
  void setUp() {
    jdbc.sql("DELETE FROM command_receipts").update();
    jdbc.sql("DELETE FROM rooms").update();
    when(clock.millis()).thenAnswer(_ -> now.get());
    when(tus.terminate(anyString())).thenReturn(true);
  }

  final List<WebSocketSession> opened = new ArrayList<>();

  @AfterEach
  void forgetServerMisses() {
    rooms.forgetCodeMisses();
    for (var session : opened) socket.afterConnectionClosed(session, CloseStatus.NORMAL);
  }

  /** Адрес, которого ещё не видел ни один тест: счётчики пределов у него пустые. */
  static String fresh() {
    var r = ThreadLocalRandom.current();
    return "198.51." + r.nextInt(256) + "." + r.nextInt(256) + "/" + UUID.randomUUID();
  }

  static Entrant at(String address) {
    return Entrant.UNKNOWN.from(address);
  }

  static Entrant profile(String secret, String address) {
    return new Entrant(Identity.profileHash(secret), null, address);
  }

  Admission create(Entrant entrant) {
    return rooms.create(new Create(UUID.randomUUID(), "Встреча", "Хозяин", false), entrant);
  }

  Admission create(String name) {
    return rooms.create(new Create(UUID.randomUUID(), "Встреча", name, false));
  }

  Admission byCode(String code, Entrant entrant) {
    return rooms.joinCode(new JoinCode(UUID.randomUUID(), code, "Гость"), entrant);
  }

  Ack say(Admission admission, String text) {
    return rooms.command(
        admission.roomId(),
        admission.credential(),
        new Command(UUID.randomUUID(), "message.send", text, null, 0));
  }

  void connected(Admission admission) {
    media.observe(
        admission.roomId(), Map.of(admission.participantId(), "PA_first"), now.incrementAndGet());
  }

  static void refused(ThrowableAssert.ThrowingCallable call, int status, String code) {
    assertThatThrownBy(call)
        .isInstanceOfSatisfying(
            Problem.class,
            problem -> {
              assertThat(problem.code()).isEqualTo(code);
              assertThat(problem.status()).isEqualTo(status);
            });
  }

  // A1: встречи пачками ----------------------------------------------------------------------

  /**
   * Скрипт с одного адреса упирается в предел в час, а человек с другого адреса в ту же минуту
   * создаёт встречу без помех. Встречи скрипта без подключений перестают занимать сервер через 30
   * с.
   */
  @Test
  void aScriptRunsOutOfRoomsPerHourWhileAPersonStillCreates() {
    var script = fresh();
    assertThat(config.abuse().perIp().roomsCreated().count()).isEqualTo(10);
    for (int i = 0; i < 10; i++) {
      create(at(script));
      now.addAndGet(RoomState.FRESH_MS + 1);
    }
    refused(() -> create(at(script)), 429, "ROOMS_PER_HOUR");
    assertThat(create(at(fresh())).roomId()).isNotBlank();
  }

  /** Отказ не съедает предел: человек, которому не хватило места, может пробовать снова. */
  @Test
  void aRefusedCreationIsNotCountedAgainstTheHour() {
    var person = fresh();
    for (int i = 0; i < 3; i++) create(at(person));
    for (int i = 0; i < 20; i++) refused(() -> create(at(person)), 429, "OPEN_ROOMS");
    now.addAndGet(RoomState.FRESH_MS + 1);
    assertThat(create(at(person)).roomId()).isNotBlank();
  }

  /** С одного адреса одновременно место на сервере держат не больше трёх встреч. */
  @Test
  void oneAddressHoldsAtMostThreeBusyRooms() {
    var script = fresh();
    var held = new ArrayList<Admission>();
    for (int i = 0; i < 3; i++) held.add(create(at(script)));
    refused(() -> create(at(script)), 429, "OPEN_ROOMS");
    // Подключённые встречи держат место и дальше — предел тот же.
    held.forEach(this::connected);
    now.addAndGet(RoomState.FRESH_MS + 1);
    refused(() -> create(at(script)), 429, "OPEN_ROOMS");
    // Кончилась одна — место освободилось.
    rooms.command(
        held.getFirst().roomId(),
        held.getFirst().credential(),
        new Command(UUID.randomUUID(), "close", null, null, 0));
    assertThat(create(at(script)).roomId()).isNotBlank();
  }

  /** Профиль считается на любом адресе: новый адрес не обнуляет его предел в час. */
  @Test
  void aProfileRunsOutOfRoomsPerHourOnAnyAddress() {
    var secret = UUID.randomUUID().toString().replace("-", "").substring(0, 22).repeat(2);
    secret = secret.substring(0, 43);
    String previous = null;
    for (int i = 0; i < config.abuse().perProfile().roomsCreated().count(); i++) {
      var entrant = new Entrant(Identity.profileHash(secret), previous, fresh());
      previous = create(entrant).roomId();
      now.addAndGet(RoomState.FRESH_MS + 1);
    }
    var last = new Entrant(Identity.profileHash(secret), previous, fresh());
    refused(() -> create(last), 429, "ROOMS_PER_HOUR");
  }

  /** Служба без актора и тест без адреса пределов на адрес не знают. */
  @Test
  void anInternalCallerWithoutAnAddressIsNotCounted() {
    for (int i = 0; i < 12; i++) create("Служба");
  }

  /** IPv6 считается сетью /64: адреса одной квартиры — одна корзина. */
  @Test
  void ipv6CountsByNetwork() {
    assertThat(ClientAddress.network("2001:db8::1"))
        .isEqualTo(ClientAddress.network("2001:db8::2"));
    assertThat(ClientAddress.network("2001:db8:0:0:ffff::1")).isEqualTo("2001:db8:0:0::/64");
    assertThat(ClientAddress.network("2001:db8:0:1::1"))
        .isNotEqualTo(ClientAddress.network("2001:db8::1"));
    assertThat(ClientAddress.network("203.0.113.7")).isEqualTo("203.0.113.7");
    assertThat(ClientAddress.network("::ffff:203.0.113.7")).isEqualTo("203.0.113.7");
    var request = new MockHttpServletRequest();
    request.setRemoteAddr("2001:db8::abcd");
    assertThat(address.of(request)).isEqualTo("2001:db8:0:0::/64");
  }

  /**
   * Бот Telegram называет пользователя заголовком {@code X-Cord-Actor}, и пределы считаются по нему
   * — но только если запрос доказал, что пришёл от службы.
   */
  @Test
  void aServiceActorIsItsOwnBucketOnlyWithTheServiceSecret() {
    var request = new MockHttpServletRequest();
    request.setRemoteAddr("127.0.0.1");
    request.addHeader(ClientAddress.ACTOR, "tg:abcdefgh12345678");
    assertThat(address.of(request)).isEqualTo("127.0.0.1");
    request.addHeader("X-Service-Secret", config.internalSecret());
    // Сам секрет — не ключ службы (A14): актор остаётся без веры.
    assertThat(address.of(request)).isEqualTo("127.0.0.1");
    request.removeHeader("X-Service-Secret");
    request.addHeader("X-Service-Secret", InternalKeys.service(config.internalSecret()));
    assertThat(address.of(request)).isEqualTo("actor:tg:abcdefgh12345678");
  }

  /**
   * Бот раздаёт одно приглашение на комнату (A11): сто пятьдесят {@code /meet} подряд не выбирают
   * потолок в сто приглашений, и ведущий по-прежнему может пригласить сам.
   */
  @Test
  void theBotHandsOutOneInvitePerRoom() {
    var host = create("Хозяин");
    var first = rooms.serviceInvite(host.roomId());
    for (int i = 0; i < 150; i++) assertThat(rooms.serviceInvite(host.roomId())).isEqualTo(first);
    assertThat(rooms.read(host.roomId()).invites).hasSize(2);
    var guest =
        rooms.join(host.roomId(), new Join(UUID.randomUUID(), first.split("invite=")[1], "Гость"));
    assertThat(guest.participantId()).isNotBlank();
    // Ведущий отозвал приглашения — бот выдаёт новое.
    rooms.command(
        host.roomId(),
        host.credential(),
        new Command(UUID.randomUUID(), "invite.revoke", null, null, 0));
    assertThat(rooms.serviceInvite(host.roomId())).isNotEqualTo(first);
  }

  // A3: перебор кодов ------------------------------------------------------------------------

  /** Закрытая сохранённая встреча и несуществующий код отвечают одинаково: оракула нет. */
  @Test
  void aClosedRoomAndAMissLookTheSame() {
    var host = create("Хозяин");
    var code = rooms.read(host.roomId()).code;
    rooms.command(
        host.roomId(), host.credential(), new Command(UUID.randomUUID(), "close", null, null, 0));
    refused(() -> byCode(code, at(fresh())), 404, "CODE_INVALID");
    refused(() -> byCode(unused(code), at(fresh())), 404, "CODE_INVALID");
  }

  /** Двадцать промахов в час — и до конца окна этот адрес не входит по коду даже верным. */
  @Test
  void missesLockTheAddressOutEvenWithTheRightCode() {
    var host = create("Хозяин");
    var code = rooms.read(host.roomId()).code;
    var guesser = at(fresh());
    for (int i = 0; i < config.abuse().perIp().codeMisses().count(); i++)
      refused(() -> byCode(unused(code), guesser), 404, "CODE_INVALID");
    refused(() -> byCode(code, guesser), 429, "CODE_MISSES");
    assertThat(byCode(code, at(fresh())).participantId()).isNotBlank();
  }

  /**
   * Перебор с ботнета включает «щит»: пока серверный счётчик промахов не спадёт, верный код ведёт к
   * двери ведущего, а не внутрь.
   */
  @Test
  void aBotnetTurnsOnTheShieldAndCodesWaitForTheHost() {
    var host = create("Хозяин");
    var code = rooms.read(host.roomId()).code;
    assertThat(byCode(code, at(fresh())).snapshot().participants())
        .anyMatch(p -> p.status() == RoomState.Status.JOINING && p.name().equals("Гость"));
    for (int i = 0; i <= config.abuse().server().codeMisses().count(); i++)
      refused(() -> byCode(unused(code), at(fresh())), 404, "CODE_INVALID");
    var shielded = byCode(code, at(fresh()));
    assertThat(rooms.read(host.roomId()).members.get(shielded.participantId()).status)
        .isEqualTo(RoomState.Status.WAITING);
  }

  /** Код, которого точно нет ни у одной встречи. */
  String unused(String taken) {
    String code;
    do {
      code = String.format(Locale.ROOT, "%09d", ThreadLocalRandom.current().nextInt(1_000_000_000));
    } while (code.equals(taken)
        || jdbc.sql("SELECT COUNT(*) FROM rooms WHERE room_code=?")
                .param(code)
                .query(Long.class)
                .single()
            > 0);
    return code;
  }

  // A6: чат ----------------------------------------------------------------------------------

  /** Двадцать сообщений в минуту от участника, двадцать первое — отказ ему одному. */
  @Test
  void chatHasItsOwnRatePerMember() {
    var host = create("Хозяин");
    for (int i = 0; i < config.abuse().perMember().chatMessages().count(); i++)
      say(host, "Сообщение " + i);
    refused(() -> say(host, "Ещё одно"), 429, "CHAT_RATE");
    var guest =
        rooms.join(
            host.roomId(),
            new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"));
    assertThat(say(guest, "А я могу").ok()).isTrue();
  }

  /** Одно и то же подряд — не чаще раза в 30 секунд. */
  @Test
  void theSameMessageTwiceInARowWaits() {
    var host = create("Хозяин");
    say(host, "Купите слона");
    refused(() -> say(host, "Купите слона"), 429, "CHAT_REPEAT");
    say(host, "Другое");
    now.addAndGet(31_000);
    say(host, "Купите слона");
  }

  /** История — кольцо: сверх потолка уходят старейшие, а не замолкает вся комната. */
  @Test
  void historyIsARingNotAWall() {
    var host = create("Хозяин");
    int cap = config.chat().roomHistory();
    for (int i = 0; i < cap; i++)
      jdbc.sql(
              "INSERT INTO messages(id,room_id,participant_id,display_name,content,created_at)"
                  + " VALUES(?,?,?,?,?,?)")
          .params(
              UUID.randomUUID().toString(),
              host.roomId(),
              host.participantId(),
              "Хозяин",
              "Старое " + i,
              now.get() - cap + i)
          .update();
    say(host, "Новое");
    var texts =
        jdbc.sql("SELECT content FROM messages WHERE room_id=? ORDER BY created_at")
            .param(host.roomId())
            .query(String.class)
            .list();
    assertThat(texts).hasSize(cap).doesNotContain("Старое 0").endsWith("Новое");
  }

  // A2: вечные встречи -----------------------------------------------------------------------

  /**
   * Встреча с людьми на связи заканчивается по потолку, а за 15 минут до конца об этом знают все.
   */
  @Test
  void aMeetingEndsAtItsCeilingAfterAWarning() {
    var host = create("Хозяин");
    connected(host);
    long opened = rooms.read(host.roomId()).createdAt;
    long ceiling = config.meeting().maxDuration().toMillis();
    long warn = config.meeting().warnBefore().toMillis();
    now.set(opened + ceiling - warn - 1000);
    lifecycle.sweepRoom(host.roomId());
    assertThat(rooms.snapshot(host.roomId(), host.credential()).endsAt()).isNull();
    now.set(opened + ceiling - warn + 1000);
    lifecycle.sweepRoom(host.roomId());
    var warned = rooms.snapshot(host.roomId(), host.credential());
    assertThat(warned.closedAt()).isNull();
    assertThat(warned.endsAt()).isEqualTo(opened + ceiling);
    assertThat(events(host.roomId())).containsOnlyOnce("meeting.warning");
    lifecycle.sweepRoom(host.roomId());
    assertThat(events(host.roomId())).containsOnlyOnce("meeting.warning");
    now.set(opened + ceiling);
    lifecycle.sweepRoom(host.roomId());
    assertThat(closed(host.roomId())).isTrue();
  }

  // A8: трафик кинозала ---------------------------------------------------------------------

  /**
   * Служба кинозала говорит, какую долю потолка трафика встреча выбрала; встреча видит это в снимке
   * и узнаёт сразу ({@code room.changed}). Доля только растёт; повтор того же — без нового события.
   */
  @Test
  void theCinemaTrafficShareReachesTheRoom() {
    var host = create("Хозяин");
    assertThat(rooms.snapshot(host.roomId(), host.credential()).cinemaTraffic()).isNull();
    int before = events(host.roomId()).size();
    rooms.cinemaTraffic(host.roomId(), 80);
    assertThat(rooms.snapshot(host.roomId(), host.credential()).cinemaTraffic()).isEqualTo(80);
    assertThat(events(host.roomId())).hasSize(before + 1).last().isEqualTo("room.changed");
    rooms.cinemaTraffic(host.roomId(), 80);
    assertThat(events(host.roomId())).hasSize(before + 1);
    rooms.cinemaTraffic(host.roomId(), 100);
    rooms.cinemaTraffic(host.roomId(), 80);
    assertThat(rooms.snapshot(host.roomId(), host.credential()).cinemaTraffic()).isEqualTo(100);
    // Завершённой встрече сообщать нечего — и не ошибка: служба узнаёт о конце позже встречи.
    rooms.command(
        host.roomId(), host.credential(), new Command(UUID.randomUUID(), "close", null, null, 0));
    rooms.cinemaTraffic(host.roomId(), 100);
  }

  /** Встреча завершена — или уже удалена: несохранённая уходит вместе с разговором. */
  boolean closed(String roomId) {
    try {
      return rooms.read(roomId).closedAt != null;
    } catch (Problem gone) {
      return gone.code().equals("ROOM_NOT_FOUND");
    }
  }

  List<String> events(String roomId) {
    return jdbc
        .sql("SELECT body FROM room_events WHERE room_id=?")
        .param(roomId)
        .query(String.class)
        .list()
        .stream()
        .map(body -> body.replaceAll(".*\"type\":\"([^\"]+)\".*", "$1"))
        .toList();
  }

  /** Бот в пустой комнате её не держит: она закрывается сроком пустой комнаты. */
  @Test
  void aBotAloneDoesNotKeepTheRoom() {
    var host = create("Хозяин");
    connected(host);
    rooms.addMusicService(host.roomId(), UUID.randomUUID());
    rooms.command(
        host.roomId(), host.credential(), new Command(UUID.randomUUID(), "leave", null, null, 0));
    lifecycle.sweepRoom(host.roomId());
    now.addAndGet(config.emptyRoomSeconds() * 1000L + 1000);
    lifecycle.sweepRoom(host.roomId());
    assertThat(closed(host.roomId())).isTrue();
  }

  /**
   * Удержание через {@code rejoin} без медиа: встреча, где за срок неиспользованной комнаты никто
   * ни разу не вышел на связь, закрывается, сколько бы раз её ни «возвращали».
   */
  @Test
  void rejoiningWithoutMediaDoesNotKeepARoomAlive() {
    var host = create("Хозяин");
    var admission = host;
    for (int i = 0; i < 2; i++) {
      now.addAndGet(100_000);
      admission =
          rooms.rejoin(
              host.roomId(), admission.credential(), new Rejoin(UUID.randomUUID(), "Хозяин"));
      lifecycle.sweepRoom(host.roomId());
      assertThat(rooms.read(host.roomId()).closedAt).isNull();
    }
    now.set(rooms.read(host.roomId()).createdAt + config.unusedRoomSeconds() * 1000L);
    lifecycle.sweepRoom(host.roomId());
    assertThat(closed(host.roomId())).isTrue();
  }

  // A13: сокеты событий ---------------------------------------------------------------------

  WebSocketSession open(String ip) throws Exception {
    var session = mock(WebSocketSession.class);
    when(session.getId()).thenReturn(UUID.randomUUID().toString());
    when(session.getHandshakeHeaders()).thenReturn(new HttpHeaders());
    when(session.getRemoteAddress()).thenReturn(new InetSocketAddress(ip, 4000));
    when(session.isOpen()).thenReturn(true);
    opened.add(session);
    socket.afterConnectionEstablished(session);
    return session;
  }

  void auth(WebSocketSession session, Admission admission) throws Exception {
    socket.handleMessage(
        session,
        new TextMessage(
            Json.write(
                Map.of(
                    "type",
                    "auth",
                    "roomId",
                    admission.roomId(),
                    "credential",
                    admission.credential(),
                    "after",
                    -1))));
  }

  static String ip() {
    var r = ThreadLocalRandom.current();
    return "10." + r.nextInt(256) + "." + r.nextInt(256) + "." + (1 + r.nextInt(250));
  }

  /** Четвёртый сокет одного участника закрывает самый старый; остальные живут. */
  @Test
  void aFourthSocketOfOneMemberClosesTheOldest() throws Exception {
    var host = create("Хозяин");
    var sessions = new ArrayList<WebSocketSession>();
    for (int i = 0; i < 4; i++) {
      var session = open(ip());
      auth(session, host);
      sessions.add(session);
    }
    verify(sessions.getFirst()).close(CloseStatus.POLICY_VIOLATION);
    for (var session : sessions.subList(1, 4))
      verify(session, never()).close(CloseStatus.POLICY_VIOLATION);
  }

  /** Тридцать первый сокет с одного адреса закрывается сразу, сосед с другого адреса — нет. */
  @Test
  void aThirtyFirstSocketFromOneAddressIsRefused() throws Exception {
    var address = ip();
    for (int i = 0; i < config.abuse().perIp().sockets(); i++)
      verify(open(address), never()).close(any(CloseStatus.class));
    verify(open(address)).close(CloseStatus.POLICY_VIOLATION);
    verify(open(ip()), never()).close(any(CloseStatus.class));
  }

  /**
   * Простаивающий сокет не ходит в базу: проход {@code catchUp} сверяет номер события в памяти.
   * Доказательство — комната удалена из базы прямо из-под сокета, а он об этом не узнаёт, пока в
   * комнате не случится событие.
   */
  @Test
  void idleSocketsDoNotTouchTheDatabase() throws Exception {
    var host = create("Хозяин");
    var session = open(ip());
    auth(session, host);
    say(host, "Слышно?");
    socket.catchUp();
    verify(session, atLeastOnce())
        .sendMessage(argThat(m -> m.getPayload().toString().contains("message.created")));
    jdbc.sql("DELETE FROM rooms WHERE id=?").param(host.roomId()).update();
    for (int i = 0; i < 3; i++) socket.catchUp();
    verify(session, never()).close(any(CloseStatus.class));
  }

  // A5: ожидающие у двери не занимают мест ---------------------------------------------------

  Admission byInvite(Admission host, Entrant entrant) {
    return rooms.join(
        host.roomId(),
        new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"),
        entrant);
  }

  void approval(Admission host, boolean required) {
    rooms.roomSettings(host.roomId(), host.credential(), new RoomSettings("Встреча", required));
  }

  Ack approve(Admission host, String memberId) {
    return rooms.command(
        host.roomId(),
        host.credential(),
        new Command(UUID.randomUUID(), "participant.approve", null, memberId, 0));
  }

  /**
   * Полная встреча: двадцать человек внутри. Ожидающие допуска встают у двери вне мест — до своего
   * потолка, — а ведущий не может впустить сверх мест, пока кто-то не выйдет.
   */
  @Test
  void waitingPeopleStandOutsideTheSeats() {
    var host = create(at(fresh()));
    var seated = new ArrayList<Admission>();
    for (int i = 1; i < config.maxParticipants(); i++) seated.add(byInvite(host, at(fresh())));
    refused(() -> byInvite(host, at(fresh())), 409, "ROOM_FULL");
    approval(host, true);
    var waiting = new ArrayList<Admission>();
    for (int i = 0; i < config.meeting().waiting(); i++) waiting.add(byInvite(host, at(fresh())));
    assertThat(rooms.read(host.roomId()).seatedHumans()).isEqualTo(config.maxParticipants());
    refused(() -> byInvite(host, at(fresh())), 409, "WAITING_FULL");
    // Мест нет — ведущий не впускает; ушёл один — впускает.
    refused(() -> approve(host, waiting.getFirst().participantId()), 409, "ROOM_FULL");
    rooms.command(
        seated.getFirst().roomId(),
        seated.getFirst().credential(),
        new Command(UUID.randomUUID(), "leave", null, null, 0));
    approve(host, waiting.getFirst().participantId());
    assertThat(rooms.read(host.roomId()).members.get(waiting.getFirst().participantId()).status)
        .isEqualTo(RoomState.Status.JOINING);
  }

  /** Ожидающие не мешают войти тому, кого пускают без допуска (модель угроз A5). */
  @Test
  void tenWaitingDoNotKeepAnInvitedPersonOut() {
    var host = create(at(fresh()));
    for (int i = 2; i < config.maxParticipants(); i++) byInvite(host, at(fresh()));
    approval(host, true);
    for (int i = 0; i < config.meeting().waiting(); i++) byInvite(host, at(fresh()));
    approval(host, false);
    var invited = byInvite(host, at(fresh()));
    assertThat(rooms.read(host.roomId()).members.get(invited.participantId()).status)
        .isEqualTo(RoomState.Status.JOINING);
  }

  /** С одного адреса у двери одной встречи — не больше двух заявок; соседний адрес ждёт. */
  @Test
  void oneAddressQueuesAtMostTwiceAtOneDoor() {
    var host = rooms.create(new Create(UUID.randomUUID(), "Встреча", "Хозяин", true), at(fresh()));
    var address = at(fresh());
    for (int i = 0; i < config.abuse().perIp().waitingPerRoom(); i++) byInvite(host, address);
    refused(() -> byInvite(host, address), 429, "WAITING_LIMIT");
    assertThat(byInvite(host, at(fresh())).participantId()).isNotBlank();
  }

  // A6: чат с одного адреса ------------------------------------------------------------------

  Ack sayFrom(Admission admission, String text, String address) {
    return rooms.command(
        admission.roomId(),
        admission.credential(),
        new Command(UUID.randomUUID(), "message.send", text, null, 0),
        address);
  }

  /**
   * Свой предел сообщений есть у каждого участника, а у адреса — общий: десяток вкладок одного
   * скрипта не пишут вдесятеро больше. Сосед с другого адреса пишет дальше.
   */
  @Test
  void oneAddressHasAChatRateOfItsOwn() {
    var host = create(at(fresh()));
    var address = fresh();
    int perMember = config.abuse().perMember().chatMessages().count();
    int perIp = config.abuse().perIp().chatMessages().count();
    int sent = 0;
    while (sent < perIp) {
      var tab = byInvite(host, at(address));
      for (int i = 0; i < perMember && sent < perIp; i++, sent++)
        sayFrom(tab, "Сообщение " + sent, address);
    }
    var another = byInvite(host, at(address));
    refused(() -> sayFrom(another, "Ещё", address), 429, "CHAT_RATE_IP");
    assertThat(sayFrom(host, "А я пишу", fresh()).ok()).isTrue();
  }

  // A5, A7: имена ----------------------------------------------------------------------------

  /** Символы, переворачивающие направление текста, и невидимые символы из имени уходят. */
  @Test
  void bidiAndInvisibleCharactersLeaveNames() {
    var host = create("Иван‮exe.fdp​");
    assertThat(rooms.read(host.roomId()).members.get(host.participantId()).name)
        .isEqualTo("Иванexe.fdp");
    refused(() -> create("​‮"), 400, "NAME_INVALID");
  }

  /** Имя под Cord, администратора или поддержку — отказ, в том числе латиницей вперемешку. */
  @Test
  void reservedNamesAreRefused() {
    for (var name : List.of("Поддержка Cord", "Cord", "Администратор", "Сord support", "ADMIN"))
      refused(() -> create(name), 400, "NAME_RESERVED");
    for (var name : List.of("Cordelia", "Корделия", "Админка Пети", "Поддерживаю"))
      assertThat(create(name).participantId()).isNotBlank();
  }

  /**
   * Исполняемый файл под перевёрнутым именем: {@code a‮fdp.exe} показывался бы как {@code
   * aexe.pdf}. Символ уходит, а файл помечен — интерфейс предупредит перед скачиванием.
   */
  @Test
  void anExecutableHidingBehindAReversedNameIsFlagged() {
    var host = create("Хозяин");
    var file =
        attachments.reserve(
            host.roomId(),
            host.credential(),
            new AttachmentService.Reserve(UUID.randomUUID(), "a\u202Efdp.exe", 4));
    assertThat(file.name()).isEqualTo("afdp.exe");
    assertThat(file.executable()).isTrue();
    var guest =
        rooms.join(
            host.roomId(),
            new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"));
    var report =
        attachments.reserve(
            host.roomId(),
            guest.credential(),
            new AttachmentService.Reserve(UUID.randomUUID(), "отчёт.exe.pdf", 4));
    assertThat(report.executable()).isFalse();
    assertThat(AttachmentService.executable("архив.ZIP")).isTrue();
    assertThat(AttachmentService.executable("скрипт.ps1 ")).isTrue();
    assertThat(AttachmentService.executable("без расширения")).isFalse();
  }
}
