package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import dev.mikki.stream.access.Entrant;
import dev.mikki.stream.access.ProofOfWork;
import dev.mikki.stream.api.ApiController;
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
import java.security.SecureRandom;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.context.WebApplicationContext;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

/**
 * Защита ядра от постороннего скрипта (R236, {@code docs/architecture/core-scale.md} §6): кто
 * спрашивает и как часто — до любого замка; сокет событий закрывается на любой отказ во входе; цена
 * задачи «не робот».
 *
 * <p>Контекст тот же, что у {@link AbuseLimitsTest}, — Spring поднимает его один раз. Адреса и
 * профили у каждого теста свои: счётчики пределов переживают тест.
 */
@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:rooms;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.event-history-limit=10",
      "stream.files-root=./.local/test-uploads",
      "stream.abuse.per-ip.open-rooms=3"
    })
@ActiveProfiles("local")
class HardeningTest {
  private static final SecureRandom RANDOM = new SecureRandom();

  @Autowired RoomService rooms;
  @Autowired RoomRepository repository;
  @Autowired MediaService media;
  @Autowired FavoriteService favorites;
  @Autowired FavoriteGroupService groups;
  @Autowired AttachmentService attachments;
  @Autowired StreamProperties config;
  @Autowired ApiController api;
  @Autowired JdbcClient jdbc;
  @Autowired RoomSocket socket;
  @Autowired TransactionTemplate tx;
  @Autowired WebApplicationContext web;
  @MockitoBean MediaGateway gateway;
  @MockitoBean TusGateway tus;
  @MockitoBean Clock clock;
  final AtomicLong now = new AtomicLong(System.currentTimeMillis());
  final List<WebSocketSession> opened = new ArrayList<>();

  @BeforeEach
  void setUp() {
    jdbc.sql("DELETE FROM command_receipts").update();
    jdbc.sql("DELETE FROM rooms").update();
    when(clock.millis()).thenAnswer(_ -> now.get());
    when(tus.terminate(anyString())).thenReturn(true);
  }

  @AfterEach
  void closeSockets() {
    for (var session : opened) socket.afterConnectionClosed(session, CloseStatus.NORMAL);
  }

  static String ip() {
    var r = ThreadLocalRandom.current();
    return "10." + r.nextInt(256) + "." + r.nextInt(256) + "." + (1 + r.nextInt(250));
  }

  static Entrant at(String address) {
    return Entrant.UNKNOWN.from(address);
  }

  /** Секрет профиля устройства: 43 знака base64url. */
  static String profile() {
    var bytes = new byte[32];
    RANDOM.nextBytes(bytes);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  static String id() {
    return UUID.randomUUID().toString();
  }

  Admission create() {
    return rooms.create(new Create(UUID.randomUUID(), "Встреча", "Хозяин", false));
  }

  Admission guest(Admission host) {
    return rooms.join(
        host.roomId(), new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"));
  }

  static void refused(ThrowingCallable call, int status, String code) {
    assertThatThrownBy(call)
        .isInstanceOfSatisfying(
            Problem.class,
            problem -> {
              assertThat(problem.code()).isEqualTo(code);
              assertThat(problem.status()).isEqualTo(status);
            });
  }

  /**
   * Пока идёт {@code action}, замок держит чужая транзакция: действие, которому этот замок нужен,
   * не дождалось бы его и кончилось ошибкой базы, а не своим ответом.
   */
  void whileLocked(Runnable lock, ThrowingCallable action) throws Throwable {
    var held = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    var holder =
        Thread.ofPlatform()
            .start(
                () ->
                    tx.executeWithoutResult(
                        status -> {
                          lock.run();
                          held.countDown();
                          try {
                            release.await(60, TimeUnit.SECONDS);
                          } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                          }
                        }));
    try {
      assertThat(held.await(30, TimeUnit.SECONDS)).isTrue();
      action.call();
    } finally {
      release.countDown();
      holder.join();
    }
  }

  // Общий замок системы ----------------------------------------------------------------------

  /**
   * Выдуманный профиль, чужой пропуск, несуществующая встреча, запись, которой нет, — каждый такой
   * запрос получает свой отказ, не дойдя до общего замка системы: замок всё это время занят, а
   * ответы приходят. Раньше такие запросы вставали в одну очередь со входами во встречи.
   */
  @Test
  void aCallerWhoIsNotWhoHeSaysNeverReachesTheSystemLock() throws Throwable {
    var host = create();
    var visitor = guest(host);
    var owner = profile();
    var stranger = profile();
    favorites.save(owner, host.roomId(), host.credential());
    var file =
        attachments.reserve(
            host.roomId(),
            host.credential(),
            new AttachmentService.Reserve(UUID.randomUUID(), "document.txt", 4));
    var again = new Rejoin(UUID.randomUUID(), "Гость");
    whileLocked(
        repository::lockGlobal,
        () -> {
          // Избранное.
          refused(() -> favorites.remove("not-a-profile", host.roomId()), 403, "FORBIDDEN");
          favorites.remove(stranger, host.roomId());
          refused(() -> favorites.join(stranger, host.roomId(), again), 403, "FORBIDDEN");
          refused(() -> favorites.save(stranger, host.roomId(), "forged.pass"), 403, "FORBIDDEN");
          refused(() -> favorites.save(stranger, id(), host.credential()), 404, "ROOM_NOT_FOUND");
          refused(
              () -> favorites.reorder(stranger, List.of(host.roomId())), 409, "FAVORITES_CHANGED");
          favorites.reorder(stranger, List.of());
          // Группы избранного.
          groups.remove(stranger, id());
          refused(
              () -> groups.settings(stranger, host.roomId(), null, true, null),
              404,
              "FAVORITE_MISSING");
          refused(() -> groups.reorder(stranger, List.of(id())), 409, "FAVORITE_GROUPS_CHANGED");
          groups.reorder(stranger, List.of());
          // Двери во встречу.
          refused(
              () -> rooms.join(id(), new Join(UUID.randomUUID(), "forged", "Гость"), at(ip())),
              404,
              "ROOM_NOT_FOUND");
          refused(
              () ->
                  rooms.join(
                      host.roomId(), new Join(UUID.randomUUID(), "forged", "Гость"), at(ip())),
              403,
              "INVITE_INVALID");
          refused(
              () -> rooms.rejoin(host.roomId(), "forged.pass", again, at(ip())), 403, "FORBIDDEN");
          // Вложения.
          refused(
              () ->
                  attachments.reserve(
                      host.roomId(),
                      "forged.pass",
                      new AttachmentService.Reserve(UUID.randomUUID(), "a.txt", 4)),
              403,
              "FORBIDDEN");
          refused(() -> attachments.cancel(id(), host.credential()), 404, "FILE_NOT_FOUND");
          refused(() -> attachments.cancel(file.id(), visitor.credential()), 403, "FORBIDDEN");
          refused(() -> attachments.begin(file.id(), visitor.credential(), 4), 403, "FORBIDDEN");
        });
    // Замок свободен — настоящие запросы проходят как раньше.
    assertThat(favorites.list(owner)).hasSize(1);
    attachments.cancel(file.id(), host.credential());
    favorites.remove(owner, host.roomId());
    assertThat(favorites.list(owner)).isEmpty();
  }

  /** Повтор уже принятого входа по ссылке получает свой вход, даже если приглашение отозвали. */
  @Test
  void aRepeatedJoinStillAnswersAfterTheInviteIsRevoked() {
    var host = create();
    var join = new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость");
    var first = rooms.join(host.roomId(), join);
    rooms.command(
        host.roomId(),
        host.credential(),
        new Command(UUID.randomUUID(), "invite.revoke", null, null, 0));
    assertThat(rooms.join(host.roomId(), join).participantId()).isEqualTo(first.participantId());
    refused(
        () ->
            rooms.join(
                host.roomId(), new Join(UUID.randomUUID(), join.invite(), "Другой"), at(ip())),
        403,
        "INVITE_INVALID");
  }

  // Замок строки встречи ---------------------------------------------------------------------

  /**
   * Запрос с выдуманным пропуском не ждёт замка строки встречи: пока встречу держит чужая
   * транзакция (идёт команда участника), он получает «доступ закрыт» сразу.
   */
  @Test
  void aForgedPassNeverWaitsForTheRoomLock() throws Throwable {
    var host = create();
    var leave = new Command(UUID.randomUUID(), "leave", null, null, 0);
    whileLocked(
        () -> rooms.lock(host.roomId()),
        () -> {
          refused(() -> rooms.command(host.roomId(), "forged.pass", leave), 403, "FORBIDDEN");
          refused(
              () ->
                  rooms.roomSettings(
                      host.roomId(), "forged.pass", new RoomSettings("Встреча", true)),
              403,
              "FORBIDDEN");
          refused(
              () -> rooms.integrationSettings(host.roomId(), "forged.pass", false),
              403,
              "FORBIDDEN");
          refused(
              () -> media.screen(host.roomId(), "forged.pass", UUID.randomUUID(), true),
              403,
              "FORBIDDEN");
          refused(
              () -> media.move(host.roomId(), "forged.pass", UUID.randomUUID(), "main"),
              403,
              "FORBIDDEN");
          refused(() -> rooms.command(id(), host.credential(), leave), 404, "ROOM_NOT_FOUND");
        });
    // Настоящий участник — как раньше.
    assertThat(rooms.command(host.roomId(), host.credential(), leave).ok()).isTrue();
  }

  /**
   * Проверенный пропуск помнится минуту: настоящий участник не платит вторым чтением комнаты за
   * каждую команду, а через минуту проверка повторяется.
   */
  @Test
  void aVerifiedPassIsRememberedForAMinuteOnly() {
    var host = create();
    rooms.verify(host.roomId(), host.credential());
    jdbc.sql("DELETE FROM rooms WHERE id=?").param(host.roomId()).update();
    assertThatCode(() -> rooms.verify(host.roomId(), host.credential())).doesNotThrowAnyException();
    now.addAndGet(61_000);
    refused(() -> rooms.verify(host.roomId(), host.credential()), 404, "ROOM_NOT_FOUND");
  }

  // Пределы записей избранного и вложений ----------------------------------------------------

  static MockHttpServletRequestBuilder from(MockHttpServletRequestBuilder request, String ip) {
    return request.with(
        r -> {
          r.setRemoteAddr(ip);
          return r;
        });
  }

  /**
   * Удаление из избранного и удаление группы — под пределом, как остальные записи: строка, не
   * похожая на профиль, получает отказ, шестьдесят первая запись профиля за минуту и сто двадцать
   * первая с адреса — «слишком часто». Раньше у обоих удалений предела не было вовсе.
   */
  @Test
  void favoriteWritesAreCountedByProfileAndByAddress() throws Exception {
    MockMvc mvc = MockMvcBuilders.webAppContextSetup(web).build();
    var address = ip();
    mvc.perform(
            from(delete("/api/v1/favorites/{id}", id()), address)
                .header("Authorization", "not-a-profile"))
        .andExpect(status().isForbidden())
        .andExpect(jsonPath("$.code").value("FORBIDDEN"));
    var one = profile();
    for (int i = 0; i < 60; i++)
      mvc.perform(
              from(delete("/api/v1/favorites/{id}", id()), address).header("Authorization", one))
          .andExpect(status().isOk());
    mvc.perform(from(delete("/api/v1/favorites/{id}", id()), address).header("Authorization", one))
        .andExpect(status().isTooManyRequests())
        .andExpect(jsonPath("$.code").value("RATE_LIMITED"));
    // Группы избранного считаются тем же пределом профиля.
    mvc.perform(
            from(delete("/api/v1/favorites/groups/{id}", id()), ip()).header("Authorization", one))
        .andExpect(status().isTooManyRequests());
    // Новый профиль на каждый запрос предел профиля обходит, предел адреса — нет.
    int left = 120 - 62;
    for (int i = 0; i < left; i++)
      mvc.perform(
              from(delete("/api/v1/favorites/groups/{id}", id()), address)
                  .header("Authorization", profile()))
          .andExpect(status().isOk());
    mvc.perform(
            from(delete("/api/v1/favorites/{id}", id()), address)
                .header("Authorization", profile()))
        .andExpect(status().isTooManyRequests())
        .andExpect(jsonPath("$.code").value("RATE_LIMITED"));
    // Сосед с другого адреса — без помех.
    mvc.perform(
            from(delete("/api/v1/favorites/{id}", id()), ip()).header("Authorization", profile()))
        .andExpect(status().isOk());
  }

  /** Отмена загрузки — под пределом адреса, каким бы пропуском ни назвался запрос. */
  @Test
  void attachmentCancelsAreCountedByAddress() throws Exception {
    MockMvc mvc = MockMvcBuilders.webAppContextSetup(web).build();
    var address = ip();
    for (int i = 0; i < 60; i++)
      mvc.perform(
              from(delete("/api/v1/attachments/{id}", id()), address)
                  .header("Authorization", "forged-" + i + ".pass"))
          .andExpect(status().isNotFound());
    mvc.perform(
            from(delete("/api/v1/attachments/{id}", id()), address)
                .header("Authorization", "forged.pass"))
        .andExpect(status().isTooManyRequests())
        .andExpect(jsonPath("$.code").value("RATE_LIMITED"));
  }

  // Сокет событий ----------------------------------------------------------------------------

  WebSocketSession open() throws Exception {
    var session = mock(WebSocketSession.class);
    when(session.getId()).thenReturn(UUID.randomUUID().toString());
    when(session.getHandshakeHeaders()).thenReturn(new HttpHeaders());
    when(session.getRemoteAddress()).thenReturn(new InetSocketAddress(ip(), 4000));
    when(session.isOpen()).thenReturn(true);
    opened.add(session);
    socket.afterConnectionEstablished(session);
    return session;
  }

  void auth(WebSocketSession session, String roomId, String credential) throws Exception {
    socket.handleMessage(
        session,
        new TextMessage(
            Json.write(
                Map.of("type", "auth", "roomId", roomId, "credential", credential, "after", -1))));
  }

  static TextMessage says(String code) {
    return argThat(message -> message != null && message.getPayload().contains(code));
  }

  /**
   * Любой отказ во входе закрывает сокет, и попытка у сокета одна: после отказа его пакеты ядро не
   * читает — даже с верным пропуском. Раньше «нет такой встречи» сокет не закрывало, и за пять
   * секунд жизни безымянного сокета в него помещалось сколько угодно попыток с чтением базы.
   */
  @Test
  void anyRefusedSocketEntryClosesTheSocketAndThereIsOneAttempt() throws Exception {
    var host = create();
    var lost = open();
    auth(lost, id(), host.credential());
    verify(lost).sendMessage(says("ROOM_NOT_FOUND"));
    verify(lost).close(CloseStatus.POLICY_VIOLATION);
    auth(lost, host.roomId(), host.credential());
    verify(lost, never()).sendMessage(says("authenticated"));

    var forged = open();
    auth(forged, host.roomId(), "forged.pass");
    verify(forged).sendMessage(says("FORBIDDEN"));
    verify(forged).close(CloseStatus.POLICY_VIOLATION);

    var rude = open();
    socket.handleMessage(rude, new TextMessage(Json.write(Map.of("type", "ping"))));
    verify(rude).close(CloseStatus.POLICY_VIOLATION);
    auth(rude, host.roomId(), host.credential());
    verify(rude, never()).sendMessage(says("authenticated"));

    var junk = open();
    auth(junk, "not-a-room", host.credential());
    verify(junk).close(CloseStatus.BAD_DATA);
    auth(junk, host.roomId(), host.credential());
    verify(junk, never()).sendMessage(says("authenticated"));

    // Верный вход — как раньше.
    var fine = open();
    auth(fine, host.roomId(), host.credential());
    verify(fine).sendMessage(says("authenticated"));
    verify(fine, never()).close(any(CloseStatus.class));
  }

  // Цена задачи «не робот» -------------------------------------------------------------------

  /**
   * Задача «не робот» по умолчанию стоит 250 000 (Р-158): доли секунды в браузере, а не
   * миллисекунды скрипту. Множитель прежний: адрес, выбравший половину своего предела встреч,
   * получает вчетверо дороже.
   */
  @Test
  void theProofCostsAQuarterMillionAndFourTimesMoreUnderPressure() {
    assertThat(config.abuse().proofCost()).isEqualTo(250_000);
    var address = ip();
    var request = new MockHttpServletRequest("GET", "/api/v1/proof");
    request.setRemoteAddr(address);
    ProofOfWork.Challenge calm = api.proof("create", request).getBody();
    assertThat(calm).isNotNull();
    assertThat(calm.maxnumber()).isEqualTo(250_000);
    for (int i = 0; i < config.abuse().perIp().roomsCreated().count() / 2; i++) {
      rooms.create(new Create(UUID.randomUUID(), "Встреча", "Хозяин", false), at(address));
      now.addAndGet(RoomState.FRESH_MS + 1);
    }
    ProofOfWork.Challenge pressed = api.proof("create", request).getBody();
    assertThat(pressed).isNotNull();
    assertThat(pressed.maxnumber()).isEqualTo(1_000_000);
  }
}
