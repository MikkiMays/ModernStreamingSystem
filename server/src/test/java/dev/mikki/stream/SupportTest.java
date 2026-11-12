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
import dev.mikki.stream.api.SupportController;
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
    jdbc.sql("DELETE FROM support_notes").update();
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

  /** «Сообщить о проблеме» (R79): тема {@code report} и отмеченное. */
  static String report(String message, String diagnostics, String... issues) {
    var map = new LinkedHashMap<String, Object>();
    map.put("topic", "report");
    map.put("message", message);
    map.put("contact", null);
    map.put("diagnostics", diagnostics);
    map.put("consent", diagnostics != null);
    map.put("issues", List.of(issues));
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

  /**
   * «Сообщить о проблеме» (R79): отмеченное — по порядку списка, подробности не обязательны, отчёт
   * о звонке — с согласием; владелец видит отмеченное в Telegram и на «Активности».
   */
  @Test
  void aProblemReportCarriesWhatIsWrongToTheOwner() throws Exception {
    var id =
        Json.tree(
                mvc.perform(send(fresh(), report("", "call: 312 s\nloss: 0.2 %", "music", "sound")))
                    .andExpect(status().isOk())
                    .andReturn()
                    .getResponse()
                    .getContentAsString())
            .path("id")
            .asText();
    var ticket = support.recent(10, null).getFirst();
    assertThat(ticket.id()).isEqualTo(id);
    assertThat(ticket.topic()).isEqualTo("report");
    assertThat(ticket.issues()).containsExactly("sound", "music");
    assertThat(ticket.message()).isEmpty();
    assertThat(ticket.diagnostics()).contains("call: 312 s");
    assertThat(support.outbox(10).getFirst().text())
        .contains("Проблема во встрече")
        .contains("Что не так: звук обрывается, не слышно музыку")
        .contains("loss: 0.2 %")
        .doesNotContain("\n\n\n");
    var session =
        mvc.perform(
                from(post("/api/v1/admin/session"), fresh())
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"password\":\"пароль владельца\"}"))
            .andReturn()
            .getResponse()
            .getContentAsString();
    mvc.perform(
            get("/api/v1/admin/support")
                .header(AdminAccess.HEADER, Json.tree(session).path("token").asText()))
        .andExpect(jsonPath("$[0].issues[0]").value("sound"))
        .andExpect(jsonPath("$[0].issues[1]").value("music"));
    // У обычного обращения отмеченного нет. Секундой позже — чтобы стать первым в «новых сверху».
    now.addAndGet(1000);
    submit(fresh(), "Обычное обращение без отметок");
    assertThat(support.recent(10, null).getFirst().issues()).isEmpty();
  }

  /** Отмеченное бывает только у «Сообщить о проблеме» и обязательно у него; чужое слово — отказ. */
  @Test
  void issuesBelongOnlyToAProblemReport() throws Exception {
    mvc.perform(send(fresh(), report("Звук пропадает", null)))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
    mvc.perform(send(fresh(), report("", null, "weather"))).andExpect(status().isBadRequest());
    var map = new LinkedHashMap<String, Object>();
    map.put("topic", "sound");
    map.put("message", "Обычная тема с отметками");
    map.put("consent", false);
    map.put("issues", List.of("sound"));
    mvc.perform(send(fresh(), Json.write(map))).andExpect(status().isBadRequest());
    assertThat(support.recent(10, null)).isEmpty();
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
    // Предел адреса стоит перед общим: адрес, выбравший своё, получает отказ и потолок сервера не
    // тратит — сколько бы ни стучал, остальным их три обращения остаются.
    for (int i = 0; i < 5; i++)
      mvc.perform(send(first, body("other", "Сверх своего за час", null, null, false)))
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

  String adminToken() throws Exception {
    var session =
        mvc.perform(
                from(post("/api/v1/admin/session"), fresh())
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"password\":\"пароль владельца\"}"))
            .andReturn()
            .getResponse()
            .getContentAsString();
    return Json.tree(session).path("token").asText();
  }

  static SupportService.Filter overdue() {
    return new SupportService.Filter(null, null, null, null, null, true, null, null, null);
  }

  static SupportService.Filter query(Status status, String q) {
    return new SupportService.Filter(status, null, null, null, q, null, null);
  }

  /**
   * Проработка обращения в пульте (R215, Р-124): статусы new → open → waiting → done → archived и
   * шаг назад; назначение, приоритет и метки — строками ленты; заметки и ответ человеку; SLA первой
   * реакции и решения, который стоит, пока ждём человека; поиск по тексту, номеру, меткам и ленте;
   * счётчики, качество работы и архив.
   */
  @Test
  void theConsoleWorksATicketThroughItsStatusesWithNotesAndSla() throws Exception {
    var id = submit(fresh(), "Не слышно собеседника в наушниках");
    var other = submit(fresh(), "Хочу тёмную тему по умолчанию");
    var token = adminToken();
    long created = now.get();

    // Свежее обращение: сроки SLA от создания, ничего не просрочено, никому не назначено.
    var fresh = support.get(id).ticket();
    assertThat(fresh.priority()).isEqualTo("normal");
    assertThat(fresh.firstResponseDueAt()).isEqualTo(created + Duration.ofHours(4).toMillis());
    assertThat(fresh.resolveDueAt()).isEqualTo(created + Duration.ofHours(48).toMillis());
    assertThat(fresh.breached()).isFalse();
    assertThat(fresh.slaMet()).isNull();
    assertThat(support.counts().unassigned()).isEqualTo(2);

    // Через пять часов без реакции — просрочена первая реакция; счётчик и фильтр это видят.
    now.addAndGet(Duration.ofHours(5).toMillis());
    assertThat(support.get(id).ticket().breached()).isTrue();
    assertThat(support.counts().breached()).isEqualTo(2);
    assertThat(support.counts().fresh()).isEqualTo(2);
    assertThat(support.search(overdue())).hasSize(2);

    // Назначили, подняли приоритет, пометили — по строке ленты на каждую перемену, от агента.
    mvc.perform(
            put("/api/v1/admin/support/" + id)
                .header(AdminAccess.HEADER, token)
                .header(SupportController.ACTOR, "agent")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"assignee\":\"owner\",\"priority\":\"high\",\"tags\":\"Звук, наушники звук\"}"))
        .andExpect(status().isNoContent());
    var assigned = support.get(id);
    assertThat(assigned.ticket().assignee()).isEqualTo("owner");
    assertThat(assigned.ticket().priority()).isEqualTo("high");
    assertThat(assigned.ticket().tags()).containsExactly("звук", "наушники");
    assertThat(assigned.notes())
        .extracting(SupportService.Note::kind, SupportService.Note::text)
        .containsExactly(
            tuple("assign", "owner"), tuple("priority", "high"), tuple("tags", "звук наушники"));
    assertThat(assigned.notes()).allMatch(note -> note.author().equals("agent"));
    assertThat(support.counts().unassigned()).isEqualTo(1);
    // То же самое ещё раз — ленту не засоряет.
    support.update(id, "owner", "high", "наушники звук", "owner");
    assertThat(support.get(id).notes()).hasSize(3);
    // Срочные — первыми, без назначения — отдельным фильтром.
    assertThat(
            support.search(
                new SupportService.Filter(
                    null, null, null, null, null, null, null, SupportService.Sort.PRIORITY, null)))
        .extracting(SupportService.Entry::id)
        .containsExactly(id, other);
    assertThat(support.search(new SupportService.Filter(null, null, "-", null, null, null, null)))
        .extracting(SupportService.Entry::id)
        .containsExactly(other);

    // Взяли в работу — первая реакция состоялась, SLA первой реакции больше не горит.
    mvc.perform(
            put("/api/v1/admin/support/" + id + "/status")
                .header(AdminAccess.HEADER, token)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"status\":\"OPEN\"}"))
        .andExpect(status().isNoContent());
    var open = support.get(id).ticket();
    assertThat(open.status()).isEqualTo(Status.OPEN);
    assertThat(open.firstResponseAt()).isEqualTo(now.get());
    assertThat(open.breached()).isFalse();
    assertThat(support.search(overdue()))
        .extracting(SupportService.Entry::id)
        .containsExactly(other);

    // Заметка себе и ответ человеку: ответ переводит в «ждём человека».
    mvc.perform(
            post("/api/v1/admin/support/" + id + "/notes")
                .header(AdminAccess.HEADER, token)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"kind\":\"note\",\"text\":\"Похоже на Bluetooth-профиль HFP\"}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.kind").value("note"));
    mvc.perform(
            post("/api/v1/admin/support/" + id + "/notes")
                .header(AdminAccess.HEADER, token)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"kind\":\"reply\",\"text\":\"Попробуйте выбрать наушники вручную в настройках\"}"))
        .andExpect(status().isOk());
    var waiting = support.get(id);
    assertThat(waiting.ticket().status()).isEqualTo(Status.WAITING);
    assertThat(waiting.notes())
        .extracting(SupportService.Note::kind)
        .containsExactly("assign", "priority", "tags", "status", "note", "reply", "status");

    // Трое суток ждём человека: срок решения (48 ч) вышел бы, но часы SLA стоят.
    now.addAndGet(Duration.ofDays(3).toMillis());
    var paused = support.get(id).ticket();
    assertThat(paused.breached()).isFalse();
    assertThat(paused.resolveDueAt()).isEqualTo(created + Duration.ofHours(48 + 72).toMillis());
    // Человек ответил — снова в работе; ожидание осталось в паузе.
    support.setStatus(id, Status.OPEN, "owner");
    assertThat(support.get(id).ticket().pausedMs()).isEqualTo(Duration.ofDays(3).toMillis());
    assertThat(support.get(id).ticket().breached()).isFalse();

    // Решено: первая реакция опоздала на час — SLA не соблюдён.
    support.setStatus(id, Status.DONE, "owner");
    var done = support.get(id).ticket();
    assertThat(done.resolvedAt()).isEqualTo(now.get());
    assertThat(done.slaMet()).isFalse();
    var stats = support.stats(30);
    assertThat(stats.created()).isEqualTo(2);
    assertThat(stats.resolved()).isEqualTo(1);
    assertThat(stats.firstResponseMedianMinutes()).isEqualTo(300.0);
    // Решали 77 ч, из них 72 ждали человека.
    assertThat(stats.resolveMedianMinutes()).isEqualTo(300.0);
    assertThat(stats.withinSla()).isEqualTo(0.0);
    assertThat(stats.topics()).containsEntry("camera", 2L);

    // В архив: из ящика уходит, но находится по статусу, номеру, метке и тексту ленты.
    support.setStatus(id, Status.ARCHIVED, "owner");
    assertThat(support.get(id).ticket().archivedAt()).isEqualTo(now.get());
    assertThat(support.get(id).ticket().resolvedAt()).isEqualTo(done.resolvedAt());
    assertThat(support.search(new SupportService.Filter(null, null, null, null, null, null, null)))
        .extracting(SupportService.Entry::id)
        .containsExactly(other);
    assertThat(support.search(query(Status.ARCHIVED, null)))
        .extracting(SupportService.Entry::id)
        .containsExactly(id);
    assertThat(support.search(query(Status.ARCHIVED, id.substring(0, 8).toUpperCase(Locale.ROOT))))
        .hasSize(1);
    assertThat(support.search(query(Status.ARCHIVED, "наушники"))).hasSize(1);
    assertThat(support.search(query(Status.ARCHIVED, "bluetooth"))).hasSize(1);
    assertThat(
            support.search(new SupportService.Filter(null, "sound", null, null, null, null, null)))
        .isEmpty();
    assertThat(support.counts().archived()).isEqualTo(1);

    mvc.perform(get("/api/v1/admin/support").header(AdminAccess.HEADER, token).param("q", "тёмную"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.length()").value(1))
        .andExpect(jsonPath("$[0].id").value(other));
    mvc.perform(
            get("/api/v1/admin/support")
                .header(AdminAccess.HEADER, token)
                .param("overdue", "true")
                .param("sort", "OLD"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$[0].id").value(other));
    mvc.perform(get("/api/v1/admin/support/counts").header(AdminAccess.HEADER, token))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.fresh").value(1))
        .andExpect(jsonPath("$.archived").value(1));
    mvc.perform(get("/api/v1/admin/support/stats").header(AdminAccess.HEADER, token))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.created").value(2));
    mvc.perform(get("/api/v1/admin/support/" + id).header(AdminAccess.HEADER, token))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.ticket.status").value("ARCHIVED"))
        .andExpect(jsonPath("$.notes.length()").value(10));
    mvc.perform(get("/api/v1/admin/support/" + id)).andExpect(status().isUnauthorized());

    // Шаг назад разрешён: из архива в работу — решение и архив снимаются.
    support.setStatus(id, Status.OPEN, "owner");
    assertThat(support.get(id).ticket().resolvedAt()).isNull();
    assertThat(support.get(id).ticket().archivedAt()).isNull();

    // Уборка уносит и ленту.
    now.addAndGet(Duration.ofDays(31).toMillis());
    assertThat(support.forgetOld()).isEqualTo(2);
    assertThat(jdbc.sql("SELECT COUNT(*) FROM support_notes").query(Long.class).single()).isZero();
  }

  /**
   * Пульт, вторая вкладка и кнопка Telegram жмут одно и то же разом: шаг из «ждём человека»
   * делается один раз — пауза SLA не удваивается, в ленте один переход, а не столько, сколько
   * нажатий.
   */
  @Test
  void concurrentMovesOfOneTicketAreDoneOnce() throws Exception {
    var id = submit(fresh(), "Камера чёрная у всех собеседников");
    support.setStatus(id, Status.WAITING, "owner");
    now.addAndGet(Duration.ofHours(2).toMillis());
    int hands = 8;
    var start = new java.util.concurrent.CountDownLatch(1);
    var pool = java.util.concurrent.Executors.newFixedThreadPool(hands);
    try {
      var done = new ArrayList<java.util.concurrent.Future<?>>();
      for (int i = 0; i < hands; i++)
        done.add(
            pool.submit(
                () -> {
                  start.await();
                  support.setStatus(id, Status.OPEN, "owner");
                  return null;
                }));
      start.countDown();
      for (var future : done) future.get(30, java.util.concurrent.TimeUnit.SECONDS);
    } finally {
      pool.shutdownNow();
    }
    var ticket = support.get(id);
    assertThat(ticket.ticket().pausedMs()).isEqualTo(Duration.ofHours(2).toMillis());
    assertThat(ticket.notes())
        .extracting(SupportService.Note::kind, SupportService.Note::text)
        .containsExactly(tuple("status", "waiting"), tuple("status", "open"));
  }

  /** Решённое через две недели само уходит в архив — с записью в ленте от системы. */
  @Test
  void resolvedTicketsMoveToTheArchiveByThemselves() throws Exception {
    var done = submit(fresh(), "Спасибо, всё заработало после обновления");
    var open = submit(fresh(), "Ещё не решено, но в работе");
    support.setStatus(done, Status.DONE, "owner");
    support.setStatus(open, Status.OPEN, "owner");
    now.addAndGet(Duration.ofDays(13).toMillis());
    assertThat(support.archiveResolved()).isZero();
    now.addAndGet(Duration.ofDays(2).toMillis());
    assertThat(support.archiveResolved()).isEqualTo(1);
    var archived = support.get(done);
    assertThat(archived.ticket().status()).isEqualTo(Status.ARCHIVED);
    assertThat(archived.notes().getLast().author()).isEqualTo("system");
    assertThat(support.get(open).ticket().status()).isEqualTo(Status.OPEN);
    // Владелец вернул его из архива в «решено» — следующий проход не уносит его обратно сразу.
    support.setStatus(done, Status.DONE, "owner");
    assertThat(support.archiveResolved()).isZero();
    now.addAndGet(Duration.ofDays(15).toMillis());
    assertThat(support.archiveResolved()).isEqualTo(1);
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
