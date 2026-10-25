package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import dev.mikki.stream.access.AdminAccess;
import dev.mikki.stream.access.Blocks;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.activity.ActivityReport;
import dev.mikki.stream.activity.Audit;
import dev.mikki.stream.activity.Metrics;
import dev.mikki.stream.api.ActivityController;
import dev.mikki.stream.api.ApiController;
import dev.mikki.stream.api.ApiErrors;
import dev.mikki.stream.api.ClientAddress;
import dev.mikki.stream.api.InternalController;
import dev.mikki.stream.attachment.TusGateway;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.media.MediaGateway;
import dev.mikki.stream.room.Contracts.*;
import dev.mikki.stream.room.Maintenance;
import dev.mikki.stream.room.RoomService;
import dev.mikki.stream.shared.Problem;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Clock;
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
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/**
 * Надёжность ядра (W1b): дренаж перед выкаткой ({@link Maintenance}), сводки приёма от браузеров
 * ({@code POST /rooms/{id}/quality}) и вебхуки служебной комнаты куратора.
 *
 * <p>Контекст — тот же, что у {@link RoomServiceTest}: Spring поднимает его один раз.
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
class ReliabilityTest {
  @Autowired WebApplicationContext web;
  @Autowired RoomService rooms;
  @Autowired ApiController api;
  @Autowired Maintenance maintenance;
  @Autowired MeterRegistry registry;
  @Autowired JdbcClient jdbc;
  @Autowired ActivityReport report;
  @Autowired Audit audit;
  @Autowired Blocks blocks;
  @Autowired RateLimits limits;
  @Autowired ClientAddress address;
  @Autowired Secrets secrets;
  @Autowired StreamProperties config;
  @Autowired Metrics metrics;
  @MockitoBean MediaGateway gateway;
  @MockitoBean TusGateway tus;
  @MockitoBean Clock clock;
  AtomicLong now = new AtomicLong(System.currentTimeMillis());
  MockMvc mvc;

  @BeforeEach
  void setUp() {
    jdbc.sql("DELETE FROM command_receipts").update();
    jdbc.sql("DELETE FROM rooms").update();
    jdbc.sql("DELETE FROM audit_events").update();
    when(clock.millis()).thenAnswer(_ -> now.get());
    when(tus.terminate(anyString())).thenReturn(true);
    mvc = MockMvcBuilders.webAppContextSetup(web).build();
  }

  @AfterEach
  void tearDown() {
    maintenance.set(false);
  }

  Admission host() {
    return rooms.create(new Create(UUID.randomUUID(), "Встреча", "Организатор", false));
  }

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
   * Дренаж: рычаг владельца включает обслуживание — новая встреча получает {@code 503 MAINTENANCE}
   * с {@code Retry-After}, главная видит {@code admissionOpen=false}, а вход в идущую встречу
   * открыт. Переключение — в журнале и в метре {@code cord_maintenance}.
   */
  @Test
  void maintenanceRefusesNewRoomsButKeepsJoinsOpen() {
    var before = host();
    var owner = owner();
    var http = new MockHttpServletRequest("POST", "/api/v1/admin/session");
    http.setRemoteAddr("192.0.2.77");
    var token = owner.login(new ActivityController.Login("пароль владельца"), http).token();
    assertThat(owner.maintenance(token).on()).isFalse();

    var state = owner.maintenance(token, new ActivityController.MaintenanceRequest(true), http);
    assertThat(state.on()).isTrue();
    assertThat(state.since()).isEqualTo(now.get());
    assertThat(registry.get("cord.maintenance").gauge().value()).isEqualTo(1);
    assertThat(api.capabilities().admissionOpen()).isFalse();

    assertThatThrownBy(this::host)
        .isInstanceOfSatisfying(
            Problem.class,
            p -> {
              assertThat(p.status()).isEqualTo(503);
              assertThat(p.code()).isEqualTo("MAINTENANCE");
              assertThat(p.properties()).containsEntry("retryAfter", 120);
            });
    // Идущая встреча живёт: гость входит, как будто ничего не случилось.
    var guest =
        rooms.join(
            before.roomId(),
            new Join(UUID.randomUUID(), before.inviteUrl().split("invite=")[1], "Гость"));
    assertThat(guest.roomId()).isEqualTo(before.roomId());

    // Срок уходит и заголовком — его читает скрипт выкатки и прокси.
    var response = new ApiErrors().problem(maintenance.refusal());
    assertThat(response.getHeaders().getFirst(HttpHeaders.RETRY_AFTER)).isEqualTo("120");
    assertThat(response.getBody().getProperties()).containsEntry("code", "MAINTENANCE");

    owner.maintenance(token, new ActivityController.MaintenanceRequest(false), http);
    assertThat(registry.get("cord.maintenance").gauge().value()).isEqualTo(0);
    assertThat(api.capabilities().admissionOpen()).isTrue();
    assertThat(host().roomId()).isNotNull();
    var actions =
        audit
            .query(new Audit.Filter(null, null, null, null, null, null, null, null, null))
            .items()
            .stream()
            .filter(e -> e.action().equals("admin.maintenance"))
            .count();
    assertThat(actions).isEqualTo(2);
  }

  /**
   * Сводки приёма: пропуск участника, числа — в гистограммы по классу дорожки, чаще раза в окно —
   * {@code 429}, чужой класс — {@code 400}; в метках — только класс.
   */
  @Test
  void receiveSummariesBecomeMetersAndAreRateLimited() throws Exception {
    var host = host();
    var body =
        """
        {"tracks":[{"kind":"media","concealed":480,"total":480000,"events":3,"lost":2,"targetMs":800,"delayMs":650},
                   {"kind":"conversation","concealed":0,"total":480000,"events":0,"lost":0,"targetMs":120,"delayMs":null}]}
        """;
    var reports = registry.counter("cord.rx.reports").count();
    mvc.perform(
            post("/api/v1/rooms/" + host.roomId() + "/quality")
                .header("Authorization", "Bearer " + host.credential())
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
        .andExpect(status().isNoContent());
    assertThat(registry.counter("cord.rx.reports").count()).isEqualTo(reports + 1);
    var ratio = registry.get("cord.rx.conceal.ratio").tag("kind", "media").summary();
    assertThat(ratio.count()).isGreaterThanOrEqualTo(1);
    assertThat(ratio.max()).isEqualTo(0.001);
    assertThat(registry.get("cord.rx.target.ms").tag("kind", "conversation").summary().max())
        .isEqualTo(120);
    assertThat(registry.get("cord.rx.concealment.events").tag("kind", "media").counter().count())
        .isGreaterThanOrEqualTo(3);
    assertThat(registry.find("cord.rx.delay.ms").tag("kind", "conversation").summary()).isNull();
    // Второй раз за окно с того же входа — отказ: сводка раз в десять секунд, не чаще.
    mvc.perform(
            post("/api/v1/rooms/" + host.roomId() + "/quality")
                .header("Authorization", "Bearer " + host.credential())
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
        .andExpect(status().isTooManyRequests())
        .andExpect(jsonPath("$.code").value("RATE_LIMITED"));
    // Класс не из перечисления — не сводка.
    mvc.perform(
            post("/api/v1/rooms/" + host.roomId() + "/quality")
                .header("Authorization", "Bearer " + host.credential())
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {"tracks":[{"kind":"PA_track_7","concealed":1,"total":2,"events":0,"lost":0,"targetMs":1}]}
                    """))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
    // Чужой пропуск — отказ.
    mvc.perform(
            post("/api/v1/rooms/" + host.roomId() + "/quality")
                .header("Authorization", "Bearer " + host.participantId() + ".wrong")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
        .andExpect(status().isForbidden());
    // Метки метров приёма — только класс дорожки.
    registry.getMeters().stream()
        .filter(m -> m.getId().getName().startsWith("cord.rx."))
        .forEach(
            m ->
                assertThat(m.getId().getTags())
                    .allSatisfy(tag -> assertThat(tag.getKey()).isEqualTo("kind")));
  }

  /**
   * Служебная комната куратора ядру неизвестна: её вебхуки пропускаются, а не считаются отказами.
   */
  @Test
  void probeRoomWebhooksAreNotRoomsOfTheCore() {
    assertThat(InternalController.isRoomId("cord-probe")).isFalse();
    assertThat(InternalController.isRoomId(null)).isFalse();
    assertThat(InternalController.isRoomId(UUID.randomUUID().toString())).isTrue();
  }
}
