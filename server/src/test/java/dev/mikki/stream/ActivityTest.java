package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

import dev.mikki.stream.access.AdminAccess;
import dev.mikki.stream.access.Blocks;
import dev.mikki.stream.access.Entrant;
import dev.mikki.stream.access.Identity;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.activity.ActivityReport;
import dev.mikki.stream.activity.ActivityRollup;
import dev.mikki.stream.activity.Audit;
import dev.mikki.stream.activity.ClientQuality;
import dev.mikki.stream.activity.Metrics;
import dev.mikki.stream.api.ActivityController;
import dev.mikki.stream.api.ApiController;
import dev.mikki.stream.api.ApiErrors;
import dev.mikki.stream.api.BlockGuard;
import dev.mikki.stream.api.ClientAddress;
import dev.mikki.stream.attachment.TusGateway;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.media.MediaGateway;
import dev.mikki.stream.media.MediaService;
import dev.mikki.stream.room.*;
import dev.mikki.stream.room.Contracts.*;
import dev.mikki.stream.shared.Problem;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Clock;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/**
 * Наблюдаемость и рычаги владельца (E10-B): статистика встреч, журнал аудита, блокировки и
 * автоблок, «Вы ещё здесь?», кино и музыка без людей на связи, метры.
 *
 * <p>Контекст — тот же, что у {@link RoomServiceTest} и {@link AbuseLimitsTest}: Spring поднимает
 * его один раз. Пароля владельца в нём нет, поэтому контроллер страницы «Активность» собирается
 * здесь руками со своим {@link AdminAccess}. Адреса у каждого теста свои: счётчики пределов и кэш
 * блоков переживают тест.
 */
@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:rooms;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.event-history-limit=10",
      "stream.files-root=./.local/test-uploads",
      "stream.max-rooms=200"
    })
@ActiveProfiles("local")
class ActivityTest {
  @Autowired RoomService rooms;
  @Autowired RoomRepository repository;
  @Autowired MediaService media;
  @Autowired Lifecycle lifecycle;
  @Autowired StreamProperties config;
  @Autowired JdbcClient jdbc;
  @Autowired ApiController api;
  @Autowired Blocks blocks;
  @Autowired BlockGuard guard;
  @Autowired Secrets secrets;
  @Autowired Audit audit;
  @Autowired ActivityReport report;
  @Autowired ActivityRollup rollup;
  @Autowired Metrics metrics;
  @Autowired MeterRegistry registry;
  @Autowired RateLimits limits;
  @Autowired ClientAddress address;
  @Autowired dev.mikki.stream.room.Maintenance maintenance;
  @MockitoBean MediaGateway gateway;
  @MockitoBean TusGateway tus;
  @MockitoBean Clock clock;
  AtomicLong now = new AtomicLong(System.currentTimeMillis());

  @BeforeEach
  void setUp() {
    jdbc.sql("DELETE FROM command_receipts").update();
    jdbc.sql("DELETE FROM rooms").update();
    jdbc.sql("DELETE FROM meeting_stats").update();
    jdbc.sql("DELETE FROM audit_events").update();
    when(clock.millis()).thenAnswer(_ -> now.get());
    when(tus.terminate(anyString())).thenReturn(true);
  }

  /** Адрес, которого ещё не видел ни один тест. */
  static String fresh() {
    return "192.0.2." + (int) (Math.random() * 250) + "/" + UUID.randomUUID();
  }

  Admission host(Entrant entrant) {
    return rooms.create(
        new Create(UUID.randomUUID(), "Секретная встреча", "Организатор", false), entrant);
  }

  Admission guest(Admission host) {
    return rooms.join(
        host.roomId(), new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"));
  }

  void present(String roomId, Admission... who) {
    var map = new HashMap<String, String>();
    for (var a : who) map.put(a.participantId(), "PA_" + a.participantId());
    media.observe(roomId, map, now.incrementAndGet());
  }

  Ack command(Admission admission, String type, String text) {
    return rooms.command(
        admission.roomId(),
        admission.credential(),
        new Command(UUID.randomUUID(), type, text, null, 0));
  }

  Map<String, Object> stats(String roomId) {
    return jdbc.sql("SELECT * FROM meeting_stats WHERE room_id=?")
        .param(roomId)
        .query()
        .singleRow();
  }

  long number(Object value) {
    return ((Number) value).longValue();
  }

  // Статистика встреч ---------------------------------------------------------------------------

  /**
   * Встреча считается от двух людей на связи (П7) до конца: человеко-секунды — сумма по людям, пик
   * — двое, причина — ведущий завершил. Один человек в комнате — ещё не встреча.
   */
  @Test
  void aMeetingIsCountedFromTwoPeopleOnlineToItsEnd() {
    var alone = host(Entrant.UNKNOWN);
    present(alone.roomId(), alone);
    assertThat(jdbc.sql("SELECT COUNT(*) FROM meeting_stats").query(Long.class).single()).isZero();

    var counter = registry.find("cord.meetings.started").counter();
    long started = counter == null ? 0 : (long) counter.count();
    var host = host(Entrant.UNKNOWN);
    var guest = guest(host);
    present(host.roomId(), host, guest);
    var row = stats(host.roomId());
    assertThat(number(row.get("peak_humans"))).isEqualTo(2);
    assertThat(row.get("ended_at")).isNull();
    assertThat((long) registry.get("cord.meetings.started").counter().count())
        .isEqualTo(started + 1);

    now.addAndGet(60_000);
    present(host.roomId(), host);
    now.addAndGet(30_000);
    command(host, "message.send", "пароль от сейфа");
    command(host, "close", null);
    row = stats(host.roomId());
    assertThat(row.get("end_reason")).isEqualTo("host");
    assertThat(number(row.get("human_seconds"))).isBetween(149L, 151L);
    assertThat(number(row.get("messages"))).isEqualTo(1);
    assertThat(number(row.get("unique_devices"))).isEqualTo(2);
    assertThat(row.get("ended_at")).isNotNull();
  }

  // Журнал аудита -------------------------------------------------------------------------------

  /**
   * Журнал знает, кто вошёл, откуда (отпечатком) и под каким именем, — и не знает ни названия
   * встречи, ни слова из переписки. Отказ во входе — тоже строка, с кодом.
   */
  @Test
  void theJournalKnowsWhoEnteredButNotWhatWasSaid() {
    var host = host(Entrant.UNKNOWN);
    command(host, "message.send", "пароль от сейфа");
    var where = fresh();
    var http = new MockHttpServletRequest("POST", "/api/v1/rooms/" + host.roomId() + "/join");
    http.setRemoteAddr(where);
    var guest =
        api.join(
            UUID.fromString(host.roomId()),
            new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"),
            http);
    assertThatThrownBy(
            () ->
                api.join(
                    UUID.fromString(host.roomId()),
                    new Join(UUID.randomUUID(), "не-то-приглашение", "Чужой"),
                    http))
        .isInstanceOf(Problem.class);

    var page =
        audit.query(
            new Audit.Filter(null, null, "participant", null, null, null, null, null, null));
    var joined =
        page.items().stream().filter(e -> "ok".equals(e.outcome())).findFirst().orElseThrow();
    assertThat(joined.actorName()).isEqualTo("Гость");
    assertThat(joined.targetId()).isEqualTo(guest.participantId());
    assertThat(joined.ipHash()).isEqualTo(secrets.address(where));
    assertThat(joined.roomCode()).isEqualTo(guest.snapshot().code());
    var denied =
        page.items().stream().filter(e -> "denied".equals(e.outcome())).findFirst().orElseThrow();
    assertThat(denied.code()).isEqualTo("INVITE_INVALID");

    var everything =
        jdbc.sql("SELECT * FROM audit_events").query().listOfRows().toString()
            + jdbc.sql("SELECT * FROM meeting_stats").query().listOfRows();
    assertThat(everything)
        .doesNotContain("Секретная встреча")
        .doesNotContain("пароль от сейфа")
        .doesNotContain(where.split("/")[0]);
  }

  // Блокировки ----------------------------------------------------------------------------------

  MockHttpServletResponse through(String uri, String remote, String profile) throws Exception {
    var request = new MockHttpServletRequest("POST", uri);
    request.setRequestURI(uri);
    request.setRemoteAddr(remote);
    if (profile != null) request.addHeader(Identity.PROFILE, profile);
    var response = new MockHttpServletResponse();
    var chain = new MockFilterChain();
    guard.doFilter(request, response, chain);
    response.setHeader("X-Reached", Boolean.toString(chain.getRequest() != null));
    return response;
  }

  /**
   * Заблокированный адрес останавливается у двери любой встречи — ответом, который клиент может
   * прочесть, с моментом окончания. Соседний адрес проходит; страница владельца открыта и с
   * заблокированного адреса — иначе блок по ошибке было бы некому снять.
   */
  @Test
  void aBlockedAddressStopsAtTheDoorButTheOwnerPageStaysOpen() throws Exception {
    var blocked = fresh();
    var block =
        blocks.block(Blocks.IP, secrets.address(blocked), Duration.ofHours(1), "проверка", "admin");
    var refused = through("/api/v1/rooms/join-by-code", blocked, null);
    assertThat(refused.getStatus()).isEqualTo(403);
    assertThat(refused.getContentAsString()).contains("\"code\":\"BLOCKED\"").contains("until");
    assertThat(refused.getHeader("X-Reached")).isEqualTo("false");
    assertThat(through("/internal/signaling-auth", blocked, null).getStatus()).isEqualTo(403);
    assertThat(through("/api/v1/rooms/join-by-code", fresh(), null).getHeader("X-Reached"))
        .isEqualTo("true");
    assertThat(through("/api/v1/admin/now", blocked, null).getHeader("X-Reached"))
        .isEqualTo("true");
    assertThat(through("/api/v1/capabilities", blocked, null).getHeader("X-Reached"))
        .isEqualTo("true");

    assertThat(blocks.lift(block.id())).isPresent();
    assertThat(through("/api/v1/rooms/join-by-code", blocked, null).getHeader("X-Reached"))
        .isEqualTo("true");
  }

  /** IPv6 блокируется сетью /64, профиль — хэшем секрета устройства. */
  @Test
  void ipv6IsBlockedByItsNetworkAndAProfileByItsSecret() throws Exception {
    var net = Integer.toHexString((int) (Math.random() * 0xfff0) + 1);
    blocks.block(
        Blocks.IP,
        secrets.address(ClientAddress.network("2001:db8:" + net + ":1::5")),
        null,
        null,
        "admin");
    assertThat(through("/api/v1/rooms", "2001:db8:" + net + ":1::9", null).getStatus())
        .isEqualTo(403);
    assertThat(through("/api/v1/rooms", "2001:db8:" + net + ":2::9", null).getStatus())
        .isNotEqualTo(403);

    var secret = UUID.randomUUID().toString().replace("-", "") + "abcdefghijk";
    blocks.block(Blocks.PROFILE, Identity.profileHash(secret), null, null, "admin");
    assertThat(through("/api/v1/rooms", fresh(), secret).getStatus()).isEqualTo(403);
  }

  /**
   * Десять отказов «слишком часто» за десять минут — и адрес закрыт сам на полчаса, с записью в
   * журнале. Отказы не про адрес («все комнаты заняты») к этому не ведут: офис за одним NAT не
   * закрывается из-за того, что сервер полон.
   */
  @Test
  void tenRefusalsAboutAnAddressCloseItForAWhile() throws Exception {
    var script = fresh();
    var office = fresh();
    for (int i = 0; i < 12; i++) {
      refusal(script, "RATE_LIMITED");
      refusal(office, "ROOM_LIMIT");
    }
    var until = blocks.blockedUntil(script, null);
    assertThat(until).isPresent();
    assertThat(until.get() - now.get())
        .isBetween(Duration.ofMinutes(29).toMillis(), Duration.ofMinutes(31).toMillis());
    assertThat(blocks.blockedUntil(office, null)).isEmpty();
    assertThat(
            audit
                .query(new Audit.Filter(null, null, "block", null, null, null, null, null, null))
                .items())
        .anySatisfy(e -> assertThat(e.action()).isEqualTo("block.auto"));
  }

  private void refusal(String remote, String code) throws Exception {
    var request = new MockHttpServletRequest("POST", "/api/v1/rooms");
    request.setRequestURI("/api/v1/rooms");
    request.setRemoteAddr(remote);
    var response = new MockHttpServletResponse();
    guard.doFilter(
        request,
        response,
        (req, res) -> {
          req.setAttribute(ApiErrors.CODE, code);
          ((HttpServletResponse) res).setStatus(429);
        });
  }

  // Страница «Активность» и рычаги --------------------------------------------------------------

  ActivityController owner() {
    var withPassword = spy(config);
    doReturn("пароль владельца").when(withPassword).adminPassword();
    return new ActivityController(
        new AdminAccess(secrets, withPassword),
        report,
        audit,
        blocks,
        rooms,
        limits,
        address,
        secrets,
        config,
        metrics,
        maintenance);
  }

  /**
   * Владелец закрывает встречу и блокирует её создателя одним действием: адрес и профиль создателя
   * закрыты, встреча завершена с причиной «сервер», и всё это есть в журнале.
   */
  @Test
  void theOwnerClosesAMeetingAndBlocksItsCreator() throws Exception {
    var owner = owner();
    var http = new MockHttpServletRequest("POST", "/api/v1/admin/session");
    http.setRemoteAddr(fresh());
    assertThatThrownBy(() -> owner.login(new ActivityController.Login("не тот"), http))
        .isInstanceOfSatisfying(Problem.class, p -> assertThat(p.status()).isEqualTo(401));
    var token = owner.login(new ActivityController.Login("пароль владельца"), http).token();

    var from = fresh();
    var secret = UUID.randomUUID().toString().replace("-", "") + "zyxwvutsrqp";
    var host = host(new Entrant(Identity.profileHash(secret), null, from));
    var guest = guest(host);
    present(host.roomId(), host, guest);
    assertThat(owner.now(token).rooms())
        .anySatisfy(r -> assertThat(r.id()).isEqualTo(host.roomId()));

    owner.close(
        token, UUID.fromString(host.roomId()), new ActivityController.Close(true, "1 hour"), http);

    assertThat(rooms.read(host.roomId()).closedAt).isNotNull();
    assertThat(stats(host.roomId()).get("end_reason")).isEqualTo("server");
    assertThat(blocks.blockedUntil(from, null)).isPresent();
    assertThat(blocks.blockedUntil(fresh(), Identity.profileHash(secret))).isPresent();
    var actions =
        audit
            .query(new Audit.Filter(null, null, null, null, null, null, null, null, null))
            .items()
            .stream()
            .map(Audit.Event::action)
            .toList();
    assertThat(actions)
        .contains("admin.login", "admin.room_closed", "block.created", "room.closed");
    assertThatThrownBy(() -> owner.now(null))
        .isInstanceOfSatisfying(
            Problem.class, p -> assertThat(p.code()).isEqualTo("ADMIN_REQUIRED"));
  }

  /**
   * Встреча, которую завершил владелец сервера, не открывается из избранного до конца срока ({@code
   * closedByServer}) — ни создателем, ни кем-то ещё; после срока открывается как обычно.
   */
  @Test
  void aMeetingClosedByTheOwnerDoesNotReopenFromFavoritesUntilItsTerm() throws Exception {
    var owner = owner();
    var http = new MockHttpServletRequest("POST", "/api/v1/admin/session");
    http.setRemoteAddr(fresh());
    var token = owner.login(new ActivityController.Login("пароль владельца"), http).token();
    var host = host(Entrant.UNKNOWN);
    var guest = guest(host);
    present(host.roomId(), host, guest);

    owner.close(
        token, UUID.fromString(host.roomId()), new ActivityController.Close(false, "1 hour"), http);
    var closed = rooms.read(host.roomId());
    assertThat(closed.closedByServer).isEqualTo(now.get() + Duration.ofHours(1).toMillis());

    for (var who : List.of(host, guest))
      assertThatThrownBy(
              () ->
                  rooms.joinSaved(
                      host.roomId(), who.participantId(), new Rejoin(UUID.randomUUID(), "Снова")))
          .isInstanceOfSatisfying(
              Problem.class,
              p -> {
                assertThat(p.status()).isEqualTo(403);
                assertThat(p.code()).isEqualTo("CLOSED_BY_SERVER");
                assertThat(p.properties()).containsEntry("until", closed.closedByServer);
              });
    assertThat(rooms.read(host.roomId()).closedAt).isNotNull();

    now.addAndGet(Duration.ofHours(1).toMillis() + 1);
    rooms.joinSaved(host.roomId(), host.participantId(), new Rejoin(UUID.randomUUID(), "Снова"));
    var reopened = rooms.read(host.roomId());
    assertThat(reopened.closedAt).isNull();
    assertThat(reopened.closedByServer).isNull();
  }

  /** Срок, которого владелец не выбрал, — срок блока по умолчанию ({@code default-term}). */
  @Test
  void withoutATermTheMeetingStaysClosedForTheDefaultOne() throws Exception {
    var owner = owner();
    var http = new MockHttpServletRequest("POST", "/api/v1/admin/session");
    http.setRemoteAddr(fresh());
    var token = owner.login(new ActivityController.Login("пароль владельца"), http).token();
    var host = host(Entrant.UNKNOWN);
    owner.close(token, UUID.fromString(host.roomId()), null, http);
    assertThat(rooms.read(host.roomId()).closedByServer)
        .isEqualTo(now.get() + config.abuse().blocks().defaultTerm().toMillis());
  }

  // Качество связи от браузеров (client-report) ---------------------------------------------------

  static ClientQuality.Report call(
      int seconds, Integer rtt, Double loss, Integer jitter, String path, String codec) {
    return new ClientQuality.Report(seconds, rtt, loss, jitter, 1800, 2, 3, 40, path, codec);
  }

  MockHttpServletRequest reporter() {
    var http = new MockHttpServletRequest("POST", "/api/v1/rooms/x/client-report");
    http.setRemoteAddr(fresh());
    return http;
  }

  /**
   * Итог звонка от браузера ложится в строку его встречи — числами и словами из перечислений, без
   * имён, адресов и номеров. Один итог на вход; второй — отказ «слишком часто».
   */
  @Test
  void aCallSummaryIsAddedToItsMeetingOncePerEntry() {
    var host = host(Entrant.UNKNOWN);
    var guest = guest(host);
    present(host.roomId(), host, guest);
    var room = UUID.fromString(host.roomId());

    api.clientReport(
        room,
        "Bearer " + guest.credential(),
        call(600, 40, 1.5, 12, "relay-udp", "vp8"),
        reporter());
    assertThatThrownBy(
            () ->
                api.clientReport(
                    room,
                    "Bearer " + guest.credential(),
                    call(600, 40, 1.5, 12, "relay-udp", "vp8"),
                    reporter()))
        .isInstanceOfSatisfying(Problem.class, p -> assertThat(p.code()).isEqualTo("RATE_LIMITED"));
    api.clientReport(
        room,
        "Bearer " + host.credential(),
        call(300, null, null, null, "direct-udp", "h264"),
        reporter());

    var row = stats(host.roomId());
    assertThat(number(row.get("quality_reports"))).isEqualTo(2);
    assertThat(number(row.get("quality_seconds"))).isEqualTo(900);
    assertThat(number(row.get("rtt_ms_sum"))).isEqualTo(40);
    assertThat(number(row.get("rtt_reports"))).isEqualTo(1);
    assertThat(number(row.get("loss_permille_sum"))).isEqualTo(15);
    assertThat(number(row.get("relay_reports"))).isEqualTo(1);
    assertThat(number(row.get("freezes"))).isEqualTo(4);
    assertThat(row.get("codecs")).isEqualTo("h264 vp8");

    var quality = report.quality(now.get() - 60_000, now.get() + 60_000, 0);
    assertThat(quality.reports()).isEqualTo(2);
    assertThat(quality.meetings()).isEqualTo(1);
    assertThat(quality.rttMs()).isEqualTo(40);
    assertThat(quality.lossPercent()).isEqualTo(1.5);
    assertThat(quality.relayShare()).isEqualTo(0.5);
    assertThat(quality.lossyShare()).isCloseTo(80.0 / 900, within(1e-9));
    assertThat(quality.codecs()).containsEntry("vp8", 1).containsEntry("h264", 1);
    assertThat(quality.days()).hasSize(1);
    assertThat(quality.recent())
        .singleElement()
        .satisfies(
            m -> {
              assertThat(m.code()).isEqualTo(rooms.read(host.roomId()).code);
              assertThat(m.reports()).isEqualTo(2);
            });

    assertThatThrownBy(
            () ->
                api.clientReport(
                    room, "Bearer nobody.secret", call(1, 1, 0.0, 1, "unknown", null), reporter()))
        .isInstanceOfSatisfying(Problem.class, p -> assertThat(p.status()).isEqualTo(403));
  }

  /** Один человек в комнате — ещё не встреча (П7): итог принят, но лечь ему некуда. */
  @Test
  void aCallAloneIsNotAMeetingAndLeavesNoTrace() {
    var alone = host(Entrant.UNKNOWN);
    present(alone.roomId(), alone);
    api.clientReport(
        UUID.fromString(alone.roomId()),
        "Bearer " + alone.credential(),
        call(60, 20, 0.0, 3, "direct-udp", "vp8"),
        reporter());
    assertThat(jdbc.sql("SELECT COUNT(*) FROM meeting_stats").query(Long.class).single()).isZero();
  }

  /** Что браузер может прислать — только числа в пределах и слова из перечислений. */
  @Test
  void aSummaryIsNumbersInBoundsAndWordsFromALongList() {
    var validator = jakarta.validation.Validation.buildDefaultValidatorFactory().getValidator();
    assertThat(validator.validate(call(600, 40, 1.5, 12, "relay-tcp", "av1"))).isEmpty();
    assertThat(validator.validate(call(600, 40, 1.5, 12, "Иван", "av1"))).isNotEmpty();
    assertThat(validator.validate(call(600, 40, 1.5, 12, "direct-udp", "x264-my-camera")))
        .isNotEmpty();
    assertThat(validator.validate(call(-1, 40, 1.5, 12, "direct-udp", null))).isNotEmpty();
    assertThat(validator.validate(call(600, 40, 101.0, 12, "direct-udp", null))).isNotEmpty();
    assertThat(validator.validate(call(90_000, 40, 1.0, 12, "direct-udp", null))).isNotEmpty();
  }

  /** Итоги за период и итоги дня: встреча, человеко-секунды, пик. */
  @Test
  void thePeriodAndTheDayAddUp() {
    var host = host(Entrant.UNKNOWN);
    var guest = guest(host);
    long start = now.get();
    present(host.roomId(), host, guest);
    now.addAndGet(600_000);
    command(host, "close", null);
    var summary = report.summary(start - 60_000, now.get() + 60_000, 180);
    assertThat(summary.meetings()).isEqualTo(1);
    assertThat(summary.humanSeconds()).isBetween(1199L, 1201L);
    assertThat(summary.peakHumans()).isEqualTo(2);
    assertThat(summary.endReasons()).containsEntry("host", 1);
    rollup.run();
    var day =
        jdbc.sql("SELECT meetings, human_seconds FROM activity_daily ORDER BY day_utc DESC")
            .query()
            .listOfRows();
    assertThat(day).isNotEmpty();
  }

  // «Вы ещё здесь?» и кино без людей на связи ---------------------------------------------------

  /**
   * Кто молчит дольше {@code presence-check}, того спрашивают — полем {@code you.presenceBy}; ответ
   * гасит вопрос. Не ответил и за {@code presence-answer} — обычный выход.
   */
  @Test
  void aSilentPersonIsAskedAndLeavesWithoutAnAnswer() {
    var meeting = config.meeting();
    var host = host(Entrant.UNKNOWN);
    present(host.roomId(), host);
    now.addAndGet(meeting.presenceCheck().toMillis() + 1000);
    present(host.roomId(), host);
    lifecycle.sweepRoom(host.roomId());
    assertThat(rooms.snapshot(host.roomId(), "Bearer " + host.credential()).you().presenceBy())
        .isNotNull();

    command(host, "presence.confirm", null);
    assertThat(rooms.snapshot(host.roomId(), "Bearer " + host.credential()).you().presenceBy())
        .isNull();

    now.addAndGet(meeting.presenceCheck().toMillis() + 1000);
    present(host.roomId(), host);
    lifecycle.sweepRoom(host.roomId());
    now.addAndGet(meeting.presenceAnswer().toMillis() + 1000);
    present(host.roomId(), host);
    lifecycle.sweepRoom(host.roomId());
    var member = rooms.read(host.roomId()).members.get(host.participantId());
    assertThat(member.status).isEqualTo(RoomState.Status.LEFT);
  }

  /**
   * Места заняты, а на связи ни одного человека (вкладка без медиа, скрипт с {@code rejoin}): кино
   * и музыка гаснут через {@code idle-integrations}, а не держат встречу часами.
   */
  @Test
  void moviesAndMusicStopWhenNobodyIsOnline() {
    var host = host(Entrant.UNKNOWN);
    present(host.roomId(), host);
    rooms.addMusicService(host.roomId(), UUID.randomUUID());
    hold(host);
    lifecycle.sweepRoom(host.roomId());
    now.addAndGet(config.meeting().idleIntegrations().toMillis() - 5000);
    hold(host);
    lifecycle.sweepRoom(host.roomId());
    assertThat(rooms.read(host.roomId()).watch).isNotNull();
    now.addAndGet(10_000);
    hold(host);
    lifecycle.sweepRoom(host.roomId());
    var room = rooms.read(host.roomId());
    assertThat(room.watch).isNull();
    assertThat(room.members.values())
        .filteredOn(m -> "music".equals(m.service))
        .allSatisfy(m -> assertThat(m.occupiesSeat()).isFalse());
    assertThat(room.closedAt).isNull();
  }

  /** Человек держит место без медиа — как скрипт, который зовёт {@code rejoin} раз в сто секунд. */
  private void hold(Admission host) {
    var room = repository.get(host.roomId(), false);
    var member = room.members.get(host.participantId());
    member.status = RoomState.Status.JOINING;
    member.recoveryDeadline = now.get() + 60_000;
    room.presence.put(member.id, now.get());
    if (room.watch == null) {
      room.watch = new RoomState.Watch();
      room.watch.provider = "youtube";
      room.watch.kind = "video";
      room.watch.contentId = "dQw4w9WgXcQ";
    }
    for (var bot : room.members.values())
      if ("music".equals(bot.service) && bot.occupiesSeat()) {
        bot.status = RoomState.Status.CONNECTED;
        bot.recoveryDeadline = null;
      }
    repository.save(room, now.get());
  }

  // Метры ---------------------------------------------------------------------------------------

  /** В метках метров Cord — только перечисления: ни номера встречи, ни участника, ни адреса. */
  @Test
  void meterLabelsAreOnlyEnumerations() {
    var host = host(Entrant.UNKNOWN);
    var guest = guest(host);
    present(host.roomId(), host, guest);
    command(host, "close", null);
    metrics.joined("link", "ok");
    metrics.refused("ROOM_FULL", 409);
    var allowed =
        Set.of(
            "state", "kind", "reason", "door", "result", "code", "status", "by", "version", "path");
    var cord =
        registry.getMeters().stream().filter(m -> m.getId().getName().startsWith("cord.")).toList();
    assertThat(cord).isNotEmpty();
    for (var meter : cord)
      for (var tag : meter.getId().getTags()) {
        assertThat(allowed).as(meter.getId().getName()).contains(tag.getKey());
        assertThat(tag.getValue())
            .doesNotContain(host.roomId())
            .doesNotContain(guest.participantId());
      }
    assertThat(registry.get("cord.meetings.ended").tag("reason", "host").counter().count())
        .isGreaterThanOrEqualTo(1);
  }
}
