package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import dev.mikki.stream.access.AdminAccess;
import dev.mikki.stream.access.Identity;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.activity.Analytics;
import dev.mikki.stream.activity.AnalyticsReport;
import dev.mikki.stream.activity.ClientKind;
import dev.mikki.stream.room.RoomState;
import dev.mikki.stream.shared.Json;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/**
 * Аналитика продукта (R210): визиты и входы ложатся строками посетителя и дня без адресов и имён;
 * отчёт отвечает в двух измерениях — ЛТВ и АКТУАЛ — и считает удержание по когорте первого дня.
 */
@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:analytics;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.retention.analytics=100 days",
      "stream.admin-password=пароль владельца"
    })
@ActiveProfiles("local")
class AnalyticsTest {
  static final String PROFILE_A = "a".repeat(43);
  static final String PROFILE_B = "b".repeat(43);
  static final ClientKind WEB = new ClientKind("web", "windows");
  static final ClientKind DESKTOP = new ClientKind("desktop", "windows");

  @Autowired WebApplicationContext web;
  @Autowired Analytics analytics;
  @Autowired AnalyticsReport report;
  @Autowired JdbcClient jdbc;
  @Autowired Secrets secrets;
  @MockitoBean Clock clock;
  AtomicLong now = new AtomicLong();
  long day1;
  MockMvc mvc;

  @BeforeEach
  void setUp() {
    jdbc.sql("DELETE FROM visitor_days").update();
    jdbc.sql("DELETE FROM visitors").update();
    jdbc.sql("DELETE FROM meeting_stats").update();
    // Полдень первого дня по UTC — чтобы сдвиги на сутки не пересекали полуночь случайно.
    day1 = LocalDate.of(2026, 11, 2).atTime(12, 0).toInstant(ZoneOffset.UTC).toEpochMilli();
    now.set(day1);
    when(clock.millis()).thenAnswer(_ -> now.get());
    mvc = MockMvcBuilders.webAppContextSetup(web).build();
  }

  static long ms(LocalDate day) {
    return day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
  }

  LocalDate today() {
    return LocalDate.ofInstant(Instant.ofEpochMilli(now.get()), ZoneOffset.UTC);
  }

  String adminToken() throws Exception {
    var session =
        mvc.perform(
                post("/api/v1/admin/session")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"password\":\"пароль владельца\"}"))
            .andReturn()
            .getResponse()
            .getContentAsString();
    return Json.tree(session).path("token").asText();
  }

  @Test
  void aVisitBecomesAPseudonymousRowWithoutAddressOrSecret() throws Exception {
    mvc.perform(
            post("/api/v1/visit")
                .header(Identity.PROFILE, PROFILE_A)
                .header(ClientKind.HEADER, "desktop")
                .header("User-Agent", "Cord/1.2 Electron/38 Windows NT 10.0")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"stage\":\"open\"}"))
        .andExpect(status().isNoContent());
    mvc.perform(
            post("/api/v1/visit")
                .header(Identity.PROFILE, PROFILE_A)
                .header(ClientKind.HEADER, "desktop")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"stage\":\"prejoin\"}"))
        .andExpect(status().isNoContent());
    // Без профиля — суточный отпечаток адреса: посетитель дня, но не когорты.
    mvc.perform(
            post("/api/v1/visit")
                .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) Firefox/140")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"stage\":\"open\"}"))
        .andExpect(status().isNoContent());
    mvc.perform(
            post("/api/v1/visit")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"stage\":\"later\"}"))
        .andExpect(status().isBadRequest());

    var keys =
        jdbc.sql("SELECT visitor_key FROM visitors ORDER BY anonymous").query(String.class).list();
    assertThat(keys).hasSize(2);
    // Ключ — HMAC, а не хэш профиля и не сам секрет: по таблице нельзя найти ни избранное, ни
    // адрес.
    assertThat(keys.getFirst())
        .isEqualTo(secrets.derive("analytics:" + Secrets.hash(PROFILE_A)))
        .isNotEqualTo(Secrets.hash(PROFILE_A))
        .doesNotContain(PROFILE_A);
    assertThat(
            jdbc.sql("SELECT first_client FROM visitors WHERE anonymous=FALSE")
                .query(String.class)
                .single())
        .isEqualTo("desktop");
    assertThat(
            jdbc.sql("SELECT first_os FROM visitors WHERE anonymous=TRUE")
                .query(String.class)
                .single())
        .isEqualTo("linux");
    var days =
        jdbc.sql("SELECT visits, prejoins FROM visitor_days WHERE visitor_key=?")
            .param(keys.getFirst())
            .query((rs, n) -> new int[] {rs.getInt(1), rs.getInt(2)})
            .single();
    assertThat(days).containsExactly(1, 1);
    // Все строки — только числа и слова из перечислений.
    var columns =
        jdbc.sql("SELECT * FROM visitor_days")
            .query((rs, n) -> rs.getMetaData().getColumnCount())
            .list();
    assertThat(columns).isNotEmpty();
  }

  @Test
  void visitsAreRateLimitedPerAddress() throws Exception {
    for (int i = 0; i < 30; i++)
      mvc.perform(
              post("/api/v1/visit")
                  .with(
                      r -> {
                        r.setRemoteAddr("198.18.7.7");
                        return r;
                      })
                  .contentType(MediaType.APPLICATION_JSON)
                  .content("{\"stage\":\"open\"}"))
          .andExpect(status().isNoContent());
    mvc.perform(
            post("/api/v1/visit")
                .with(
                    r -> {
                      r.setRemoteAddr("198.18.7.7");
                      return r;
                    })
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"stage\":\"open\"}"))
        .andExpect(status().isTooManyRequests());
  }

  @Test
  void presenceIsCreditedToTheProfileWhenItLeavesTheCall() {
    var room = new RoomState();
    room.id = "room-1";
    room.startedAt = now.get();
    var a = member("m-a", RoomState.Status.CONNECTED);
    var b = member("m-b", RoomState.Status.CONNECTED);
    var bot = member("music", RoomState.Status.CONNECTED);
    bot.service = "music";
    room.members.put(a.id, a);
    room.members.put(b.id, b);
    room.members.put(bot.id, bot);
    room.profiles.put(a.id, Secrets.hash(PROFILE_A));
    // У b профиля нет (старый клиент) — его минуты никому не приписываются.
    analytics.entered(Secrets.hash(PROFILE_A), "198.18.0.1", WEB, "create", true);
    analytics.changed(room, "room.changed", now.get());

    now.addAndGet(90_000);
    a.status = RoomState.Status.RECOVERING;
    analytics.changed(room, "room.changed", now.get());
    var keyA = secrets.derive("analytics:" + Secrets.hash(PROFILE_A));
    assertThat(
            jdbc.sql("SELECT presence_seconds FROM visitor_days WHERE visitor_key=?")
                .param(keyA)
                .query(Long.class)
                .single())
        .isEqualTo(90);

    // Вернулся, во встрече появилась музыка — открытие интеграции засчитано тому, кто был на связи.
    a.status = RoomState.Status.CONNECTED;
    analytics.changed(room, "room.changed", now.get());
    now.addAndGet(30_000);
    analytics.closed(room, "empty", now.get());
    assertThat(
            jdbc.sql("SELECT presence_seconds, integrations FROM visitor_days WHERE visitor_key=?")
                .param(keyA)
                .query((rs, n) -> new long[] {rs.getLong(1), rs.getLong(2)})
                .single())
        .containsExactly(120, 1);
    assertThat(jdbc.sql("SELECT COUNT(*) FROM visitor_days").query(Long.class).single())
        .isEqualTo(1);
  }

  /**
   * Два измерения на одной картине. День 1: A открыл и создал встречу, B открыл, безымянный C
   * открыл. День 2: A вернулся и вошёл; D — новый, только открыл. АКТУАЛ за дни 1–2 видит всех; ЛТВ
   * за день 1 — когорту A и B и всё, что они сделали дальше; удержание D1 когорты дня 1 — половина.
   */
  @Test
  void theReportAnswersInBothDimensions() throws Exception {
    var hashA = Secrets.hash(PROFILE_A);
    var hashB = Secrets.hash(PROFILE_B);
    analytics.visit(hashA, "198.18.1.1", WEB, "open");
    analytics.visit(hashA, "198.18.1.1", WEB, "prejoin");
    analytics.entered(hashA, "198.18.1.1", WEB, "create", true);
    analytics.visit(hashB, "198.18.1.2", DESKTOP, "open");
    analytics.visit(null, "198.18.1.3", WEB, "open");
    analytics.errors(hashB, DESKTOP, 2);
    jdbc.sql(
            "INSERT INTO meeting_stats(room_id,started_at,ended_at,end_reason,peak_humans,human_seconds,"
                + "humans_since,integrations,expires_at) VALUES('r1',?,?,'empty',3,5400,?,'music',?)")
        .params(now.get(), now.get() + 1_800_000, now.get(), now.get() + 1_000_000_000L)
        .update();

    now.addAndGet(Duration.ofDays(1).toMillis());
    analytics.visit(hashA, "198.18.1.1", WEB, "open");
    analytics.entered(hashA, "198.18.1.1", WEB, "link", true);
    analytics.entered(hashA, "198.18.1.1", WEB, "rejoin", true);
    analytics.entered(hashA, "198.18.1.1", WEB, "code", false);
    var hashD = Secrets.hash("d".repeat(43));
    analytics.visit(hashD, "198.18.1.4", new ClientKind("android", "android"), "open");

    // Отчёт — на третий день, чтобы D1 когорты первого дня уже можно было посчитать.
    now.addAndGet(Duration.ofDays(1).toMillis());
    var token = adminToken();
    long from = ms(LocalDate.of(2026, 11, 2));
    long to = ms(LocalDate.of(2026, 11, 4));

    var actual =
        Json.read(
            mvc.perform(
                    get("/api/v1/admin/analytics")
                        .header(AdminAccess.HEADER, token)
                        .param("from", Long.toString(from))
                        .param("to", Long.toString(to))
                        .param("mode", "actual"))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString(),
            AnalyticsReport.Report.class);
    assertThat(actual.mode()).isEqualTo("actual");
    assertThat(actual.visitors().total()).isEqualTo(4);
    assertThat(actual.visitors().fresh()).isEqualTo(4);
    assertThat(actual.visitors().returning()).isEqualTo(0);
    assertThat(actual.visitors().callers()).isEqualTo(1);
    assertThat(actual.visitors().newCallers()).isEqualTo(1);
    assertThat(actual.rates().er()).isEqualTo(0.25);
    // Входов: create + link; rejoin не считается; отказ — отдельно.
    assertThat(actual.calls().entries()).isEqualTo(2);
    assertThat(actual.calls().joinFailures()).isEqualTo(1);
    assertThat(actual.calls().meetings()).isEqualTo(1);
    assertThat(actual.calls().meetingHours()).isEqualTo(1.5);
    assertThat(actual.calls().medianMinutes()).isEqualTo(30.0);
    assertThat(actual.calls().peakMeetings()).isEqualTo(1);
    assertThat(actual.calls().peakHumans()).isEqualTo(3);
    assertThat(actual.funnel().opened()).isEqualTo(4);
    assertThat(actual.funnel().prejoined()).isEqualTo(1);
    assertThat(actual.funnel().joined()).isEqualTo(1);
    assertThat(actual.rates().errorsPerVisit()).isEqualTo(2 / 5.0);
    assertThat(actual.clients())
        .extracting(AnalyticsReport.Share::kind, AnalyticsReport.Share::count)
        .containsExactly(tuple("android", 1L), tuple("desktop", 1L), tuple("web", 2L));
    assertThat(actual.integrations())
        .extracting(AnalyticsReport.Share::kind, AnalyticsReport.Share::count)
        .contains(tuple("music", 1L));
    assertThat(actual.days()).hasSize(2);
    assertThat(actual.days().getFirst().visitors()).isEqualTo(3);
    assertThat(actual.days().getFirst().fresh()).isEqualTo(3);
    assertThat(actual.days().get(1).visitors()).isEqualTo(2);
    assertThat(actual.days().get(1).fresh()).isEqualTo(1);
    // Удержание — по когорте первого дня внутри периода (A и B; безымянный C в когорту не входит):
    // A вернулся на следующий день, B — нет. D3 и дальше считать ещё рано.
    assertThat(actual.retention()).hasSize(2);
    var cohort = actual.retention().getFirst();
    assertThat(cohort.since()).isEqualTo("2026-11-02");
    assertThat(cohort.size()).isEqualTo(2);
    assertThat(cohort.d1()).isEqualTo(0.5);
    assertThat(cohort.d3()).isNull();
    assertThat(actual.retention().get(1).d1()).isEqualTo(0.0);

    // ЛТВ за первый день: когорта A и B и вся их жизнь — включая второй день A.
    var ltv = report.report(from, ms(LocalDate.of(2026, 11, 3)), AnalyticsReport.LTV);
    assertThat(ltv.mode()).isEqualTo("ltv");
    assertThat(ltv.visitors().total()).isEqualTo(2);
    assertThat(ltv.visitors().callers()).isEqualTo(1);
    assertThat(ltv.rates().er()).isEqualTo(0.5);
    assertThat(ltv.calls().entries()).isEqualTo(2);
    assertThat(ltv.calls().meetings()).isEqualTo(0);
    assertThat(ltv.funnel().opened()).isEqualTo(2);
    assertThat(ltv.clients())
        .extracting(AnalyticsReport.Share::kind, AnalyticsReport.Share::count)
        .containsExactly(tuple("desktop", 1L), tuple("web", 1L));
    assertThat(ltv.days())
        .extracting(AnalyticsReport.Day::day)
        .containsExactly("2026-11-02", "2026-11-03");
    assertThat(ltv.retention()).hasSize(1);
    assertThat(ltv.retention().getFirst().d1()).isEqualTo(0.5);

    // В ответе нет ни ключей, ни адресов.
    var body =
        mvc.perform(
                get("/api/v1/admin/analytics")
                    .header(AdminAccess.HEADER, token)
                    .param("from", Long.toString(from))
                    .param("to", Long.toString(to))
                    .param("mode", "ltv"))
            .andReturn()
            .getResponse()
            .getContentAsString();
    assertThat(body).doesNotContain("198.18.").doesNotContain(hashA).doesNotContain("visitor_key");
    mvc.perform(get("/api/v1/admin/analytics").param("from", "1").param("to", "2"))
        .andExpect(status().isUnauthorized());
  }

  @Test
  void oldRowsAreForgottenBySweep() {
    analytics.visit(Secrets.hash(PROFILE_A), null, WEB, "open");
    assertThat(analytics.sweep(now.get())).isEqualTo(0);
    now.addAndGet(Duration.ofDays(101).toMillis());
    assertThat(analytics.sweep(now.get())).isEqualTo(2);
    assertThat(jdbc.sql("SELECT COUNT(*) FROM visitors").query(Long.class).single()).isZero();
  }

  @Test
  void clientKindIsAWordFromTheHeaderOrTheAgent() {
    assertThat(ClientKind.of("telegram", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)"))
        .isEqualTo(new ClientKind("telegram", "ios"));
    assertThat(ClientKind.of(null, "Cord/1.2 Chrome/140 Electron/38 (Windows NT 10.0)"))
        .isEqualTo(new ClientKind("desktop", "windows"));
    assertThat(ClientKind.of("fridge", "Mozilla/5.0 (Linux; Android 15; wv)"))
        .isEqualTo(new ClientKind("android", "android"));
    assertThat(ClientKind.of("web", "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1)"))
        .isEqualTo(new ClientKind("web", "macos"));
    assertThat(ClientKind.of(null, null)).isEqualTo(ClientKind.UNKNOWN);
  }

  private static RoomState.Member member(String id, RoomState.Status status) {
    var member = new RoomState.Member();
    member.id = id;
    member.name = id;
    member.status = status;
    member.joinedAt = 1;
    return member;
  }
}
