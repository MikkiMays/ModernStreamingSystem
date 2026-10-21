package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import dev.mikki.stream.access.AdminAccess;
import dev.mikki.stream.access.ProofOfWork;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.access.ServerAccess;
import dev.mikki.stream.api.RequestGuard;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Json;
import dev.mikki.stream.support.SupportProperties;
import dev.mikki.stream.support.SupportService;
import dev.mikki.stream.support.SupportService.Status;
import java.time.Clock;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/**
 * Обращения в поддержку (E13, T36): форма «Помощи» без учётных записей. Обращение проходит ту же
 * проверку «не бот», что создание встречи (E11-B), упирается в пределы на адрес и на сервер,
 * хранится в базе и один раз доносится ботом в Telegram владельца.
 */
@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:support;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.abuse.proof-cost=1000",
      "stream.support.notify-telegram-chat=-100123",
      "stream.support.per-ip=3 per hour",
      "stream.support.per-server=6 per hour",
      "stream.support.retention=30 days",
      "stream.admin-password=пароль владельца"
    })
@ActiveProfiles("local")
class SupportTest {
  @Autowired WebApplicationContext web;
  @Autowired SupportService support;
  @Autowired JdbcClient jdbc;
  @Autowired RateLimits limits;
  @Autowired SupportProperties config;
  @MockitoBean Clock clock;
  AtomicLong now = new AtomicLong(System.currentTimeMillis());
  MockMvc mvc;

  @BeforeEach
  void setUp() {
    jdbc.sql("DELETE FROM support_tickets").update();
    // Общий предел сервера живёт в памяти процесса дольше теста — у каждого теста он свой.
    limits.reset("support:server", config.perServer());
    when(clock.millis()).thenAnswer(_ -> now.get());
    mvc = MockMvcBuilders.webAppContextSetup(web).build();
  }

  /** Адрес, которого ещё не видел ни один тест: счётчики пределов у него пустые. */
  static String fresh() {
    var r = ThreadLocalRandom.current();
    return "198.18." + r.nextInt(256) + "." + r.nextInt(256);
  }

  static MockHttpServletRequestBuilder from(MockHttpServletRequestBuilder request, String ip) {
    return request.with(
        r -> {
          r.setRemoteAddr(ip);
          return r;
        });
  }

  /** То, что делает браузер: берёт задачу «не бот» на `support` и решает её. */
  String proof(String ip) throws Exception {
    var body =
        mvc.perform(from(get("/api/v1/proof").param("for", "support"), ip))
            .andExpect(status().isOk())
            .andReturn()
            .getResponse()
            .getContentAsString();
    return ProofOfWorkTest.solve(Json.read(body, ProofOfWork.Challenge.class));
  }

  static String body(String topic, String message, String contact, String diagnostics, boolean ok) {
    var map = new LinkedHashMap<String, Object>();
    map.put("topic", topic);
    map.put("message", message);
    map.put("contact", contact);
    map.put("diagnostics", diagnostics);
    map.put("consent", ok);
    return Json.write(map);
  }

  MockHttpServletRequestBuilder send(String ip, String json) throws Exception {
    return from(post("/api/v1/support"), ip)
        .header(ProofOfWork.HEADER, proof(ip))
        .contentType(MediaType.APPLICATION_JSON)
        .content(json);
  }

  String submit(String ip, String message) throws Exception {
    var answer =
        mvc.perform(send(ip, body("camera", message, null, null, false)))
            .andExpect(status().isOk())
            .andReturn()
            .getResponse()
            .getContentAsString();
    return Json.tree(answer).path("id").asText();
  }

  @Test
  void aTicketIsKeptAndReachesTheOwnersTelegramOnce() throws Exception {
    var ip = fresh();
    var answer =
        mvc.perform(
                send(
                    ip,
                    body(
                        "camera",
                        "  Камера чёрная\r\nво встрече, а в предпросмотре видно‮  ",
                        " @someone ",
                        "{\"version\":\"0.7.0\"}",
                        true)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.id").isString())
            .andExpect(jsonPath("$.number").isString())
            .andReturn()
            .getResponse()
            .getContentAsString();
    var id = Json.tree(answer).path("id").asText();
    var number = Json.tree(answer).path("number").asText();
    assertThat(number).matches("[0-9A-F]{8}").isEqualTo(id.substring(0, 8).toUpperCase());

    // Хранится то, что человек написал, без управляющих знаков и с одним видом перевода строки.
    var stored = support.recent(10, null);
    assertThat(stored).hasSize(1);
    var ticket = stored.getFirst();
    assertThat(ticket.message()).isEqualTo("Камера чёрная\nво встрече, а в предпросмотре видно");
    assertThat(ticket.contact()).isEqualTo("@someone");
    assertThat(ticket.diagnostics()).isEqualTo("{\"version\":\"0.7.0\"}");
    assertThat(ticket.status()).isEqualTo(Status.NEW);
    assertThat(jdbc.sql("SELECT from_key FROM support_tickets").query(String.class).single())
        .isNotBlank()
        .doesNotContain(ip);

    // Бот забирает его из очереди с чатом владельца и готовым текстом — и только один раз.
    mvc.perform(get("/internal/support/outbox"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.length()").value(1))
        .andExpect(jsonPath("$[0].id").value(id))
        .andExpect(jsonPath("$[0].chat").value("-100123"));
    var text = support.outbox(10).getFirst().text();
    assertThat(text)
        .contains(number)
        .contains("Камера и микрофон")
        .contains("Камера чёрная")
        .contains("@someone")
        .contains("0.7.0");
    mvc.perform(post("/internal/support/" + id + "/sent")).andExpect(status().isNoContent());
    mvc.perform(get("/internal/support/outbox"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.length()").value(0));
    assertThat(support.recent(10, null).getFirst().notifiedAt()).isEqualTo(now.get());
  }

  @Test
  void withoutTheProofTheFormIsRefused() throws Exception {
    mvc.perform(
            from(post("/api/v1/support"), fresh())
                .contentType(MediaType.APPLICATION_JSON)
                .content(body("other", "Ничего не работает, помогите", null, null, false)))
        .andExpect(status().isForbidden())
        .andExpect(jsonPath("$.code").value("PROOF_INVALID"));
    assertThat(support.recent(10, null)).isEmpty();
  }

  /** Диагностика уходит только с явного согласия — иначе это не согласие, а сбор данных. */
  @Test
  void diagnosticsTravelOnlyWithConsent() throws Exception {
    mvc.perform(send(fresh(), body("other", "Падает при входе", null, "{\"errors\":[]}", false)))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
    mvc.perform(send(fresh(), body("weather", "Неизвестная тема", null, null, false)))
        .andExpect(status().isBadRequest());
    assertThat(support.recent(10, null)).isEmpty();
  }

  /** Пустое и «ой» не обращение: отказ словами и без траты предела. */
  @Test
  void aBlankMessageIsRefusedWithoutSpendingTheLimit() throws Exception {
    var ip = fresh();
    for (int i = 0; i < 4; i++)
      mvc.perform(send(ip, body("sound", " ​ ой \n ", null, null, false)))
          .andExpect(status().isBadRequest())
          .andExpect(jsonPath("$.code").value("SUPPORT_TEXT"));
    submit(ip, "Не слышно собеседника, хотя он говорит");
  }

  @Test
  void oneAddressSendsAFewTicketsAnHourAndTheServerAFewMore() throws Exception {
    var first = fresh();
    for (int i = 0; i < 3; i++) submit(first, "Обращение номер " + i);
    mvc.perform(send(first, body("other", "Четвёртое за час", null, null, false)))
        .andExpect(status().isTooManyRequests())
        .andExpect(jsonPath("$.code").value("SUPPORT_RATE"));
    for (int i = 0; i < 3; i++) submit(fresh(), "С другого адреса " + i);
    // Седьмое на сервер за час — отказ, с какого адреса ни пиши: Telegram владельца не засыпать.
    mvc.perform(send(fresh(), body("other", "Седьмое за час", null, null, false)))
        .andExpect(status().isTooManyRequests())
        .andExpect(jsonPath("$.code").value("SUPPORT_BUSY"));
    assertThat(support.recent(10, null)).hasSize(6);
  }

  @Test
  void theOwnerMovesATicketAlongAndOldOnesAreForgotten() throws Exception {
    var id = submit(fresh(), "Можно ли записывать встречи?");
    support.setStatus(id, Status.OPEN);
    assertThat(support.recent(10, null).getFirst().status()).isEqualTo(Status.OPEN);
    support.setStatus(id, Status.DONE);
    assertThat(support.recent(10, null).getFirst().status()).isEqualTo(Status.DONE);
    assertThatThrownBy(() -> support.setStatus(UUID.randomUUID().toString(), Status.DONE))
        .hasMessageContaining("не найдено");

    now.addAndGet(Duration.ofDays(29).toMillis());
    var fresher = submit(fresh(), "Ещё одно, посвежее");
    now.addAndGet(Duration.ofDays(2).toMillis());
    assertThat(support.forgetOld()).isEqualTo(1);
    assertThat(support.recent(10, null))
        .extracting(SupportService.Entry::id)
        .containsExactly(fresher);
  }

  /**
   * Кнопки «В работу» и «Решено» под обращением в Telegram владельца: бот зовёт внутренний путь с
   * чатом, где кнопку нажали. Ядро меняет статус тем же {@code setStatus}, что «Активность», — но
   * только если чат тот самый, куда обращения доносятся.
   */
  @Test
  void theOwnersTelegramButtonsMoveATicket() throws Exception {
    var id = submit(fresh(), "Не приходит звук от собеседника");
    mvc.perform(
            put("/internal/support/" + id + "/status")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"status\":\"OPEN\",\"chat\":\"-100123\"}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.number").value(id.substring(0, 8).toUpperCase(Locale.ROOT)))
        .andExpect(jsonPath("$.status").value("OPEN"));
    assertThat(support.recent(10, null).getFirst().status()).isEqualTo(Status.OPEN);
    // Кнопка из чужого чата (сообщение переслали, бота добавили в другую беседу) статуса не меняет.
    mvc.perform(
            put("/internal/support/" + id + "/status")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"status\":\"DONE\",\"chat\":\"-100999\"}"))
        .andExpect(status().isForbidden());
    assertThat(support.recent(10, null).getFirst().status()).isEqualTo(Status.OPEN);
    mvc.perform(
            put("/internal/support/" + UUID.randomUUID() + "/status")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"status\":\"DONE\",\"chat\":\"-100123\"}"))
        .andExpect(status().isNotFound());
  }

  /** Новые сверху, страницами по времени — так их листает «Активность». */
  @Test
  void recentTicketsComeNewestFirstInPages() throws Exception {
    var ids = new ArrayList<String>();
    for (int i = 0; i < 3; i++) {
      now.addAndGet(1000);
      ids.add(submit(fresh(), "Обращение по порядку " + i));
    }
    var page = support.recent(2, null);
    assertThat(page).extracting(SupportService.Entry::id).containsExactly(ids.get(2), ids.get(1));
    assertThat(support.recent(2, page.getLast().createdAt()))
        .extracting(SupportService.Entry::id)
        .containsExactly(ids.get(0));
  }

  /** «Активность» (E10-B): владелец видит обращения и ведёт их статус; без его входа — отказ. */
  @Test
  void theOwnerSeesTicketsOnTheActivityPageAndMovesThem() throws Exception {
    var id = submit(fresh(), "Не приходит звук от собеседника");
    mvc.perform(get("/api/v1/admin/support"))
        .andExpect(status().isUnauthorized())
        .andExpect(jsonPath("$.code").value("ADMIN_REQUIRED"));
    var session =
        mvc.perform(
                from(post("/api/v1/admin/session"), fresh())
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"password\":\"пароль владельца\"}"))
            .andExpect(status().isOk())
            .andReturn()
            .getResponse()
            .getContentAsString();
    var token = Json.tree(session).path("token").asText();
    mvc.perform(get("/api/v1/admin/support").header(AdminAccess.HEADER, token))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$[0].id").value(id))
        .andExpect(jsonPath("$[0].status").value("NEW"))
        .andExpect(jsonPath("$[0].message").value("Не приходит звук от собеседника"));
    mvc.perform(
            put("/api/v1/admin/support/" + id + "/status")
                .header(AdminAccess.HEADER, token)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"status\":\"DONE\"}"))
        .andExpect(status().isNoContent());
    assertThat(support.recent(10, null).getFirst().status()).isEqualTo(Status.DONE);
    mvc.perform(
            put("/api/v1/admin/support/" + id + "/status")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"status\":\"OPEN\"}"))
        .andExpect(status().isUnauthorized());
  }

  /**
   * Застрявшему у двери сервера с паролем тоже нужна помощь: форма и задача «не бот» открыты до
   * входа, как пинг и сведения о сервере.
   */
  @Test
  void theFormIsReachableBeforeTheServerPassword() throws Exception {
    var config = mock(StreamProperties.class);
    when(config.sessionSecret()).thenReturn("a-test-session-secret-of-32-chars+");
    when(config.internalSecret()).thenReturn("a-test-internal-secret-of-32-chars");
    when(config.accessPassword()).thenReturn("тайна");
    when(config.publicUrl()).thenReturn("https://meet.example.com");
    var guard = new RequestGuard(config, new ServerAccess(new Secrets(config), config));
    for (var path : List.of("/api/v1/support", "/api/v1/proof")) {
      var request = new MockHttpServletRequest("GET", path);
      var response = new MockHttpServletResponse();
      var chain = new MockFilterChain();
      guard.doFilter(request, response, chain);
      assertThat(chain.getRequest()).as(path).isNotNull();
    }
    var closed = new MockHttpServletRequest("GET", "/api/v1/favorites");
    var response = new MockHttpServletResponse();
    guard.doFilter(closed, response, new MockFilterChain());
    assertThat(response.getStatus()).isEqualTo(401);
  }
}
