package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import dev.mikki.stream.activity.ActivityRollup;
import dev.mikki.stream.activity.Audit;
import dev.mikki.stream.activity.Participants;
import dev.mikki.stream.api.ApiController;
import dev.mikki.stream.attachment.AttachmentService;
import dev.mikki.stream.attachment.TusGateway;
import dev.mikki.stream.board.BoardRoom;
import dev.mikki.stream.board.BoardRooms;
import dev.mikki.stream.board.BoardStore;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.game.DurakSummary;
import dev.mikki.stream.game.GameSummary;
import dev.mikki.stream.media.MediaGateway;
import dev.mikki.stream.room.*;
import dev.mikki.stream.room.Contracts.*;
import dev.mikki.stream.shared.Json;
import dev.mikki.stream.support.SupportService;
import io.micrometer.core.instrument.MeterRegistry;
import java.nio.file.Files;
import java.time.Clock;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/**
 * Хранение данных (Р-134, {@code docs/architecture/data-retention.md}): содержимое старше суток не
 * переживает очистку — по таблице на тест (сообщения, события, вложения с файлами на диске, сцена и
 * картинки доски, содержимое снимка комнаты, текст обращений), — а метаданные (журнал участников с
 * полным адресом, аудит) живут год.
 *
 * <p>Контекст — тот же, что у {@link RoomServiceTest} и {@link ActivityTest}: Spring поднимает его
 * один раз.
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
class RetentionTest {
  static final long HOUR = 3_600_000L;
  static final long DAY = 24 * HOUR;

  @Autowired RoomService rooms;
  @Autowired RoomRepository repository;
  @Autowired Lifecycle lifecycle;
  @Autowired Retention retention;
  @Autowired RetentionMeter meter;
  @Autowired AttachmentService attachments;
  @Autowired FavoriteService favorites;
  @Autowired BoardStore boardStore;
  @Autowired BoardRooms boards;
  @Autowired SupportService support;
  @Autowired ActivityRollup rollup;
  @Autowired Participants participants;
  @Autowired ApiController api;
  @Autowired Audit audit;
  @Autowired JdbcClient jdbc;
  @Autowired StreamProperties config;
  @Autowired MeterRegistry registry;
  @MockitoBean MediaGateway gateway;
  @MockitoBean TusGateway tus;
  @MockitoBean Clock clock;
  AtomicLong now = new AtomicLong(System.currentTimeMillis());

  @BeforeEach
  void setUp() {
    // Буфер журнала участников общий на контекст: входы соседних тестов — в базу и прочь.
    participants.flush();
    jdbc.sql("DELETE FROM command_receipts").update();
    jdbc.sql("DELETE FROM rooms").update();
    jdbc.sql("DELETE FROM meeting_participants").update();
    jdbc.sql("DELETE FROM audit_events").update();
    jdbc.sql("DELETE FROM support_notes").update();
    jdbc.sql("DELETE FROM support_tickets").update();
    when(clock.millis()).thenAnswer(_ -> now.get());
    when(tus.terminate(anyString())).thenReturn(true);
  }

  Admission host() {
    return rooms.create(new Create(UUID.randomUUID(), "Совет директоров", "Организатор", false));
  }

  Ack command(Admission who, String type, String text) {
    return rooms.command(
        who.roomId(), who.credential(), new Command(UUID.randomUUID(), type, text, null, 0));
  }

  long count(String sql, Object... params) {
    return jdbc.sql(sql).params(params).query(Long.class).single();
  }

  // Потолок --------------------------------------------------------------------------------------

  /** Сутки — потолок: ни содержимое, ни сроки под ним дольше не ставятся (сервер не поднимется). */
  @Test
  void contentCannotBeKeptLongerThanADayWhateverTheSettings() {
    var keep = config.retention();
    assertThat(keep.content()).isEqualTo(Duration.ofHours(24));
    assertThat(keep.metadata()).isEqualTo(Duration.ofDays(365));
    assertThat(keep.audit()).isEqualTo(keep.metadata());
    assertThat(keep.meetingStats()).isEqualTo(keep.metadata());
    assertThat(config.isContentCeilingValid()).isTrue();
    for (var raised :
        List.of(
            with(keep, Duration.ofDays(2), keep.messages(), keep.closedHistory()),
            with(keep, keep.content(), Duration.ofDays(2), keep.closedHistory()),
            with(keep, keep.content(), keep.messages(), Duration.ofHours(25)))) {
      var settings = spy(config);
      doReturn(raised).when(settings).retention();
      assertThat(settings.isContentCeilingValid()).as(raised.toString()).isFalse();
    }
  }

  static StreamProperties.Retention with(
      StreamProperties.Retention keep, Duration content, Duration messages, Duration history) {
    return new StreamProperties.Retention(
        keep.savedRoom(),
        keep.unsavedRoom(),
        history,
        messages,
        keep.audit(),
        keep.meetingStats(),
        keep.activityDaily(),
        content,
        keep.metadata());
  }

  // Содержимое -----------------------------------------------------------------------------------

  /** Сообщения и события встречи старше суток уходят секундным проходом. */
  @Test
  void chatMessagesAndRoomEventsOlderThanADayDoNotSurvive() {
    var host = host();
    command(host, "message.send", "Квартальный отчёт в приложении");
    assertThat(count("SELECT COUNT(*) FROM messages WHERE room_id=?", host.roomId())).isEqualTo(1);
    assertThat(count("SELECT COUNT(*) FROM room_events WHERE room_id=?", host.roomId()))
        .isPositive();
    double before = meter.deleted("message");
    now.addAndGet(DAY + 1);
    lifecycle.sweepLedger();
    assertThat(count("SELECT COUNT(*) FROM messages WHERE room_id=?", host.roomId())).isZero();
    assertThat(count("SELECT COUNT(*) FROM room_events WHERE room_id=?", host.roomId())).isZero();
    assertThat(meter.deleted("message")).isGreaterThan(before);
    assertThat(registry.find("cord.retention.deleted").tag("kind", "message").counter())
        .isNotNull();
  }

  /** Вложение старше суток уходит вместе с файлом и его описанием tusd на томе {@code uploads}. */
  @Test
  void attachmentsOlderThanADayLeaveTheDiskTogetherWithTheirRow() throws Exception {
    var host = host();
    var file =
        attachments.reserve(
            host.roomId(),
            host.credential(),
            new AttachmentService.Reserve(UUID.randomUUID(), "отчёт.txt", 4));
    attachments.begin(file.id(), host.credential(), 4);
    var path = attachments.path(file.id());
    Files.createDirectories(path.getParent());
    Files.writeString(path, "test");
    Files.writeString(path.resolveSibling(file.id() + ".info"), "{}");
    attachments.complete(file.id(), 4);
    now.addAndGet(DAY - HOUR);
    attachments.sweep();
    assertThat(Files.exists(path)).isTrue();
    now.addAndGet(HOUR + 1);
    attachments.sweep();
    assertThat(Files.exists(path)).isFalse();
    assertThat(Files.exists(path.resolveSibling(file.id() + ".info"))).isFalse();
    assertThat(count("SELECT COUNT(*) FROM attachments WHERE id=?", file.id())).isZero();
  }

  static byte[] png() {
    return new byte[] {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10, 0, 0, 0, 0};
  }

  /**
   * Доска (R221, R222): каждый элемент — не дольше суток от добавления или правки, картинка — от
   * загрузки вместе с элементами, что на неё ссылаются. И у сохранённой встречи: она остаётся, но
   * доска приходит пустой.
   */
  @Test
  void boardElementsAndImagesOlderThanADayLeaveEvenASavedMeeting() {
    var host = host();
    var id = host.roomId();
    favorites.save("B".repeat(43), id, host.credential());
    long start = now.get();
    var old =
        "[{\"id\":\"old\",\"type\":\"rectangle\",\"version\":1,\"versionNonce\":1},"
            + "{\"id\":\"pic\",\"type\":\"image\",\"version\":1,\"versionNonce\":1,\"fileId\":\"f1\"}]";
    assertThat(boardStore.save(id, 0, 2, old, start, start)).isTrue();
    assertThat(boardStore.putFile(id, "f1", "image/png", png(), start)).isTrue();
    now.addAndGet(20 * HOUR);
    var hub = boards.hub(id);
    hub.room()
        .apply(
            Json.tree(
                "[{\"id\":\"fresh\",\"type\":\"rectangle\",\"version\":1,\"versionNonce\":1}]"),
            "anna");
    boards.save(hub);
    command(host, "close", null);
    long epoch = hub.room().epoch();

    now.set(start + DAY + HOUR);
    double elementsBefore = meter.deleted("board_element");
    retention.sweep();
    assertThat(repository.get(id, false).title).isEqualTo("Совет директоров");
    var saved = boardStore.load(id).orElseThrow();
    assertThat(saved.elements()).contains("\"fresh\"").doesNotContain("\"old\"", "\"pic\"");
    assertThat(saved.epoch()).isEqualTo(epoch + 1);
    assertThat(boardStore.files(id)).isEmpty();
    assertThat(boardStore.file(id, "f1")).isEmpty();
    assertThat(meter.deleted("board_element") - elementsBefore).isGreaterThanOrEqualTo(2);
    assertThat(meter.oldest("board_file")).isLessThanOrEqualTo(DAY / 1000);

    now.set(start + 20 * HOUR + DAY + HOUR);
    retention.sweep();
    assertThat(Json.tree(boardStore.load(id).orElseThrow().elements())).isEmpty();
    assertThat(meter.oldest("board_element")).isZero();
    assertThat(repository.get(id, false).id).isEqualTo(id);
  }

  /** Доска, которой нет в памяти, проверяется по базе и уходит из неё той же очисткой. */
  @Test
  void aBoardNobodyHasOpenedSinceIsSweptFromTheDatabase() {
    var host = host();
    var id = host.roomId();
    long start = now.get();
    boardStore.save(
        id,
        3,
        9,
        "[{\"id\":\"a\",\"type\":\"rectangle\",\"version\":2,\"versionNonce\":5}]",
        start,
        start);
    boards.existing(id).ifPresent(hub -> fail("доска не должна быть в памяти"));
    now.set(start + DAY + 1);
    retention.sweep();
    var saved = boardStore.load(id).orElseThrow();
    assertThat(Json.tree(saved.elements())).isEmpty();
    assertThat(saved.epoch()).isEqualTo(4);
    assertThat(
            count(
                "SELECT COUNT(*) FROM room_boards WHERE room_id=? AND (content_at IS NULL OR"
                    + " content_at<=?)",
                id,
                start))
        .isZero();
  }

  /**
   * Снимок комнаты: итоги игр старше суток, картинка профиля ушедшего и — страховкой при снятом
   * потолке длительности — кино встречи, открытой больше суток назад.
   */
  @Test
  void roomStateContentOlderThanADayIsDropped() {
    var host = host();
    var id = host.roomId();
    var guest =
        rooms.join(id, new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"));
    rooms.command(
        id,
        host.credential(),
        new Command(
            UUID.randomUUID(), "watch.open", null, null, 0, "youtube", "video", "abc", null));
    assertThat(rooms.read(id).watch).isNotNull();
    command(guest, "leave", null);
    long start = now.get();
    var room = repository.get(id, false);
    room.members.get(guest.participantId()).avatar = "data:image/png;base64,iVBORw0KGgo=";
    room.pokerGames =
        new ArrayList<>(
            List.of(
                Json.read("{\"id\":\"old\",\"finishedAt\":" + start + "}", GameSummary.class),
                Json.read(
                    "{\"id\":\"new\",\"finishedAt\":" + (start + 23 * HOUR) + "}",
                    GameSummary.class)));
    room.durakGames =
        new ArrayList<>(
            List.of(Json.read("{\"id\":\"d\",\"finishedAt\":" + start + "}", DurakSummary.class)));
    repository.save(room, start);

    now.set(start + DAY + HOUR);
    retention.sweep();
    var after = rooms.read(id);
    assertThat(after.watch).isNull();
    assertThat(after.pokerGames).extracting(GameSummary::id).containsExactly("new");
    assertThat(after.durakGames).isNull();
    assertThat(after.members.get(guest.participantId()).avatar).isNull();
    assertThat(after.members.get(guest.participantId()).name).isEqualTo("Гость");
    assertThat(after.title).isEqualTo("Совет директоров");
  }

  /**
   * Обращение в поддержку: текст — до решения и ещё сутки; потом остаются тема, статус, время,
   * контакт. Открытое держит текст.
   */
  @Test
  void resolvedSupportTextLivesADayAfterTheDecisionAndOpenTicketsKeepIt() {
    var done =
        support.submit(
            new SupportService.Submission(
                "camera",
                "Не работает камера в Chrome",
                "@anna",
                "{\"ua\":\"x\"}",
                true,
                List.of()),
            "198.51.100." + (int) (Math.random() * 250));
    var open =
        support.submit(
            new SupportService.Submission(
                "sound", "Эхо у собеседника", null, null, false, List.of()),
            "198.51.100." + (int) (Math.random() * 250));
    support.addNote(done.id(), "reply", "Попробуйте другой браузер", "owner");
    support.setStatus(done.id(), SupportService.Status.DONE, "owner");
    long resolved = now.get();

    now.set(resolved + DAY - HOUR);
    assertThat(support.forgetResolvedText()).isZero();
    assertThat(support.get(done.id()).ticket().message()).isEqualTo("Не работает камера в Chrome");

    now.set(resolved + DAY + 1);
    assertThat(support.forgetResolvedText()).isEqualTo(1);
    var cleared = support.get(done.id());
    assertThat(cleared.ticket().message()).isNull();
    assertThat(cleared.ticket().diagnostics()).isNull();
    assertThat(cleared.ticket().topic()).isEqualTo("camera");
    assertThat(cleared.ticket().contact()).isEqualTo("@anna");
    assertThat(cleared.ticket().status()).isEqualTo(SupportService.Status.DONE);
    assertThat(cleared.notes()).isNotEmpty().allSatisfy(note -> assertThat(note.text()).isNull());
    assertThat(support.get(open.id()).ticket().message()).isEqualTo("Эхо у собеседника");
    assertThat(support.forgetResolvedText()).isZero();
  }

  // Метаданные -----------------------------------------------------------------------------------

  /**
   * Журнал участников: строка на вход — встреча, название, имя, полный адрес (IPv6 целиком), клиент
   * и система, узел, вход и выход. Пишется буфером после фиксации входа и живёт год.
   */
  @Test
  void theParticipantsJournalKeepsWhoFromWhereAndWhenForAYear() {
    var host = host();
    var http = new MockHttpServletRequest("POST", "/api/v1/rooms/" + host.roomId() + "/join");
    http.setRemoteAddr("2001:db8::7");
    http.addHeader("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0");
    http.addHeader("X-Cord-Client", "web");
    var guest =
        api.join(
            UUID.fromString(host.roomId()),
            new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"),
            http);
    // Вход не ждал журнала: строка пока в буфере, в базе — после прохода.
    assertThat(count("SELECT COUNT(*) FROM meeting_participants")).isZero();
    participants.flush();
    var page =
        participants.query(
            new Participants.Filter(host.roomId(), null, null, null, null, null, null));
    var row = page.items().getFirst();
    assertThat(row.participantId()).isEqualTo(guest.participantId());
    assertThat(row.name()).isEqualTo("Гость");
    assertThat(row.title()).isEqualTo("Совет директоров");
    assertThat(row.roomCode()).isEqualTo(guest.snapshot().code());
    assertThat(row.ip()).isEqualTo("2001:db8:0:0:0:0:0:7");
    assertThat(row.client()).isEqualTo("web");
    assertThat(row.os()).isEqualTo("windows");
    assertThat(row.door()).isEqualTo("link");
    assertThat(row.mediaNode()).isEqualTo(guest.snapshot().mediaNode());
    assertThat(row.joinedAt()).isEqualTo(now.get());
    assertThat(row.leftAt()).isNull();
    // Тот же адрес в журнале аудита — полным.
    assertThat(
            audit
                .query(
                    new Audit.Filter(
                        null, null, "participant", null, null, "2001:db8:0", null, null, null))
                .items())
        .extracting(Audit.Event::ip)
        .containsExactly("2001:db8:0:0:0:0:0:7");

    now.addAndGet(60_000);
    command(guest, "leave", null);
    participants.flush();
    var left =
        participants
            .query(
                new Participants.Filter(
                    null, guest.snapshot().code(), null, null, null, null, null))
            .items()
            .getFirst();
    assertThat(left.leftAt()).isEqualTo(now.get());
    assertThat(
            participants
                .query(new Participants.Filter(null, null, null, null, "2001:db8:", null, null))
                .items())
        .hasSize(1);
    assertThat(
            participants
                .query(
                    new Participants.Filter(
                        null, null, now.get() + 1, now.get() + DAY, null, null, null))
                .items())
        .isEmpty();

    now.addAndGet(364 * DAY);
    rollup.run();
    assertThat(count("SELECT COUNT(*) FROM meeting_participants")).isEqualTo(1);
    now.addAndGet(2 * DAY);
    rollup.run();
    assertThat(count("SELECT COUNT(*) FROM meeting_participants")).isZero();
  }

  /** Встреча кончилась, пока строка входа ещё в буфере, — выход всё равно записан. */
  @Test
  void aMeetingThatEndsClosesEveryOpenRowOfTheJournal() {
    var host = host();
    var http = new MockHttpServletRequest("POST", "/api/v1/rooms/" + host.roomId() + "/join");
    http.setRemoteAddr("203.0.113.9");
    api.join(
        UUID.fromString(host.roomId()),
        new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"),
        http);
    now.addAndGet(5_000);
    command(host, "close", null);
    participants.flush();
    var rows =
        participants
            .query(new Participants.Filter(host.roomId(), null, null, null, null, null, null))
            .items();
    assertThat(rows)
        .singleElement()
        .satisfies(
            row -> {
              assertThat(row.ip()).isEqualTo("203.0.113.9");
              assertThat(row.leftAt()).isEqualTo(now.get());
            });
  }

  /** Журнал аудита — год от события по нынешней настройке, и строки прежних трёх месяцев тоже. */
  @Test
  void theAuditJournalIsKeptForAYearIncludingRowsWrittenUnderTheOldTerm() {
    long start = now.get();
    jdbc.sql(
            "INSERT INTO audit_events(happened_at,expires_at,action,actor_kind)"
                + " VALUES(?,?,'admin.login','admin')")
        .params(start, start + 90 * DAY)
        .update();
    audit.record(Audit.Entry.of("admin.login").actor("admin", null, null).ip("192.0.2.10"));
    now.set(start + 100 * DAY);
    rollup.run();
    assertThat(count("SELECT COUNT(*) FROM audit_events")).isEqualTo(2);
    now.set(start + 366 * DAY);
    rollup.run();
    assertThat(count("SELECT COUNT(*) FROM audit_events")).isZero();
  }

  /** Картинка доски помнит, когда её загрузили: по этому времени у неё срок. */
  @Test
  void boardFilesRememberWhenTheyWereUploaded() {
    var host = host();
    boardStore.putFile(host.roomId(), "f9", "image/png", png(), 12345L);
    assertThat(boardStore.files(host.roomId()))
        .extracting(BoardRoom.FileMeta::createdAt)
        .containsExactly(12345L);
  }
}
