package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.HttpServer;
import dev.mikki.stream.access.Identity;
import dev.mikki.stream.access.InternalKeys;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.activity.ActivityReport;
import dev.mikki.stream.activity.InsightFacts;
import dev.mikki.stream.activity.InsightRooms;
import dev.mikki.stream.activity.RxQuality;
import dev.mikki.stream.api.Entries;
import dev.mikki.stream.api.QualityController;
import dev.mikki.stream.attachment.TusGateway;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.media.MediaGateway;
import dev.mikki.stream.media.MediaService;
import dev.mikki.stream.room.*;
import dev.mikki.stream.room.Contracts.*;
import dev.mikki.stream.shared.Json;
import dev.mikki.stream.shared.Problem;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/**
 * Ядро и служба аналитики {@code insight} (R239): ядро шлёт службе факты из {@code
 * contracts/insight.md} §2 и пересылает пульту её отчёты. Службу здесь заменяет маленький
 * HTTP-сервер на петле: он запоминает, что ему прислали, и отвечает, как сказано тестом. Факты
 * сверяются с таблицей контракта, а не с настоящей службой: факт с незнакомым типом или полем она
 * отбросила бы молча.
 */
@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:insight;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.files-root=./.local/test-uploads",
      "stream.fleet-key=test-fleet-key"
    })
@ActiveProfiles("local")
class InsightTest {
  private static final SecureRandom RANDOM = new SecureRandom();

  /** Что служба получила: путь с запросом, ключ и тело. */
  record Received(String method, String target, String key, String body) {}

  static final List<Received> received = new CopyOnWriteArrayList<>();

  /** Чем служба ответит на следующие запросы фактов; пусто — {@code 204}. */
  static final Deque<Integer> factAnswers = new java.util.concurrent.ConcurrentLinkedDeque<>();

  /** Ответ службы на отчёт: с пробелами и кириллицей — вернуться он должен байт в байт. */
  static final String REPORT =
      "{ \"section\": \"pulse\",  \"zone\": \"Europe/Moscow\", \"data\": {\"собеседники\": 12} }";

  static final HttpServer service;

  static {
    try {
      service = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      service.createContext(
          "/",
          exchange -> {
            var body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            var uri = exchange.getRequestURI();
            received.add(
                new Received(
                    exchange.getRequestMethod(),
                    uri.getRawPath() + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery()),
                    exchange.getRequestHeaders().getFirst("X-Insight-Key"),
                    body));
            int status = 204;
            byte[] answer = new byte[0];
            var path = uri.getPath();
            if (path.equals("/internal/facts")) {
              var next = factAnswers.pollFirst();
              if (next != null) status = next;
            } else if (path.equals("/internal/reports/pulse")) {
              status = 200;
              answer = REPORT.getBytes(StandardCharsets.UTF_8);
            } else if (path.startsWith("/internal/reports/errors/")) {
              status = 200;
              answer = "{\"section\":\"errors/{key}\"}".getBytes(StandardCharsets.UTF_8);
            } else if (path.equals("/internal/reports/retention")) {
              status = 400;
              answer = "{\"error\":\"период длиннее 400 дней\"}".getBytes(StandardCharsets.UTF_8);
            } else if (path.equals("/internal/reports/quality")) {
              status = 503;
              answer = "{\"error\":\"база не ответила\"}".getBytes(StandardCharsets.UTF_8);
            } else {
              status = 404;
              answer = "{\"error\":\"нет такого раздела\"}".getBytes(StandardCharsets.UTF_8);
            }
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, answer.length == 0 ? -1 : answer.length);
            if (answer.length > 0) exchange.getResponseBody().write(answer);
            exchange.close();
          });
      service.start();
    } catch (java.io.IOException e) {
      throw new IllegalStateException(e);
    }
  }

  @DynamicPropertySource
  static void insight(DynamicPropertyRegistry registry) {
    registry.add(
        "stream.insight.url", () -> "http://127.0.0.1:" + service.getAddress().getPort() + "/");
  }

  @Autowired RoomService rooms;
  @Autowired MediaService media;
  @Autowired Lifecycle lifecycle;
  @Autowired Entries entries;
  @Autowired InsightFacts facts;
  @Autowired InsightRooms insight;
  @Autowired QualityController quality;
  @Autowired ActivityReport report;
  @Autowired Secrets secrets;
  @Autowired StreamProperties config;
  @Autowired JdbcClient jdbc;
  @Autowired WebApplicationContext web;
  @MockitoBean MediaGateway gateway;
  @MockitoBean TusGateway tus;
  @MockitoBean Clock clock;
  final AtomicLong now = new AtomicLong(System.currentTimeMillis());
  static final AtomicInteger addresses = new AtomicInteger();

  @BeforeEach
  void setUp() {
    jdbc.sql("DELETE FROM command_receipts").update();
    jdbc.sql("DELETE FROM rooms").update();
    when(clock.millis()).thenAnswer(_ -> now.get());
    // Что осталось в буфере от прошлого теста, уходит и забывается.
    factAnswers.clear();
    facts.flush();
    received.clear();
  }

  static String profile() {
    var bytes = new byte[32];
    RANDOM.nextBytes(bytes);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  /** Запрос человека со своего адреса: профиль устройства и вид клиента — заголовками. */
  static MockHttpServletRequest request(String profile) {
    var request = new MockHttpServletRequest("POST", "/api/v1/rooms");
    request.setRemoteAddr("203.0.113." + (1 + addresses.incrementAndGet() % 250));
    if (profile != null) request.addHeader(Identity.PROFILE, profile);
    request.addHeader("X-Cord-Client", "web");
    request.addHeader("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    return request;
  }

  Admission create(String profile) {
    var http = request(profile);
    return entries.admit(
        "create",
        http,
        () ->
            rooms.create(
                new Create(UUID.randomUUID(), "Встреча", "Хозяин", false),
                new dev.mikki.stream.access.Entrant(Identity.profileHash(profile), null)));
  }

  Admission join(Admission host, String profile) {
    var http = request(profile);
    return entries.admit(
        "link",
        http,
        () ->
            rooms.join(
                host.roomId(),
                new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"),
                new dev.mikki.stream.access.Entrant(Identity.profileHash(profile), null)));
  }

  Ack command(Admission who, String type) {
    return rooms.command(
        who.roomId(), who.credential(), new Command(UUID.randomUUID(), type, null, null, 0));
  }

  Ack command(Admission who, String type, String target) {
    return rooms.command(
        who.roomId(), who.credential(), new Command(UUID.randomUUID(), type, null, target, 0));
  }

  Ack watch(Admission who, String provider) {
    return rooms.command(
        who.roomId(),
        who.credential(),
        new Command(
            UUID.randomUUID(),
            "watch.open",
            "Ролик",
            null,
            0,
            provider,
            "video",
            "abc123",
            null,
            null,
            null,
            null,
            null,
            null,
            null));
  }

  Ack open(Admission who, String type, String option) {
    return rooms.command(
        who.roomId(),
        who.credential(),
        new Command(
            UUID.randomUUID(),
            type,
            null,
            null,
            0,
            null,
            null,
            null,
            null,
            option,
            null,
            null,
            null,
            null,
            null));
  }

  void observe(Admission room, Admission... present) {
    var sids = new HashMap<String, String>();
    for (var one : present) sids.put(one.participantId(), "PA_" + one.participantId());
    media.observe(room.roomId(), sids, now.addAndGet(2000));
  }

  String pseudonym(String profile) {
    return secrets.derive("analytics:" + Identity.profileHash(profile));
  }

  /** Отправить буфер и разобрать, что получила служба: факты всех пачек по порядку. */
  List<JsonNode> sent() {
    facts.flush();
    var all = new ArrayList<JsonNode>();
    for (var one : received) {
      if (!one.target().equals("/internal/facts")) continue;
      assertThat(one.method()).isEqualTo("POST");
      assertThat(one.key()).isEqualTo(InternalKeys.derive(config.internalSecret(), "insight"));
      var body = Json.tree(one.body());
      assertThat(body.path("source").asText()).isEqualTo("core");
      body.path("facts").forEach(all::add);
    }
    received.clear();
    all.forEach(InsightTest::conforms);
    return all;
  }

  static List<JsonNode> of(List<JsonNode> facts, String type) {
    return facts.stream().filter(f -> f.path("type").asText().equals(type)).toList();
  }

  static JsonNode only(List<JsonNode> facts, String type) {
    var found = of(facts, type);
    assertThat(found).as(type).hasSize(1);
    return found.getFirst();
  }

  // ── Таблица контракта (contracts/insight.md §2): тип → поля ──────────────────────────────────

  static final Map<String, Set<String>> FIELDS =
      Map.ofEntries(
          Map.entry("join", Set.of("room", "profile", "member", "how", "node", "client")),
          Map.entry("join_fail", Set.of("profile", "how", "code")),
          Map.entry("media_up", Set.of("room", "profile", "member", "node")),
          Map.entry("media_down", Set.of("room", "profile", "member", "reason")),
          Map.entry("presence", Set.of("room", "node", "members")),
          Map.entry("meeting_open", Set.of("room", "node", "profile")),
          Map.entry("meeting_close", Set.of("room", "reason", "peak")),
          Map.entry(
              "quality",
              Set.of(
                  "room",
                  "profile",
                  "mic_s",
                  "cam_s",
                  "screen_s",
                  "bytes_up",
                  "bytes_down",
                  "loss",
                  "rtt",
                  "freezes",
                  "relay",
                  "reconnects")),
          Map.entry("integration_open", Set.of("room", "run", "kind", "variant", "profile")),
          Map.entry("integration_close", Set.of("room", "run", "reason")),
          Map.entry("integration_error", Set.of("room", "run", "kind", "variant", "code")),
          Map.entry("node_move", Set.of("room", "from", "to", "reason")),
          Map.entry("refusal", Set.of("code", "count")));

  static final Map<String, Set<String>> WORDS =
      Map.of(
          "join.how", Set.of("create", "link", "code", "saved", "rejoin"),
          "join_fail.how", Set.of("create", "link", "code", "saved", "rejoin"),
          "media_down.reason", Set.of("left", "lost", "removed", "ended", "moved"),
          "meeting_close.reason", Set.of("empty", "owner", "limit", "admin", "maintenance"),
          "integration_open.kind", Set.of("cinema", "music", "game", "board"),
          "integration_error.kind", Set.of("cinema", "music", "game", "board"),
          "integration_close.reason", Set.of("closed", "replaced", "ended", "error"));

  static final Pattern VARIANT = Pattern.compile("[a-z0-9_.-]{1,32}");
  static final Pattern UUID_TEXT = Pattern.compile("[0-9a-f-]{36}");
  static final Pattern PSEUDONYM = Pattern.compile("[A-Za-z0-9_-]{43}");

  /** Факт по контракту: свой номер, момент, знакомый тип, только названные поля и слова. */
  static void conforms(JsonNode fact) {
    var type = fact.path("type").asText();
    assertThat(FIELDS).as("тип факта").containsKey(type);
    assertThat(fact.path("id").asText()).matches(UUID_TEXT);
    assertThat(fact.path("at").isIntegralNumber()).isTrue();
    assertThat(fact.path("at").asLong()).isGreaterThan(1_700_000_000_000L);
    var names = new HashSet<String>();
    fact.fieldNames().forEachRemaining(names::add);
    names.removeAll(Set.of("id", "at", "type"));
    assertThat(FIELDS.get(type)).as("поля факта " + type).containsAll(names);
    for (var name : names) {
      var allowed = WORDS.get(type + "." + name);
      if (allowed != null)
        assertThat(allowed).as(type + "." + name).contains(fact.path(name).asText());
    }
    if (fact.has("variant")) assertThat(fact.path("variant").asText()).matches(VARIANT);
    if (fact.has("profile") && !fact.path("profile").isNull())
      assertThat(fact.path("profile").asText()).matches(PSEUDONYM);
    for (var member : fact.path("members")) {
      assertThat(member.path("member").asText()).matches(UUID_TEXT);
      assertThat(member.has("profile")).isTrue();
    }
  }

  // ── Факты ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Встреча от создания до конца: начало встречи и вход создателя, вход гостя, оба на связи, тик
   * присутствия со всеми, потеря связи, выход, конец встречи с причиной и пиком.
   */
  @Test
  void aMeetingFromOpenToCloseBecomesFacts() {
    var anna = profile();
    var boris = profile();
    var host = create(anna);
    var guest = join(host, boris);
    var opened = sent();
    var meeting = only(opened, "meeting_open");
    assertThat(meeting.path("room").asText()).isEqualTo(host.roomId());
    assertThat(meeting.path("node").asText()).isEqualTo(host.snapshot().mediaNode());
    assertThat(meeting.path("profile").asText()).isEqualTo(pseudonym(anna));
    var joins = of(opened, "join");
    assertThat(joins).hasSize(2);
    assertThat(joins.get(0).path("how").asText()).isEqualTo("create");
    assertThat(joins.get(0).path("member").asText()).isEqualTo(host.participantId());
    assertThat(joins.get(0).path("client").asText()).isEqualTo("web");
    assertThat(joins.get(0).path("node").asText()).isEqualTo(host.snapshot().mediaNode());
    assertThat(joins.get(1).path("how").asText()).isEqualTo("link");
    assertThat(joins.get(1).path("profile").asText()).isEqualTo(pseudonym(boris));
    // Начало встречи — раньше входа в неё.
    assertThat(opened.indexOf(meeting)).isLessThan(opened.indexOf(joins.get(0)));
    // Никто ещё не на связи — ни фактов связи, ни тика.
    insight.tick();
    assertThat(of(opened, "media_up")).isEmpty();
    assertThat(sent()).isEmpty();

    observe(host, host, guest);
    var up = of(sent(), "media_up");
    assertThat(up)
        .extracting(f -> f.path("member").asText())
        .containsExactlyInAnyOrder(host.participantId(), guest.participantId());
    assertThat(up).allSatisfy(f -> assertThat(f.path("room").asText()).isEqualTo(host.roomId()));

    insight.tick();
    var tick = only(sent(), "presence");
    assertThat(tick.path("room").asText()).isEqualTo(host.roomId());
    assertThat(tick.path("node").asText()).isEqualTo(host.snapshot().mediaNode());
    var present = new HashMap<String, String>();
    tick.path("members")
        .forEach(m -> present.put(m.path("member").asText(), m.path("profile").asText()));
    assertThat(present)
        .containsOnly(
            Map.entry(host.participantId(), pseudonym(anna)),
            Map.entry(guest.participantId(), pseudonym(boris)));

    // Узел больше не видит гостя — связь потеряна; вернулся — снова на связи.
    observe(host, host);
    var lost = only(sent(), "media_down");
    assertThat(lost.path("member").asText()).isEqualTo(guest.participantId());
    assertThat(lost.path("reason").asText()).isEqualTo("lost");
    insight.tick();
    assertThat(only(sent(), "presence").path("members")).hasSize(1);
    observe(host, host, guest);
    assertThat(only(sent(), "media_up").path("member").asText()).isEqualTo(guest.participantId());

    // Гость вышел сам; ведущий завершил встречу — со связи уходит и он, затем сама встреча.
    command(guest, "leave");
    assertThat(only(sent(), "media_down").path("reason").asText()).isEqualTo("left");
    command(host, "close");
    var end = sent();
    var down = only(end, "media_down");
    assertThat(down.path("member").asText()).isEqualTo(host.participantId());
    assertThat(down.path("reason").asText()).isEqualTo("ended");
    var closed = only(end, "meeting_close");
    assertThat(closed.path("room").asText()).isEqualTo(host.roomId());
    assertThat(closed.path("reason").asText()).isEqualTo("owner");
    assertThat(closed.path("peak").asInt()).isEqualTo(2);
    assertThat(end.indexOf(down)).isLessThan(end.indexOf(closed));
    // Кончившаяся встреча тиков не даёт.
    insight.tick();
    assertThat(sent()).isEmpty();
  }

  /**
   * Повтор принятого входа (браузер не дождался ответа и прислал тот же запрос) — тот же участник и
   * тот же факт: номер у него тот же, служба примет его один раз. Начала встречи второй раз нет.
   */
  @Test
  void aRepeatedAdmissionIsTheSameFact() {
    var anna = profile();
    var command = new Create(UUID.randomUUID(), "Встреча", "Хозяин", false);
    var entrant = new dev.mikki.stream.access.Entrant(Identity.profileHash(anna), null);
    var first = entries.admit("create", request(anna), () -> rooms.create(command, entrant));
    var again = entries.admit("create", request(anna), () -> rooms.create(command, entrant));
    assertThat(again.participantId()).isEqualTo(first.participantId());
    var told = sent();
    assertThat(of(told, "meeting_open")).hasSize(1);
    var joins = of(told, "join");
    assertThat(joins).hasSize(2);
    assertThat(joins.get(1).path("id").asText()).isEqualTo(joins.get(0).path("id").asText());
    // Другой вход — другой факт.
    var guest = join(first, null);
    assertThat(only(sent(), "join").path("id").asText())
        .isNotEqualTo(joins.get(0).path("id").asText());
    assertThat(guest.participantId()).isNotEqualTo(first.participantId());
  }

  /** Исключённый ведущим — причина «исключён»; встреча, из которой все ушли, — «пусто». */
  @Test
  void removalAndAnEmptyMeetingHaveTheirOwnReasons() {
    var host = create(profile());
    var guest = join(host, null);
    observe(host, host, guest);
    sent();
    command(host, "participant.remove", guest.participantId());
    var removed = only(sent(), "media_down");
    assertThat(removed.path("reason").asText()).isEqualTo("removed");
    assertThat(removed.path("profile").isNull()).isTrue();
    command(host, "leave");
    sent();
    lifecycle.sweepRoom(host.roomId());
    now.addAndGet(config.emptyRoomSeconds() * 1000L + 1000);
    lifecycle.sweepRoom(host.roomId());
    assertThat(only(sent(), "meeting_close").path("reason").asText()).isEqualTo("empty");
  }

  /** Отказ двери — факт с кодом отказа; посетителя он больше не создаёт и встречи не касается. */
  @Test
  void aRefusedDoorIsAFactWithItsCode() {
    var host = create(profile());
    sent();
    var stranger = profile();
    var http = request(stranger);
    assertThatThrownBy(
            () ->
                entries.admit(
                    "link",
                    http,
                    () ->
                        rooms.join(host.roomId(), new Join(UUID.randomUUID(), "forged", "Гость"))))
        .isInstanceOf(Problem.class);
    var fail = only(sent(), "join_fail");
    assertThat(fail.path("how").asText()).isEqualTo("link");
    assertThat(fail.path("code").asText()).isEqualTo("INVITE_INVALID");
    assertThat(fail.path("profile").asText()).isEqualTo(pseudonym(stranger));
    assertThat(fail.has("room")).isFalse();
    // Поток отказов с одного адреса — не поток фактов: не больше тридцати в минуту.
    for (int i = 0; i < 40; i++)
      assertThatThrownBy(
              () ->
                  entries.admit(
                      "link",
                      http,
                      () ->
                          rooms.join(
                              host.roomId(), new Join(UUID.randomUUID(), "forged", "Гость"))))
          .isInstanceOf(Problem.class);
    assertThat(of(sent(), "join_fail")).hasSize(29);
  }

  /**
   * Интеграции: кинозал с площадкой, замена ролика, игра, доска — у каждого запуска свой номер, по
   * нему же он и кончается: убрали, заменили, кончилась встреча.
   */
  @Test
  void integrationRunsOpenAndCloseWithTheirNumbers() {
    var anna = profile();
    var host = create(anna);
    observe(host, host);
    sent();

    watch(host, "youtube");
    var cinema = only(sent(), "integration_open");
    assertThat(cinema.path("kind").asText()).isEqualTo("cinema");
    assertThat(cinema.path("variant").asText()).isEqualTo("youtube");
    assertThat(cinema.path("profile").asText()).isEqualTo(pseudonym(anna));
    assertThat(cinema.path("room").asText()).isEqualTo(host.roomId());
    var first = cinema.path("run").asText();

    // Пауза и перемотка — тот же запуск: фактов нет.
    command(host, "watch.play");
    assertThat(sent()).isEmpty();

    // Открыли другое на его месте — прежний запуск заменён, у нового свой номер.
    watch(host, "rutube");
    var swapped = sent();
    var replaced = only(swapped, "integration_close");
    assertThat(replaced.path("run").asText()).isEqualTo(first);
    assertThat(replaced.path("reason").asText()).isEqualTo("replaced");
    var second = only(swapped, "integration_open");
    assertThat(second.path("variant").asText()).isEqualTo("rutube");
    assertThat(second.path("run").asText()).isNotEqualTo(first);
    assertThat(swapped.indexOf(replaced)).isLessThan(swapped.indexOf(second));

    command(host, "watch.close");
    var shut = only(sent(), "integration_close");
    assertThat(shut.path("run").asText()).isEqualTo(second.path("run").asText());
    assertThat(shut.path("reason").asText()).isEqualTo("closed");

    // Игра — вид «игра», разновидность — какая; доска — без разновидности.
    open(host, "chess.open", null);
    var chess = only(sent(), "integration_open");
    assertThat(chess.path("kind").asText()).isEqualTo("game");
    assertThat(chess.path("variant").asText()).isEqualTo("chess");
    // Номер запуска лежит в самой комнате: перезапуск ядра его не теряет.
    assertThat(rooms.read(host.roomId()).runs).containsEntry("chess", chess.path("run").asText());

    // Встреча кончилась — запуск кончился вместе с ней и раньше неё.
    command(host, "close");
    var end = sent();
    var over = only(end, "integration_close");
    assertThat(over.path("run").asText()).isEqualTo(chess.path("run").asText());
    assertThat(over.path("reason").asText()).isEqualTo("ended");
    assertThat(end.indexOf(over)).isLessThan(end.indexOf(only(end, "meeting_close")));
    assertThat(rooms.read(host.roomId()).runs).isEmpty();
  }

  /** Покер, дурак, рисование и доска открываются своими словами; убранный стол — «убран». */
  @Test
  void everyGameKindAndTheBoardAreIntegrations() {
    var host = create(profile());
    observe(host, host);
    sent();
    for (var game : List.of("poker", "durak", "gartic")) {
      open(host, game + ".open", null);
      var opened = only(sent(), "integration_open");
      assertThat(opened.path("kind").asText()).isEqualTo("game");
      assertThat(opened.path("variant").asText()).isEqualTo(game);
      var close = game + ".close";
      if (game.equals("gartic"))
        rooms.command(
            host.roomId(),
            host.credential(),
            new Command(
                UUID.randomUUID(),
                close,
                null,
                null,
                0,
                null,
                null,
                rooms.read(host.roomId()).gartic.gameId,
                null,
                null,
                null,
                null,
                null,
                null,
                null));
      else command(host, close);
      var closed = only(sent(), "integration_close");
      assertThat(closed.path("run").asText()).isEqualTo(opened.path("run").asText());
      assertThat(closed.path("reason").asText()).isEqualTo("closed");
    }
    open(host, "board.open", null);
    var board = only(sent(), "integration_open");
    assertThat(board.path("kind").asText()).isEqualTo("board");
    assertThat(board.has("variant")).isFalse();
    command(host, "board.close");
    assertThat(only(sent(), "integration_close").path("reason").asText()).isEqualTo("closed");
  }

  /**
   * Музыка: бот вошёл — запуск начался; ушёл по слову службы — «убрана»; пропал, так и не выйдя на
   * связь, — отказ интеграции и конец запуска с причиной «ошибка».
   */
  @Test
  void musicIsARunAndALostBotIsAnError() {
    var host = create(profile());
    observe(host, host);
    sent();
    var bot = rooms.addMusicService(host.roomId(), UUID.randomUUID());
    var music = only(sent(), "integration_open");
    assertThat(music.path("kind").asText()).isEqualTo("music");
    assertThat(music.has("variant")).isFalse();
    assertThat(music.path("profile").isNull()).isTrue();
    command(bot, "leave");
    var stopped = only(sent(), "integration_close");
    assertThat(stopped.path("run").asText()).isEqualTo(music.path("run").asText());
    assertThat(stopped.path("reason").asText()).isEqualTo("closed");

    now.addAndGet(1000);
    rooms.addMusicService(host.roomId(), UUID.randomUUID());
    var again = only(sent(), "integration_open");
    now.addAndGet(config.joinSeconds() * 1000L + 1000);
    observe(host, host);
    lifecycle.sweepRoom(host.roomId());
    var failed = sent();
    var error = only(failed, "integration_error");
    assertThat(error.path("kind").asText()).isEqualTo("music");
    assertThat(error.path("run").asText()).isEqualTo(again.path("run").asText());
    assertThat(error.path("code").asText()).isEqualTo("MUSIC_BOT_LOST");
    var ended = only(failed, "integration_close");
    assertThat(ended.path("reason").asText()).isEqualTo("error");
    // Бот не человек: в фактах связи и в тиках его нет.
    assertThat(of(failed, "media_down")).isEmpty();
  }

  /** Переезд встречи на другой узел: факт переезда, а люди уходят со связи с причиной «переезд». */
  @Test
  void aNodeMoveIsAFactAndPeopleGoDownAsMoved() {
    var host = create(profile());
    observe(host, host);
    sent();
    var from = host.snapshot().mediaNode();
    media.moveRoom(host.roomId(), from, "hel");
    var moved = sent();
    var move = only(moved, "node_move");
    assertThat(move.path("room").asText()).isEqualTo(host.roomId());
    assertThat(move.path("from").asText()).isEqualTo(from);
    assertThat(move.path("to").asText()).isEqualTo("hel");
    assertThat(move.path("reason").asText()).isEqualTo("dead");
    assertThat(only(moved, "media_down").path("reason").asText()).isEqualTo("moved");
  }

  /** Десятисекундная сводка клиента — факт качества с байтами; отказ защиты — итог минуты. */
  @Test
  void theQualitySummaryAndGuardRefusalsBecomeFacts() {
    var anna = profile();
    var host = create(anna);
    sent();
    var camera = new RxQuality.TxTrack("camera", "vp9", "hw", 10, 0, 0, 0);
    quality.report(
        UUID.fromString(host.roomId()),
        host.credential(),
        new RxQuality.RxSummary(List.of(), List.of(camera), null, 800_000L, 4_000_000L),
        request(anna));
    var fact = only(sent(), "quality");
    assertThat(fact.path("room").asText()).isEqualTo(host.roomId());
    assertThat(fact.path("profile").asText()).isEqualTo(pseudonym(anna));
    assertThat(fact.path("cam_s").asDouble()).isEqualTo(10);
    assertThat(fact.path("bytes_up").asLong()).isEqualTo(800_000L);
    assertThat(fact.path("bytes_down").asLong()).isEqualTo(4_000_000L);

    for (int i = 0; i < 7; i++) facts.refused("RATE_LIMITED", 429);
    facts.refusals();
    var refusal = only(sent(), "refusal");
    assertThat(refusal.path("code").asText()).isEqualTo("RATE_LIMITED");
    assertThat(refusal.path("count").asInt()).isEqualTo(7);
  }

  /**
   * Служба легла — встреча идёт как шла, факты ждут в буфере; встала — приходит та же пачка с теми
   * же номерами.
   */
  @Test
  void aSilentServiceDoesNotStopTheMeetingAndGetsTheSameBatchLater() {
    factAnswers.add(503);
    var host = create(profile());
    observe(host, host);
    assertThat(facts.flush()).isZero();
    assertThat(facts.buffered()).isPositive();
    var refused = received.getFirst().body();
    received.clear();
    assertThat(command(host, "leave").ok()).isTrue();
    assertThat(facts.flush()).isPositive();
    assertThat(received.getFirst().body()).isEqualTo(refused);
    assertThat(facts.buffered()).isZero();
  }

  /**
   * Ядро поднялось посреди разговора: идущие встречи запоминаются без фактов, и тики присутствия
   * продолжаются — тихая встреча не выпадает из счёта до первого события в ней.
   */
  @Test
  void aRestartedCoreKeepsTickingForMeetingsThatWereGoing() {
    var anna = profile();
    var host = create(anna);
    observe(host, host);
    command(host, "close");
    var quiet = create(anna);
    observe(quiet, quiet);
    sent();
    // «Новое» ядро: памяти о встречах нет, комнаты — в базе.
    var fresh =
        new InsightRooms(
            facts,
            web.getBean(dev.mikki.stream.nodes.MediaNodes.class),
            web.getBean(RoomRepository.class));
    fresh.tick();
    assertThat(sent()).isEmpty();
    fresh.seed();
    assertThat(sent()).isEmpty();
    fresh.tick();
    var tick = only(sent(), "presence");
    assertThat(tick.path("room").asText()).isEqualTo(quiet.roomId());
    assertThat(tick.path("members").get(0).path("profile").asText()).isEqualTo(pseudonym(anna));
  }

  /**
   * Встреча, строки которой в базе уже нет, а конца наблюдатель не видел, тиков не даёт: призрак не
   * копит людям время, которого не было.
   */
  @Test
  void aMeetingThatVanishedWithoutClosingStopsTicking() {
    var host = create(profile());
    observe(host, host);
    insight.tick();
    assertThat(only(sent(), "presence").path("room").asText()).isEqualTo(host.roomId());
    jdbc.sql("DELETE FROM rooms WHERE id=?").param(host.roomId()).update();
    insight.tick();
    assertThat(sent()).isEmpty();
  }

  /** «Сейчас» для пульта называет медиаузел каждой встречи — пульту нужны люди по узлам. */
  @Test
  void theNowReportNamesTheMediaNodeOfEachMeeting() {
    var host = create(profile());
    var live = report.now().rooms().stream().filter(r -> r.id().equals(host.roomId())).findFirst();
    assertThat(live).isPresent();
    assertThat(live.get().mediaNode()).isNotBlank().isEqualTo(host.snapshot().mediaNode());
  }

  // ── Отчёты для пульта ────────────────────────────────────────────────────────────────────────

  static final String FLEET = "fleet.test-fleet-key";

  /**
   * Пульт спрашивает отчёт у ядра, ядро — у службы, со своим ключом и пятью параметрами, и отдаёт
   * ответ как есть. Без входа владельца отчёта нет.
   */
  @Test
  void theConsoleGetsServiceReportsThroughTheCore() throws Exception {
    MockMvc mvc = MockMvcBuilders.webAppContextSetup(web).build();
    mvc.perform(get("/api/v1/admin/insight/pulse").param("from", "2026-11-01"))
        .andExpect(status().isUnauthorized())
        .andExpect(jsonPath("$.code").value("ADMIN_REQUIRED"));
    assertThat(received).isEmpty();

    var answer =
        mvc.perform(
                get("/api/v1/admin/insight/pulse")
                    .header("X-Cord-Admin", FLEET)
                    .param("from", "2026-11-01")
                    .param("to", "2026-11-12")
                    .param("view", "cohort")
                    .param("strict", "1")
                    .param("compare", "1")
                    .param("debug", "1"))
            .andExpect(status().isOk())
            .andExpect(header().string("Content-Type", "application/json"))
            .andReturn()
            .getResponse();
    assertThat(new String(answer.getContentAsByteArray(), StandardCharsets.UTF_8))
        .isEqualTo(REPORT);
    var asked = received.getFirst();
    assertThat(asked.method()).isEqualTo("GET");
    assertThat(asked.target())
        .isEqualTo(
            "/internal/reports/pulse?from=2026-11-01&to=2026-11-12&view=cohort&strict=1&compare=1");
    assertThat(asked.key()).isEqualTo(InternalKeys.derive(config.internalSecret(), "insight"));

    received.clear();
    mvc.perform(
            get("/api/v1/admin/insight/errors/{key}", "RATE_LIMITED~guard~core")
                .header("X-Cord-Admin", FLEET)
                .param("from", "2026-11-01")
                .param("to", "2026-11-12"))
        .andExpect(status().isOk())
        .andExpect(content().string("{\"section\":\"errors/{key}\"}"));
    assertThat(received.getFirst().target())
        .isEqualTo(
            "/internal/reports/errors/RATE_LIMITED%7Eguard%7Ecore?from=2026-11-01&to=2026-11-12");
  }

  /**
   * Отказ службы запросу — тот же статус в формате ядра со словами службы; служба не ответила или
   * сломалась — {@code 503 INSIGHT_UNAVAILABLE}.
   */
  @Test
  void serviceRefusalsReachTheConsoleInTheCoreErrorFormat() throws Exception {
    MockMvc mvc = MockMvcBuilders.webAppContextSetup(web).build();
    mvc.perform(get("/api/v1/admin/insight/retention").header("X-Cord-Admin", FLEET))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.code").value("INSIGHT_REQUEST"))
        .andExpect(jsonPath("$.detail").value("период длиннее 400 дней"));
    mvc.perform(get("/api/v1/admin/insight/nothing").header("X-Cord-Admin", FLEET))
        .andExpect(status().isNotFound())
        .andExpect(jsonPath("$.code").value("INSIGHT_NOT_FOUND"))
        .andExpect(jsonPath("$.detail").value("нет такого раздела"));
    mvc.perform(get("/api/v1/admin/insight/quality").header("X-Cord-Admin", FLEET))
        .andExpect(status().isServiceUnavailable())
        .andExpect(jsonPath("$.code").value("INSIGHT_UNAVAILABLE"));
    // Раздел — слово, а не путь: до службы такой запрос не доходит.
    received.clear();
    mvc.perform(get("/api/v1/admin/insight/Pulse.json").header("X-Cord-Admin", FLEET))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
    assertThat(received).isEmpty();
  }
}
