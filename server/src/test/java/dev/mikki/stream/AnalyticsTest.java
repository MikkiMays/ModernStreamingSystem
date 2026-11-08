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
import java.time.LocalDate;
import java.time.ZoneId;
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
 * Аналитика продукта (R210): визиты, входы, присутствие и ошибки ложатся строками посетителя и дня
 * — без адресов, имён и времени точнее дня; отчёт отвечает в двух измерениях (ЛТВ и АКТУАЛ) и
 * считает удержание D1/D3/D7/D30.
 */
@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:analytics;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.analytics.retention=100 days",
      "stream.analytics.zone=Europe/Moscow",
      "stream.admin-password=пароль владельца"
    })
@ActiveProfiles("local")
class AnalyticsTest {
  static final ZoneId MSK = ZoneId.of("Europe/Moscow");
  static final String PROFILE_A = "a".repeat(43);
  static final String PROFILE_B = "b".repeat(43);
  static final String PROFILE_D = "d".repeat(43);
  static final ClientKind WEB = new ClientKind("web", "windows");
  static final ClientKind DESKTOP = new ClientKind("desktop", "windows");
  static final ClientKind PHONE = new ClientKind("android", "android");

  @Autowired WebApplicationContext web;
  @Autowired Analytics analytics;
  @Autowired AnalyticsReport report;
  @Autowired JdbcClient jdbc;
  @Autowired Secrets secrets;
  @MockitoBean Clock clock;
  AtomicLong now = new AtomicLong();
  MockMvc mvc;

  static final LocalDate DAY1 = LocalDate.of(2026, 11, 2);

  @BeforeEach
  void setUp() {
    analytics.flush();
    jdbc.sql("DELETE FROM visitor_days").update();
    jdbc.sql("DELETE FROM visitors").update();
    jdbc.sql("DELETE FROM meeting_stats").update();
    // Полдень первого дня по Москве — чтобы сдвиги на сутки не пересекали полночь случайно.
    now.set(at(DAY1, 12, 0));
    when(clock.millis()).thenAnswer(_ -> now.get());
    mvc = MockMvcBuilders.webAppContextSetup(web).build();
  }

  static long at(LocalDate day, int hour, int minute) {
    return day.atTime(hour, minute).atZone(MSK).toInstant().toEpochMilli();
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

  String key(String profile) {
    return secrets.derive("analytics:" + Secrets.hash(profile));
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
    // Без профиля — принято, но не записано: адрес в аналитику не попадает даже отпечатком.
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
    // До прохода буфера в базе ничего нет: запрос человека в базу не пишет.
    assertThat(jdbc.sql("SELECT COUNT(*) FROM visitors").query(Long.class).single()).isZero();
    assertThat(analytics.flush()).isEqualTo(1);

    var keys = jdbc.sql("SELECT visitor_key FROM visitors").query(String.class).list();
    // Ключ — HMAC, а не хэш профиля и не сам секрет: по таблице нельзя найти ни избранное, ни
    // журнал.
    assertThat(keys)
        .containsExactly(key(PROFILE_A))
        .doesNotContain(Secrets.hash(PROFILE_A), PROFILE_A);
    var visitor =
        jdbc.sql("SELECT first_day, first_client, first_os, first_called_day FROM visitors")
            .query(
                (rs, n) ->
                    new Object[] {
                      rs.getObject(1, LocalDate.class),
                      rs.getString(2),
                      rs.getString(3),
                      rs.getObject(4, LocalDate.class)
                    })
            .single();
    assertThat(visitor).containsExactly(DAY1, "desktop", "windows", null);
    var day =
        jdbc.sql("SELECT visits, prejoins FROM visitor_days WHERE visitor_key=?")
            .param(key(PROFILE_A))
            .query((rs, n) -> new int[] {rs.getInt(1), rs.getInt(2)})
            .single();
    assertThat(day).containsExactly(1, 1);
    // Только даты, счётчики и слова: ни одной колонки со временем точнее дня или адресом.
    var columns =
        jdbc.sql(
                "SELECT column_name FROM information_schema.columns WHERE table_name IN"
                    + " ('visitors','visitor_days')")
            .query(String.class)
            .list();
    assertThat(columns)
        .doesNotContain("ip", "ip_hash", "address", "first_seen_at", "profile_hash", "room_id");
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

  /**
   * Присутствие — тому, кто на связи и с профилем: отрезок засчитывается при уходе со связи и при
   * каждом проходе буфера, через полночь режется по дням; интеграция засчитывается каждому, кто её
   * застал, один раз на вид.
   */
  @Test
  void presenceIsCreditedPerDayAndIntegrationsOncePerKind() {
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
    // У b профиля нет (служба) — его минуты никому не приписываются.
    analytics.entered(Secrets.hash(PROFILE_A), "198.18.0.1", WEB, "create", true);
    now.set(at(DAY1, 23, 58));
    analytics.changed(room, "room.changed", now.get());

    // Две минуты до полуночи и полторы после: 120 с в первый день, 90 — во второй.
    now.addAndGet(210_000);
    a.status = RoomState.Status.RECOVERING;
    analytics.changed(room, "room.changed", now.get());
    analytics.flush();
    assertThat(presence(DAY1)).isEqualTo(120);
    assertThat(presence(DAY1.plusDays(1))).isEqualTo(90);

    // Музыка (бот занял место) шла с начала — засчитана в первый день, один раз.
    a.status = RoomState.Status.CONNECTED;
    analytics.changed(room, "room.changed", now.get());
    analytics.changed(room, "message.created", now.get());
    // Идущая встреча: проход буфера досчитывает отрезок до «сейчас», не дожидаясь ухода.
    now.addAndGet(30_000);
    analytics.flush();
    assertThat(presence(DAY1.plusDays(1))).isEqualTo(120);
    now.addAndGet(10_500);
    analytics.closed(room, "empty", now.get());
    analytics.flush();
    var row =
        jdbc.sql(
                "SELECT presence_seconds, integrations, client FROM visitor_days WHERE visitor_key=?"
                    + " AND local_day=?")
            .params(key(PROFILE_A), DAY1.plusDays(1))
            .query((rs, n) -> new Object[] {rs.getLong(1), rs.getLong(2), rs.getString(3)})
            .single();
    // Музыку он уже застал вчера — сегодня не засчитана снова. Клиент строки дня без входа в этот
    // день — тот, с которым человек входил.
    assertThat(row).containsExactly(130L, 0L, "web");
    assertThat(
            jdbc.sql("SELECT integrations FROM visitor_days WHERE visitor_key=? AND local_day=?")
                .params(key(PROFILE_A), DAY1)
                .query(Long.class)
                .single())
        .isEqualTo(1);
    assertThat(jdbc.sql("SELECT COUNT(*) FROM visitors").query(Long.class).single()).isEqualTo(1);
  }

  private long presence(LocalDate day) {
    return jdbc.sql("SELECT presence_seconds FROM visitor_days WHERE visitor_key=? AND local_day=?")
        .params(key(PROFILE_A), day)
        .query(Long.class)
        .single();
  }

  /**
   * Два измерения на одной картине. День 1: A открыл, дошёл до предвхода и создал встречу; B открыл
   * с компьютера и увидел две ошибки. День 2: A вернулся и вошёл по ссылке (и ещё раз — возврат
   * после обрыва, не вход), один отказ; D — новый, с телефона, только открыл. АКТУАЛ за дни 1–2
   * видит всех троих; ЛТВ за день 1 — когорту A и B и всё, что они сделали дальше; удержание D1 —
   * половина.
   */
  @Test
  void theReportAnswersInBothDimensions() throws Exception {
    var hashA = Secrets.hash(PROFILE_A);
    var hashB = Secrets.hash(PROFILE_B);
    analytics.visit(hashA, WEB, "open");
    analytics.visit(hashA, WEB, "prejoin");
    analytics.entered(hashA, "198.18.1.1", WEB, "create", true);
    analytics.visit(hashB, DESKTOP, "open");
    analytics.errors(hashB, DESKTOP, 2);
    // Служба без профиля и без актора — не посетитель.
    analytics.entered(null, null, WEB, "link", true);
    jdbc.sql(
            "INSERT INTO meeting_stats(room_id,started_at,ended_at,end_reason,peak_humans,human_seconds,"
                + "humans_since,integrations,expires_at) VALUES('r1',?,?,'empty',3,5400,?,'music',?)")
        .params(now.get(), now.get() + 1_800_000, now.get(), now.get() + 1_000_000_000L)
        .update();
    jdbc.sql(
            "INSERT INTO meeting_stats(room_id,started_at,ended_at,end_reason,peak_humans,human_seconds,"
                + "humans_since,integrations,expires_at) VALUES('r2',?,?,'empty',2,1200,?,'',?)")
        .params(now.get() + 600_000, now.get() + 1_200_000, now.get(), now.get() + 1_000_000_000L)
        .update();
    analytics.flush();

    now.addAndGet(Duration.ofDays(1).toMillis());
    analytics.visit(hashA, WEB, "open");
    analytics.entered(hashA, "198.18.1.1", WEB, "link", true);
    analytics.entered(hashA, "198.18.1.1", WEB, "rejoin", true);
    analytics.entered(hashA, "198.18.1.1", WEB, "code", false);
    analytics.visit(Secrets.hash(PROFILE_D), PHONE, "open");
    analytics.flush();

    // Отчёт — на третий день, чтобы D1 когорты первого дня было уже можно посчитать.
    now.addAndGet(Duration.ofDays(1).toMillis());
    var token = adminToken();

    var actual =
        Json.read(
            mvc.perform(
                    get("/api/v1/admin/analytics")
                        .header(AdminAccess.HEADER, token)
                        .param("from", "2026-11-02")
                        .param("to", "2026-11-03")
                        .param("mode", "actual"))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString(),
            AnalyticsReport.Report.class);
    assertThat(actual.mode()).isEqualTo("actual");
    assertThat(actual.zone()).isEqualTo("Europe/Moscow");
    assertThat(actual.today()).isEqualTo("2026-11-04");
    var people = actual.visitors();
    assertThat(people.total()).isEqualTo(3);
    assertThat(people.fresh()).isEqualTo(3);
    assertThat(people.returning()).isZero();
    assertThat(people.callers()).isEqualTo(1);
    assertThat(people.newCallers()).isEqualTo(1);
    assertThat(people.sameDayCallers()).isEqualTo(1);
    assertThat(actual.rates().er()).isEqualTo(1 / 3.0);
    // Четыре строки дня (A — два дня, B и D — по одному) на троих.
    assertThat(actual.rates().activeDays()).isEqualTo(4 / 3.0);
    // Средний день — 2 активных из 3 различных.
    assertThat(actual.rates().stickiness()).isEqualTo(2 / 3.0);
    assertThat(actual.rates().errorsPerVisit()).isEqualTo(2 / 4.0);
    // Входов: create + link; rejoin не считается; отказ — отдельно.
    var calls = actual.calls();
    assertThat(calls.entries()).isEqualTo(2);
    assertThat(calls.created()).isEqualTo(1);
    assertThat(calls.joinFailures()).isEqualTo(1);
    assertThat(actual.rates().joinFailureRate()).isEqualTo(1 / 3.0);
    assertThat(calls.meetings()).isEqualTo(2);
    assertThat(calls.meetingHours()).isEqualTo(6600 / 3600.0);
    assertThat(calls.avgMinutes()).isEqualTo(20.0);
    assertThat(calls.medianMinutes()).isEqualTo(20.0);
    assertThat(calls.longestMinutes()).isEqualTo(30.0);
    // Вторая встреча шла внутри первой — пик две одновременно; самая большая — трое.
    assertThat(calls.peakMeetings()).isEqualTo(2);
    assertThat(calls.largestMeeting()).isEqualTo(3);
    // Шаги воронки вложены: открыли трое, до предвхода дошёл один (A), вошёл он же.
    assertThat(actual.funnel()).isEqualTo(new AnalyticsReport.Funnel(3, 1, 1));
    assertThat(actual.clients())
        .extracting(AnalyticsReport.Share::kind, AnalyticsReport.Share::count)
        .containsExactly(tuple("android", 1L), tuple("desktop", 1L), tuple("web", 1L));
    assertThat(actual.integrations().meetings())
        .extracting(AnalyticsReport.Share::kind, AnalyticsReport.Share::count)
        .containsExactly(tuple("music", 1L));
    assertThat(actual.integrations().meetingsWithAny()).isEqualTo(1);
    assertThat(actual.days())
        .extracting(
            AnalyticsReport.Day::day, AnalyticsReport.Day::visitors, AnalyticsReport.Day::fresh)
        .containsExactly(tuple("2026-11-02", 2L, 2L), tuple("2026-11-03", 2L, 1L));
    assertThat(actual.days().getFirst().meetings()).isEqualTo(2);
    // Удержание АКТУАЛА — от первого дня каждого в периоде: A вернулся на следующий день, B — нет;
    // D пришёл вчера, его D1 ещё не известен. D3 и дальше считать рано.
    var retention = actual.retention();
    assertThat(retention.anchor()).isEqualTo("period");
    assertThat(retention.step()).isEqualTo("day");
    assertThat(retention.cohorts())
        .extracting(
            AnalyticsReport.Cohort::since, AnalyticsReport.Cohort::size, AnalyticsReport.Cohort::d1)
        .containsExactly(tuple("2026-11-02", 2L, 0.5), tuple("2026-11-03", 1L, null));
    assertThat(retention.cohorts().getFirst().d3()).isNull();
    assertThat(retention.total().d1()).isEqualTo(0.5);

    // ЛТВ за первый день: когорта A и B и вся их жизнь — включая второй день A.
    var ltv = report.report(DAY1, DAY1, AnalyticsReport.LTV);
    assertThat(ltv.mode()).isEqualTo("ltv");
    assertThat(ltv.visitors().total()).isEqualTo(2);
    assertThat(ltv.visitors().returning()).isEqualTo(1);
    assertThat(ltv.visitors().callers()).isEqualTo(1);
    assertThat(ltv.rates().er()).isEqualTo(0.5);
    assertThat(ltv.rates().stickiness()).isNull();
    assertThat(ltv.calls().entries()).isEqualTo(2);
    assertThat(ltv.calls().meetings()).isNull();
    assertThat(ltv.calls().peakMeetings()).isNull();
    assertThat(ltv.funnel().opened()).isEqualTo(2);
    assertThat(ltv.clients())
        .extracting(AnalyticsReport.Share::kind, AnalyticsReport.Share::count)
        .containsExactly(tuple("desktop", 1L), tuple("web", 1L));
    // Ряд ЛТВ — от первого дня до сегодня.
    assertThat(ltv.days())
        .extracting(AnalyticsReport.Day::day, AnalyticsReport.Day::visitors)
        .containsExactly(tuple("2026-11-02", 2L), tuple("2026-11-03", 1L), tuple("2026-11-04", 0L));
    assertThat(ltv.days().getFirst().meetings()).isNull();
    assertThat(ltv.retention().anchor()).isEqualTo("first");
    assertThat(ltv.retention().cohorts()).hasSize(1);
    assertThat(ltv.retention().cohorts().getFirst().d1()).isEqualTo(0.5);

    // АКТУАЛ за второй день: A — вернувшийся (пришёл до периода), D — новый.
    var second = report.report(DAY1.plusDays(1), DAY1.plusDays(1), AnalyticsReport.ACTUAL);
    assertThat(second.visitors().total()).isEqualTo(2);
    assertThat(second.visitors().returning()).isEqualTo(1);
    assertThat(second.visitors().callers()).isEqualTo(1);
    assertThat(second.visitors().newCallers()).isZero();
    assertThat(second.calls().meetings()).isZero();

    // В ответе нет ни ключей, ни хэшей профиля.
    var body =
        mvc.perform(
                get("/api/v1/admin/analytics")
                    .header(AdminAccess.HEADER, token)
                    .param("from", "2026-11-02")
                    .param("to", "2026-11-03")
                    .param("mode", "ltv"))
            .andReturn()
            .getResponse()
            .getContentAsString();
    assertThat(body).doesNotContain(hashA).doesNotContain(key(PROFILE_A)).doesNotContain("198.18.");
    mvc.perform(
            get("/api/v1/admin/analytics").param("from", "2026-11-01").param("to", "2026-11-02"))
        .andExpect(status().isUnauthorized());
    mvc.perform(
            get("/api/v1/admin/analytics")
                .header(AdminAccess.HEADER, token)
                .param("from", "2026-11-03")
                .param("to", "2026-11-01"))
        .andExpect(status().isBadRequest());
    mvc.perform(
            get("/api/v1/admin/analytics")
                .header(AdminAccess.HEADER, token)
                .param("from", "ноябрь")
                .param("to", "2026-11-01"))
        .andExpect(status().isBadRequest());
  }

  /** Telegram без профиля — посетитель по ключу актора (уже HMAC номера); клиент — Telegram. */
  @Test
  void aTelegramActorIsAVisitorWithoutAProfile() {
    analytics.entered(
        null, "actor:tg:0123456789abcdef", ClientKind.UNKNOWN.telegram(), "create", true);
    analytics.flush();
    assertThat(
            jdbc.sql("SELECT first_client, first_called_day FROM visitors")
                .query((rs, n) -> rs.getString(1) + " " + rs.getObject(2, LocalDate.class))
                .single())
        .isEqualTo("telegram " + DAY1);
  }

  @Test
  void oldRowsAreForgottenBySweep() {
    analytics.visit(Secrets.hash(PROFILE_A), WEB, "open");
    analytics.flush();
    assertThat(analytics.sweep(now.get())).isZero();
    now.addAndGet(Duration.ofDays(101).toMillis());
    assertThat(analytics.sweep(now.get())).isEqualTo(2);
    assertThat(jdbc.sql("SELECT COUNT(*) FROM visitors").query(Long.class).single()).isZero();
  }

  /**
   * Сбой базы не теряет события: не записанное возвращается в буфер и ложится следующим проходом.
   */
  @Test
  void aFailedWriteIsRetriedOnTheNextPass() {
    analytics.visit(Secrets.hash(PROFILE_A), WEB, "open");
    jdbc.sql("ALTER TABLE visitor_days RENAME TO visitor_days_away").update();
    try {
      assertThat(analytics.flush()).isZero();
    } finally {
      jdbc.sql("ALTER TABLE visitor_days_away RENAME TO visitor_days").update();
    }
    analytics.visit(Secrets.hash(PROFILE_A), WEB, "open");
    assertThat(analytics.flush()).isEqualTo(1);
    assertThat(
            jdbc.sql("SELECT visits FROM visitor_days WHERE visitor_key=?")
                .param(key(PROFILE_A))
                .query(Integer.class)
                .single())
        .isEqualTo(2);
  }

  @Test
  void clientKindIsAWordFromTheHeaderOrTheAgent() {
    assertThat(ClientKind.of("telegram", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)"))
        .isEqualTo(new ClientKind("telegram", "ios"));
    assertThat(ClientKind.of(null, "Cord/1.2 Chrome/140 Electron/38 (Windows NT 10.0)"))
        .isEqualTo(new ClientKind("desktop", "windows"));
    // Браузер телефона — веб; приложение Android называет себя заголовком.
    assertThat(ClientKind.of("fridge", "Mozilla/5.0 (Linux; Android 15) Chrome/140"))
        .isEqualTo(new ClientKind("web", "android"));
    assertThat(ClientKind.of("android", "Mozilla/5.0 (Linux; Android 15; wv)"))
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
