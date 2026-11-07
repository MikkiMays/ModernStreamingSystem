package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.nullValue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import dev.mikki.stream.access.AdminAccess;
import dev.mikki.stream.attachment.TusGateway;
import dev.mikki.stream.media.MediaGateway;
import dev.mikki.stream.room.Contracts.Create;
import dev.mikki.stream.room.Maintenance;
import dev.mikki.stream.room.MaintenanceWindows;
import dev.mikki.stream.room.RoomService;
import dev.mikki.stream.shared.Json;
import java.time.Clock;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/** Ручки владельца для технических работ (R194): пропуск, предел, форматы времени, журнал. */
@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:maintenanceapi;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.files-root=./.local/test-uploads",
      "stream.abuse.human-check=off",
      "stream.admin-password=" + MaintenanceControllerTest.PASSWORD
    })
@ActiveProfiles("local")
class MaintenanceControllerTest {
  static final String PASSWORD = "owner-password-for-tests";
  private static final String BASE = "/api/v1/admin/maintenance/window";

  @Autowired WebApplicationContext web;
  @Autowired MaintenanceWindows windows;
  @Autowired Maintenance maintenance;
  @Autowired RoomService rooms;
  @Autowired AdminAccess admin;
  @Autowired JdbcClient jdbc;
  @MockitoBean MediaGateway gateway;
  @MockitoBean TusGateway tus;
  @MockitoBean Clock clock;
  final AtomicLong now = new AtomicLong(Instant.parse("2026-11-10T00:00:00Z").toEpochMilli());
  MockMvc mvc;
  String token;
  // Свой адрес на тест: предел запросов считается по адресу и живёт весь контекст.
  String address;

  @BeforeEach
  void setUp() {
    clean();
    when(clock.millis()).thenAnswer(_ -> now.get());
    when(tus.terminate(anyString())).thenReturn(true);
    mvc = MockMvcBuilders.webAppContextSetup(web).build();
    token = admin.connect(PASSWORD).token();
    address = "192.0.2." + (1 + (UUID.randomUUID().hashCode() & 0x7f));
  }

  @AfterEach
  void tearDown() {
    clean();
  }

  private void clean() {
    jdbc.sql("DELETE FROM maintenance_windows").update();
    jdbc.sql("DELETE FROM command_receipts").update();
    jdbc.sql("DELETE FROM rooms").update();
    jdbc.sql("DELETE FROM audit_events").update();
    windows.forget();
    maintenance.set(false);
  }

  private MockHttpServletRequestBuilder owner(MockHttpServletRequestBuilder request) {
    return request
        .header(AdminAccess.HEADER, token)
        .with(
            r -> {
              r.setRemoteAddr(address);
              return r;
            });
  }

  private MockHttpServletRequestBuilder json(String path, String body) {
    return owner(post(BASE + path)).contentType(MediaType.APPLICATION_JSON).content(body);
  }

  @Test
  void everyLeverNeedsTheOwner() throws Exception {
    mvc.perform(get(BASE)).andExpect(status().isUnauthorized());
    mvc.perform(delete(BASE)).andExpect(status().isUnauthorized());
    mvc.perform(post(BASE + "/now").contentType(MediaType.APPLICATION_JSON).content("{}"))
        .andExpect(status().isUnauthorized())
        .andExpect(jsonPath("$.code").value("ADMIN_REQUIRED"));
    mvc.perform(
            post(BASE + "/schedule")
                .header(AdminAccess.HEADER, "1.подделка")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"startsAt\":\"2026-11-10T04:00:00+03:00\"}"))
        .andExpect(status().isUnauthorized());
    assertThat(windows.current()).isEmpty();
  }

  @Test
  void statusWithoutWindowSaysNone() throws Exception {
    mvc.perform(owner(get(BASE)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.phase").value("none"))
        .andExpect(jsonPath("$.window").value(nullValue()));
  }

  /** Окно на четыре утра по Москве: ответ — ISO-8601 в UTC, срок выхода назван сразу. */
  @Test
  void scheduleAcceptsMoscowTimeAndAnswersInUtc() throws Exception {
    mvc.perform(
            json(
                "/schedule",
                """
                {"startsAt":"2026-11-10T04:00:00+03:00","endsAt":"2026-11-10T05:00:00+03:00",
                 "reason":"Обновление 1.1.7"}"""))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.phase").value("scheduled"))
        .andExpect(jsonPath("$.window.kind").value("scheduled"))
        .andExpect(jsonPath("$.window.startsAt").value("2026-11-10T01:00:00Z"))
        .andExpect(jsonPath("$.window.endsAt").value("2026-11-10T02:00:00Z"))
        .andExpect(jsonPath("$.window.expiresAt").value("2026-11-10T03:00:00Z"))
        .andExpect(jsonPath("$.window.reason").value("Обновление 1.1.7"));
    assertThat(windows.current()).isPresent();
    assertThat(audit("admin.maintenance_window")).contains("\"do\":\"schedule\"");
  }

  @Test
  void timeWithoutOffsetIsRefused() throws Exception {
    mvc.perform(json("/schedule", "{\"startsAt\":\"2026-11-10T04:00:00\"}"))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.code").value("MAINTENANCE_WINDOW_INVALID"));
  }

  @Test
  void graceOutOfRangeIsRefused() throws Exception {
    mvc.perform(json("/now", "{\"graceSeconds\":-1}")).andExpect(status().isBadRequest());
    mvc.perform(json("/now", "{\"graceSeconds\":3601}")).andExpect(status().isBadRequest());
  }

  @Test
  void emergencyDefaultsToAShortGraceAndAcceptsNoBody() throws Exception {
    mvc.perform(owner(post(BASE + "/now")))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.phase").value("grace"))
        .andExpect(jsonPath("$.window.kind").value("emergency"))
        .andExpect(jsonPath("$.window.startsAt").value("2026-11-10T00:01:00Z"));
  }

  /** Журнал: кто и когда, без причины свободным текстом и без секретов (П8). */
  @Test
  void auditKnowsWhoAndWhenButNoFreeText() throws Exception {
    mvc.perform(json("/now", "{\"graceSeconds\":0,\"reason\":\"пароль базы qwerty утёк\"}"))
        .andExpect(status().isOk());
    var row = audit("admin.maintenance_window");
    assertThat(row).contains("\"do\":\"emergency\"").contains("\"graceSeconds\":0");
    assertThat(row).doesNotContain("qwerty");
    var who =
        jdbc.sql(
                "SELECT actor_kind, ip_hash, happened_at FROM audit_events WHERE"
                    + " action='admin.maintenance_window'")
            .query((rs, _) -> new Object[] {rs.getString(1), rs.getString(2), rs.getLong(3)})
            .single();
    assertThat(who[0]).isEqualTo("admin");
    assertThat(who[1]).isNotNull();
    assertThat((String) who[1]).doesNotContain(address);
    assertThat(who[2]).isEqualTo(now.get());
  }

  @Test
  void deleteCancelsAScheduledWindowAndFinishesARunningOne() throws Exception {
    mvc.perform(json("/schedule", "{\"startsAt\":\"2026-11-10T04:00:00+03:00\"}"))
        .andExpect(status().isOk());
    mvc.perform(owner(delete(BASE)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.phase").value("none"))
        .andExpect(jsonPath("$.closed").value("cancelled"));

    mvc.perform(json("/now", "{\"graceSeconds\":0}")).andExpect(status().isOk());
    mvc.perform(owner(delete(BASE)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.closed").value("finished"));
    // Повтор — не ошибка: окна уже нет.
    mvc.perform(owner(delete(BASE)))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.closed").value(nullValue()));
    assertThat(
            jdbc.sql(
                    "SELECT COUNT(*) FROM audit_events WHERE action='admin.maintenance_window'"
                        + " AND details LIKE '%\"do\":\"finish\"%'")
                .query(Long.class)
                .single())
        .isEqualTo(2);
  }

  @Test
  void extendMovesTheEstimate() throws Exception {
    mvc.perform(json("/now", "{\"graceSeconds\":0,\"endsAt\":\"2026-11-10T04:00:00+03:00\"}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.window.endsAt").value("2026-11-10T01:00:00Z"));
    mvc.perform(json("/extend", "{\"endsAt\":\"2026-11-10T05:00:00+03:00\"}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.window.endsAt").value("2026-11-10T02:00:00Z"));
  }

  @Test
  void secondWindowAnswersConflict() throws Exception {
    mvc.perform(json("/now", "{\"graceSeconds\":0}")).andExpect(status().isOk());
    mvc.perform(json("/now", "{\"graceSeconds\":0}"))
        .andExpect(status().isConflict())
        .andExpect(jsonPath("$.code").value("MAINTENANCE_WINDOW_EXISTS"));
  }

  /** Рычаги считаются пределом по адресу, как вход владельца. */
  @Test
  void leversAreRateLimited() throws Exception {
    // Отдельный адрес: остальные тесты делят свои, и выбранный здесь предел им не должен мешать.
    address = "198.51.100.77";
    int status = 200;
    for (int i = 0; i < 40 && status != 429; i++)
      status = mvc.perform(owner(delete(BASE))).andReturn().getResponse().getStatus();
    assertThat(status).isEqualTo(429);
  }

  /** Окно идёт: наружу — отказ с кодом и сроком; возможности говорят о нём без пароля. */
  @Test
  void clientsSeeTheWindowThroughTheOpenEndpointsOnly() throws Exception {
    // Нет окна — поля нет вовсе.
    mvc.perform(get("/api/v1/capabilities"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.maintenanceWindow").doesNotExist());

    mvc.perform(json("/now", "{\"graceSeconds\":0,\"reason\":\"внутренняя причина\"}"))
        .andExpect(status().isOk());
    var capabilities =
        mvc.perform(get("/api/v1/capabilities"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.admissionOpen").value(false))
            .andExpect(jsonPath("$.maintenance").value(true))
            .andExpect(jsonPath("$.maintenanceWindow.phase").value("active"))
            .andExpect(jsonPath("$.maintenanceWindow.startsAt").value(now.get()))
            .andExpect(jsonPath("$.maintenanceWindow.expiresAt").isNumber())
            .andReturn()
            .getResponse()
            .getContentAsString();
    // Причина — для владельца: снаружи её не видно.
    assertThat(capabilities).doesNotContain("внутренняя");

    mvc.perform(
            post("/api/v1/rooms")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    Json.write(new Create(UUID.randomUUID(), "Встреча", "Организатор", false))))
        .andExpect(status().isServiceUnavailable())
        .andExpect(header().exists(HttpHeaders.RETRY_AFTER))
        .andExpect(jsonPath("$.code").value("MAINTENANCE_WINDOW"))
        .andExpect(jsonPath("$.detail").value(containsString("технические работы")));
  }

  private String audit(String action) {
    return jdbc.sql("SELECT details FROM audit_events WHERE action=?")
        .param(action)
        .query(String.class)
        .single();
  }
}
