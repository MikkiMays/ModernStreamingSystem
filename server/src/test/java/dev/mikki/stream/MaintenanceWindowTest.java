package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

import dev.mikki.stream.activity.Audit;
import dev.mikki.stream.api.ApiController;
import dev.mikki.stream.attachment.TusGateway;
import dev.mikki.stream.config.MaintenanceProperties;
import dev.mikki.stream.media.MediaGateway;
import dev.mikki.stream.room.Contracts.*;
import dev.mikki.stream.room.Lifecycle;
import dev.mikki.stream.room.Maintenance;
import dev.mikki.stream.room.MaintenanceWindows;
import dev.mikki.stream.room.RoomObserver;
import dev.mikki.stream.room.RoomRepository;
import dev.mikki.stream.room.RoomService;
import dev.mikki.stream.room.RoomState;
import dev.mikki.stream.shared.Problem;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Технические работы (R194): окно в Postgres, его фазы, конец всех встреч в начале окна, закрытые
 * двери на время окна, автоматический выход и переживание перезапуска ядра.
 *
 * <p>Часы подставные: момент начала и конца окна двигает тест. Проход сроков ({@code
 * Lifecycle.sweepRoom}) тест зовёт сам — расписание в тестах выключено.
 */
@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:maintenance;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.event-history-limit=10",
      "stream.files-root=./.local/test-uploads",
      "stream.max-rooms=200"
    })
@ActiveProfiles("local")
class MaintenanceWindowTest {
  private static final long SECOND = 1000;
  private static final long MINUTE = 60 * SECOND;
  private static final long HOUR = 60 * MINUTE;

  @Autowired RoomService rooms;
  @Autowired RoomRepository repository;
  @Autowired Lifecycle lifecycle;
  @Autowired ApiController api;
  @Autowired Maintenance maintenance;
  @Autowired MaintenanceWindows windows;
  @Autowired MaintenanceProperties properties;
  @Autowired Audit audit;
  @Autowired JdbcClient jdbc;
  @Autowired PlatformTransactionManager transactions;
  @Autowired List<RoomObserver> observers;
  @MockitoBean MediaGateway gateway;
  @MockitoBean TusGateway tus;
  @MockitoBean Clock clock;
  final AtomicLong now = new AtomicLong(Instant.parse("2026-11-10T00:00:00Z").toEpochMilli());

  @BeforeEach
  void setUp() {
    clean();
    when(clock.millis()).thenAnswer(_ -> now.get());
    when(tus.terminate(anyString())).thenReturn(true);
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

  private Admission host() {
    return rooms.create(new Create(UUID.randomUUID(), "Встреча", "Организатор", false));
  }

  private Admission guest(Admission host) {
    return rooms.join(
        host.roomId(), new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"));
  }

  private String at(long millis) {
    return Instant.ofEpochMilli(millis).toString();
  }

  private void assertRefused(org.assertj.core.api.ThrowableAssert.ThrowingCallable door) {
    assertThatThrownBy(door)
        .isInstanceOfSatisfying(
            Problem.class,
            p -> {
              assertThat(p.status()).isEqualTo(503);
              assertThat(p.code()).isEqualTo("MAINTENANCE_WINDOW");
              assertThat(p.properties()).containsKey("retryAfter");
            });
  }

  /** Срочные работы: новых встреч нет сразу, идущие живут отсрочку, потом кончаются для всех. */
  @Test
  void emergencyRefusesNewMeetingsAtOnceAndEndsLiveOnesAfterTheGrace() {
    var live = host();
    var window = windows.emergency(null, null, null);
    assertThat(window.startsAt()).isEqualTo(now.get() + properties.grace().toMillis());
    assertThat(window.phase(now.get())).isEqualTo(MaintenanceWindows.Phase.GRACE);

    // Отсрочка: создать нельзя (дренажный отказ, главная его уже умеет), войти в идущую — можно.
    assertThatThrownBy(this::host)
        .isInstanceOfSatisfying(Problem.class, p -> assertThat(p.code()).isEqualTo("MAINTENANCE"));
    assertThat(guest(live).roomId()).isEqualTo(live.roomId());
    lifecycle.sweepRoom(live.roomId());
    assertThat(rooms.read(live.roomId()).closedAt).isNull();
    var during = api.capabilities();
    assertThat(during.admissionOpen()).isFalse();
    assertThat(during.maintenance()).isTrue();
    assertThat(during.maintenanceWindow().phase()).isEqualTo("grace");

    now.addAndGet(properties.grace().toMillis());
    lifecycle.sweepRoom(live.roomId());
    var closed = rooms.read(live.roomId());
    assertThat(closed.closedAt).isEqualTo(now.get());
    assertThat(rooms.snapshot(closed).endReason()).isEqualTo("maintenance");
    assertThat(closed.members.values()).noneMatch(RoomState.Member::occupiesSeat);
    assertThat(api.capabilities().maintenanceWindow().phase()).isEqualTo("active");
    // Тем же путём, что «Завершить для всех»: комната SFU распускается после фиксации.
    verify(gateway, timeout(5000)).close(any(), eq(live.roomId()));
  }

  @Test
  void emergencyWithoutGraceEndsMeetingsAtTheNextPass() {
    var live = host();
    var window = windows.emergency(0, null, null);
    assertThat(window.phase(now.get())).isEqualTo(MaintenanceWindows.Phase.ACTIVE);
    lifecycle.sweepRoom(live.roomId());
    assertThat(rooms.snapshot(rooms.read(live.roomId())).endReason()).isEqualTo("maintenance");
  }

  /** Заранее: до начала продукт живёт как обычно, окно — только данные. */
  @Test
  void scheduledWindowChangesNothingBeforeItStarts() {
    var live = host();
    var startsAt = now.get() + 4 * HOUR;
    var window = windows.schedule(at(startsAt), at(startsAt + HOUR), "обновление");
    assertThat(window.phase(now.get())).isEqualTo(MaintenanceWindows.Phase.SCHEDULED);

    var before = api.capabilities();
    assertThat(before.admissionOpen()).isTrue();
    assertThat(before.maintenance()).isFalse();
    assertThat(before.maintenanceWindow().phase()).isEqualTo("scheduled");
    assertThat(before.maintenanceWindow().startsAt()).isEqualTo(startsAt);
    assertThat(before.maintenanceWindow().endsAt()).isEqualTo(startsAt + HOUR);
    assertThat(host().roomId()).isNotNull();
    assertThat(guest(live).roomId()).isEqualTo(live.roomId());
    lifecycle.sweepRoom(live.roomId());
    assertThat(rooms.read(live.roomId()).closedAt).isNull();

    now.set(startsAt);
    lifecycle.sweepRoom(live.roomId());
    assertThat(rooms.snapshot(rooms.read(live.roomId())).endReason()).isEqualTo("maintenance");
    assertThat(api.capabilities().admissionOpen()).isFalse();
  }

  /** Окно идёт: ни одна дверь во встречу не открыта, и каждая отвечает одним кодом. */
  @Test
  void everyDoorIsClosedDuringTheWindow() {
    var live = host();
    var invite = live.inviteUrl().split("invite=")[1];
    var saved = guest(live);
    var code = live.snapshot().code();
    windows.emergency(0, null, null);

    assertRefused(this::host);
    assertRefused(() -> rooms.join(live.roomId(), new Join(UUID.randomUUID(), invite, "Гость")));
    assertRefused(() -> rooms.joinCode(new JoinCode(UUID.randomUUID(), code, "Гость")));
    assertRefused(
        () ->
            rooms.rejoin(
                live.roomId(), live.credential(), new Rejoin(UUID.randomUUID(), "Организатор")));
    assertRefused(
        () ->
            rooms.joinSaved(
                live.roomId(), saved.participantId(), new Rejoin(UUID.randomUUID(), "Гость")));
    assertRefused(() -> rooms.serviceInvite(live.roomId()));
  }

  /** Встреча из избранного: работы не запрещают её открыть после окна, как запрет владельца. */
  @Test
  void savedMeetingReopensAfterTheWindowWithoutAnEndReason() {
    var live = host();
    windows.emergency(0, null, null);
    lifecycle.sweepRoom(live.roomId());

    var closed = windows.finish();
    assertThat(closed.how()).isEqualTo("finished");
    assertThat(api.capabilities().maintenanceWindow()).isNull();
    assertThat(api.capabilities().admissionOpen()).isTrue();

    var back =
        rooms.joinSaved(
            live.roomId(), live.participantId(), new Rejoin(UUID.randomUUID(), "Организатор"));
    assertThat(back.snapshot().closedAt()).isNull();
    assertThat(back.snapshot().endReason()).isNull();
  }

  /** Встречу без избранного уборка не уносит сразу: люди должны успеть прочитать причину конца. */
  @Test
  void endedMeetingStaysReadableSoClientsLearnTheReason() {
    var live = host();
    windows.emergency(0, null, null);
    lifecycle.sweepRoom(live.roomId());
    now.addAndGet(30 * SECOND);
    lifecycle.sweepRoom(live.roomId());
    assertThat(rooms.snapshot(rooms.read(live.roomId())).endReason()).isEqualTo("maintenance");

    now.addAndGet(HOUR);
    lifecycle.sweepRoom(live.roomId());
    assertThatThrownBy(() -> rooms.read(live.roomId())).isInstanceOf(Problem.class);
  }

  @Test
  void cancelledWindowNeverEndsAnything() {
    var live = host();
    var startsAt = now.get() + MINUTE;
    windows.schedule(at(startsAt), null, null);
    var closed = windows.finish();
    assertThat(closed.how()).isEqualTo("cancelled");

    now.set(startsAt + SECOND);
    lifecycle.sweepRoom(live.roomId());
    assertThat(rooms.read(live.roomId()).closedAt).isNull();
    assertThat(api.capabilities().maintenanceWindow()).isNull();
  }

  /** Закрывать нечего — не ошибка: скрипт выкатки зовёт «конец» и в ловушке выхода. */
  @Test
  void finishWithoutWindowIsNotAnError() {
    var closed = windows.finish();
    assertThat(closed.how()).isNull();
    assertThat(closed.window()).isNull();
  }

  /** Новый экземпляр ядра (перезапуск, второй узел) видит то же окно: оно в базе, не в памяти. */
  @Test
  void windowSurvivesCoreRestartAndIsSharedBetweenNodes() {
    var startsAt = now.get() + HOUR;
    var scheduled = windows.schedule(at(startsAt), at(startsAt + HOUR), null);

    var restarted = node();
    assertThat(restarted.current()).contains(scheduled);
    now.set(startsAt);
    assertThat(restarted.active()).isTrue();
    assertThat(windows.active()).isTrue();
    assertRefused(this::host);

    // Конец на одном узле другой видит со следующего чтения базы.
    restarted.finish();
    windows.tick();
    assertThat(windows.active()).isFalse();
    assertThat(host().roomId()).isNotNull();
  }

  /** Переход окна пишется один раз, сколько бы узлов его ни заметили. */
  @Test
  void transitionsAreAuditedOnceAcrossNodes() {
    windows.emergency(0, at(now.get() + HOUR), null);
    var other = node();
    windows.tick();
    other.tick();
    windows.tick();
    assertThat(actions("maintenance.started")).isEqualTo(1);
    // Срок выхода: конец по плану и запас на опоздание.
    now.addAndGet(HOUR + properties.overrun().toMillis());
    other.tick();
    windows.tick();
    assertThat(actions("maintenance.expired")).isEqualTo(1);
  }

  /** Забытое окно не закрывает продукт навсегда: конец по плану плюс запас на опоздание. */
  @Test
  void forgottenWindowOpensTheProductByItselfAfterTheOverrun() {
    var startsAt = now.get() + HOUR;
    var window = windows.schedule(at(startsAt), at(startsAt + HOUR), null);
    assertThat(window.expiresAt()).isEqualTo(startsAt + HOUR + properties.overrun().toMillis());

    now.set(window.expiresAt() - 1);
    assertThat(windows.active()).isTrue();
    now.set(window.expiresAt());
    // Без прохода и без записи в базу: срок проверяет само чтение.
    assertThat(windows.active()).isFalse();
    assertThat(windows.current()).isEmpty();
    assertThat(host().roomId()).isNotNull();
  }

  @Test
  void windowWithoutEndExpiresAfterTheLongestWindow() {
    var window = windows.emergency(0, null, null);
    assertThat(window.expiresAt()).isEqualTo(now.get() + properties.maxWindow().toMillis());
    now.set(window.expiresAt());
    assertThat(windows.active()).isFalse();
  }

  /** Опоздание с окончанием: новый конец отодвигает и автоматический выход. */
  @Test
  void extendMovesTheEstimateAndTheAutomaticExit() {
    var window = windows.emergency(0, at(now.get() + HOUR), null);
    var later = now.get() + 2 * HOUR;
    var extended = windows.extend(at(later));
    assertThat(extended.endsAt()).isEqualTo(later);
    assertThat(extended.expiresAt()).isGreaterThan(window.expiresAt());
    assertThat(extended.expiresAt()).isEqualTo(later + properties.overrun().toMillis());
    assertThat(extended.startsAt()).isEqualTo(window.startsAt());
  }

  @Test
  void extendWithoutWindowIsRefused() {
    assertThatThrownBy(() -> windows.extend(at(now.get() + HOUR)))
        .isInstanceOfSatisfying(
            Problem.class, p -> assertThat(p.code()).isEqualTo("MAINTENANCE_WINDOW_NONE"));
  }

  @Test
  void secondWindowIsRefusedUntilTheFirstIsClosed() {
    windows.schedule(at(now.get() + HOUR), null, null);
    assertThatThrownBy(() -> windows.emergency(0, null, null))
        .isInstanceOfSatisfying(
            Problem.class,
            p -> {
              assertThat(p.status()).isEqualTo(409);
              assertThat(p.code()).isEqualTo("MAINTENANCE_WINDOW_EXISTS");
            });
    windows.finish();
    assertThat(windows.emergency(0, null, null).phase(now.get()))
        .isEqualTo(MaintenanceWindows.Phase.ACTIVE);
  }

  /** Истёкшая, но ещё не убранная проходом строка новому окну не мешает. */
  @Test
  void expiredWindowDoesNotBlockTheNextOne() {
    var first = windows.emergency(0, null, null);
    now.set(first.expiresAt());
    var next = windows.emergency(0, null, null);
    assertThat(windows.current()).contains(next);
    assertThat(
            jdbc.sql("SELECT closed_how FROM maintenance_windows WHERE id=?")
                .param(first.id())
                .query(String.class)
                .single())
        .isEqualTo("expired");
  }

  @Test
  void impossibleTimesAreRefused() {
    var invalid = "MAINTENANCE_WINDOW_INVALID";
    var hour = now.get() + HOUR;
    for (org.assertj.core.api.ThrowableAssert.ThrowingCallable call :
        List.<org.assertj.core.api.ThrowableAssert.ThrowingCallable>of(
            // Начало в прошлом и конец раньше начала.
            () -> windows.schedule(at(now.get() - SECOND), null, null),
            () -> windows.schedule(at(hour), at(hour - SECOND), null),
            // Без смещения: «четыре утра» где — непонятно, а владелец думает по Москве.
            () -> windows.schedule("2026-11-10T04:00:00", null, null),
            () -> windows.schedule("завтра", null, null),
            // Длиннее самого долгого окна.
            () ->
                windows.schedule(at(hour), at(hour + properties.maxWindow().toMillis() + 1), null),
            () -> windows.emergency(0, at(now.get() - SECOND), null)))
      assertThatThrownBy(call)
          .isInstanceOfSatisfying(Problem.class, p -> assertThat(p.code()).isEqualTo(invalid));
  }

  /** Владелец думает по Москве: смещение учтено, хранится UTC. */
  @Test
  void timesWithOffsetAreStoredInUtc() {
    var window = windows.schedule("2026-11-10T04:00:00+03:00", "2026-11-10T05:00:00+03:00", null);
    assertThat(window.startsAt()).isEqualTo(Instant.parse("2026-11-10T01:00:00Z").toEpochMilli());
    assertThat(window.endsAt()).isEqualTo(Instant.parse("2026-11-10T02:00:00Z").toEpochMilli());
    assertThat(
            jdbc.sql("SELECT starts_at FROM maintenance_windows WHERE id=?")
                .param(window.id())
                .query(Long.class)
                .single())
        .isEqualTo(window.startsAt());
  }

  /**
   * Предупреждение: за {@code warn-before} до начала встречам уходит событие (данные готовы, никто
   * их пока не показывает). Один раз на окно; отмена окна — ещё одно событие.
   */
  @Test
  void liveMeetingsAreWarnedOnceAndToldWhenTheWindowIsCancelled() {
    var live = host();
    var startsAt = now.get() + properties.warnBefore().toMillis() + MINUTE;
    windows.schedule(at(startsAt), null, null);
    lifecycle.sweepRoom(live.roomId());
    assertThat(warnings(live.roomId())).isZero();

    now.set(startsAt - properties.warnBefore().toMillis());
    lifecycle.sweepRoom(live.roomId());
    lifecycle.sweepRoom(live.roomId());
    assertThat(warnings(live.roomId())).isEqualTo(1);

    windows.finish();
    lifecycle.sweepRoom(live.roomId());
    lifecycle.sweepRoom(live.roomId());
    assertThat(warnings(live.roomId())).isEqualTo(2);
    assertThat(rooms.read(live.roomId()).closedAt).isNull();
  }

  /** Первое чтение не удалось — окна для этого узла пока нет, но возможности отвечают. */
  @Test
  void databaseFailureDoesNotBreakCapabilities() {
    windows.emergency(0, null, null);
    var broken = mock(JdbcClient.class);
    when(broken.sql(anyString()))
        .thenThrow(new org.springframework.dao.DataAccessResourceFailureException("нет базы"));
    var node = node(broken);
    assertThat(node.active()).isFalse();
    assertThat(node.notice()).isNull();
    assertThatCode(node::tick).doesNotThrowAnyException();
  }

  /** База пропала посреди окна: узел помнит, что окно идёт, и двери остаются закрыты. */
  @Test
  void databaseFailureKeepsTheLastKnownWindow() throws Exception {
    windows.emergency(0, null, null);
    var flaky = spy(jdbc);
    var node = node(flaky);
    assertThat(node.active()).isTrue();

    doThrow(new org.springframework.dao.DataAccessResourceFailureException("нет базы"))
        .when(flaky)
        .sql(anyString());
    // Старше срока свежести — идёт в базу, та отказывает.
    Thread.sleep(1100);
    assertThat(node.active()).isTrue();
    assertThat(node.notice().phase()).isEqualTo("active");
  }

  /** Встречи закрыты окном — метрики и журнал видят причину. */
  @Test
  void closedMeetingIsAuditedWithTheReason() {
    var live = host();
    windows.emergency(0, null, null);
    lifecycle.sweepRoom(live.roomId());
    var closed =
        audit
            .query(
                new Audit.Filter(null, null, "room", null, null, null, live.roomId(), null, null))
            .items()
            .stream()
            .filter(e -> e.action().equals("room.closed"))
            .findFirst()
            .orElseThrow();
    assertThat(closed.details()).containsEntry("reason", "maintenance");
    assertThat(closed.actorKind()).isEqualTo("system");
  }

  /** Дренаж выкатки — отдельный рычаг: окно его не трогает, и он окна не включает. */
  @Test
  void drainFlagAndWindowStayIndependent() {
    maintenance.set(true);
    assertThat(maintenance.draining()).isTrue();
    assertThat(windows.current()).isEmpty();
    assertThat(api.capabilities().maintenanceWindow()).isNull();
    assertThatThrownBy(this::host)
        .isInstanceOfSatisfying(Problem.class, p -> assertThat(p.code()).isEqualTo("MAINTENANCE"));
    maintenance.set(false);

    windows.emergency(0, null, null);
    assertThat(maintenance.draining()).isFalse();
    assertThat(maintenance.on()).isTrue();
  }

  private MaintenanceWindows node() {
    return node(jdbc);
  }

  private MaintenanceWindows node(JdbcClient client) {
    return new MaintenanceWindows(
        client,
        repository,
        clock,
        new TransactionTemplate(transactions),
        properties,
        observers,
        new SimpleMeterRegistry());
  }

  private long actions(String action) {
    return jdbc.sql("SELECT COUNT(*) FROM audit_events WHERE action=?")
        .param(action)
        .query(Long.class)
        .single();
  }

  private long warnings(String roomId) {
    return jdbc.sql(
            "SELECT COUNT(*) FROM room_events WHERE room_id=? AND body LIKE"
                + " '%\"maintenance.warning\"%'")
        .param(roomId)
        .query(Long.class)
        .single();
  }
}
