package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import dev.mikki.stream.attachment.AttachmentService;
import dev.mikki.stream.attachment.TusGateway;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.media.*;
import dev.mikki.stream.room.*;
import dev.mikki.stream.room.Contracts.*;
import dev.mikki.stream.shared.Problem;
import java.nio.file.Files;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:rooms;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.event-history-limit=10",
      "stream.files-root=./.local/test-uploads",
      "stream.max-rooms=200"
    })
@ActiveProfiles("local")
class RoomServiceTest {
  @Autowired RoomService rooms;
  @Autowired RoomRepository repository;
  @Autowired MediaService media;
  @Autowired AttachmentService attachments;
  @Autowired Lifecycle lifecycle;
  @Autowired FavoriteService favorites;
  @Autowired StreamProperties config;
  @Autowired JdbcClient jdbc;
  @MockitoBean MediaGateway gateway;
  @MockitoBean TusGateway tus;
  @MockitoBean Clock clock;
  AtomicLong now = new AtomicLong(System.currentTimeMillis());

  @BeforeEach
  void setUp() {
    jdbc.sql("DELETE FROM command_receipts").update();
    jdbc.sql("DELETE FROM rooms").update();
    when(clock.millis()).thenAnswer(_ -> now.get());
    when(tus.terminate(anyString())).thenReturn(true);
  }

  Admission host() {
    return rooms.create(new Create(UUID.randomUUID(), "Тестовая встреча", "Организатор", false));
  }

  Admission guest(Admission host) {
    return rooms.join(
        host.roomId(), new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"));
  }

  Ack command(Admission admission, String type, String target, long generation) {
    return rooms.command(
        admission.roomId(),
        admission.credential(),
        new Command(UUID.randomUUID(), type, null, target, generation));
  }

  void connected(Admission admission) {
    media.observe(
        admission.roomId(), Map.of(admission.participantId(), "PA_first"), now.incrementAndGet());
  }

  @Test
  void olderPublishersAreDiscoveredOnceWithoutReplayingStartOnReconnect() {
    var host = host();
    connected(host);
    var screen = media.screen(host.roomId(), host.credential(), UUID.randomUUID(), true).value();
    media.screenObserved(host.roomId(), host.participantId(), "obsolete-sid");
    assertThat(rooms.read(host.roomId()).members.get(host.participantId()).screenStarted).isFalse();
    media.screenObserved(host.roomId(), host.participantId(), "PA_first");
    var after = rooms.read(host.roomId()).sequence;
    media.screenObserved(host.roomId(), host.participantId(), "PA_first");
    command(host, "screen.started", screen, 0);
    assertThat(
            jdbc.sql(
                    "SELECT COUNT(*) FROM room_events WHERE room_id=? AND sequence>? AND body LIKE '%screen.started%'")
                .params(host.roomId(), after)
                .query(Long.class)
                .single())
        .isZero();
  }

  @Test
  void streamViewsAreValidatedIdempotentAndCleanedUp() throws Exception {
    var host = host();
    var a = guest(host);
    var b = guest(host);
    var screen = media.screen(host.roomId(), host.credential(), UUID.randomUUID(), true).value();
    assertThat(screen).isNotBlank();
    assertThatThrownBy(() -> command(a, "view.open", screen, 0)).isInstanceOf(Problem.class);
    command(host, "screen.started", screen, 0);
    var after = rooms.read(host.roomId()).sequence;
    command(host, "screen.started", screen, 0);
    command(host, "view.open", screen, 0);
    command(host, "view.playing", screen, 0);
    assertThat(rooms.read(host.roomId()).members.get(host.participantId()).firstViewer).isFalse();
    command(a, "view.open", screen, 0);
    command(b, "view.open", screen, 0);
    try (var pool = Executors.newFixedThreadPool(2)) {
      var one = pool.submit(() -> command(a, "view.playing", screen, 0));
      var two = pool.submit(() -> command(b, "view.playing", screen, 0));
      one.get();
      two.get();
    }
    command(a, "view.playing", screen, 0);
    var count =
        jdbc.sql(
                "SELECT COUNT(*) FROM room_events WHERE room_id=? AND sequence>? AND body LIKE '%screen.first_viewer%'")
            .params(host.roomId(), after)
            .query(Long.class)
            .single();
    assertThat(count).isEqualTo(1);
    command(a, "view.close", UUID.randomUUID().toString(), 0);
    assertThat(rooms.read(host.roomId()).members.get(a.participantId()).viewingScreenId)
        .isEqualTo(screen);
    media.screen(host.roomId(), host.credential(), UUID.randomUUID(), false);
    assertThat(rooms.read(host.roomId()).members.values())
        .allSatisfy(m -> assertThat(m.viewingScreenId).isNull());
    assertThatThrownBy(() -> command(a, "view.playing", screen, 0)).isInstanceOf(Problem.class);
    var next = media.screen(host.roomId(), host.credential(), UUID.randomUUID(), true).value();
    assertThat(next).isNotEqualTo(screen);
    command(host, "leave", null, 0);
    assertThat(rooms.read(host.roomId()).members.get(host.participantId()).screenId).isNull();
  }

  private Ack avatar(Admission admission, String value) {
    return rooms.command(
        admission.roomId(),
        admission.credential(),
        new Command(UUID.randomUUID(), "profile.avatar", value, null, 0));
  }

  @Test
  void avatarIsShownToTheRoomOnlyWhenItIsAnImageThisServerAccepted() {
    var host = host();
    var png =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    avatar(host, png);
    assertThat(rooms.snapshot(rooms.read(host.roomId())).participants())
        .anySatisfy(p -> assertThat(p.avatar()).isEqualTo(png));

    // Anything that is not a base64 image data URI never reaches another participant.
    for (var rejected :
        List.of(
            "https://example.com/face.png",
            "data:text/html;base64,PHNjcmlwdD4=",
            "data:image/png;base64,not-base64!!",
            "data:image/svg+xml;base64,PHN2Zy8+",
            "data:image/png;base64," + "A".repeat(4000)))
      assertThatThrownBy(() -> avatar(host, rejected)).isInstanceOf(Problem.class);

    // The picture that was already accepted survives every rejected attempt.
    assertThat(rooms.snapshot(rooms.read(host.roomId())).participants())
        .anySatisfy(p -> assertThat(p.avatar()).isEqualTo(png));

    // Картинка размером ровно в бюджет браузера обязана приниматься. Браузер подбирает размер и
    // качество под 3500 символов data URI; второй, более узкий предел на байты означал здесь
    // «принято у себя, отвергнуто комнатой» — и молча, потому что смотрят на свой экран.
    var full = "data:image/webp;base64," + "A".repeat(3476);
    avatar(host, full);
    assertThat(rooms.snapshot(rooms.read(host.roomId())).participants())
        .anySatisfy(p -> assertThat(p.avatar()).isEqualTo(full));

    avatar(host, "");
    assertThat(rooms.snapshot(rooms.read(host.roomId())).participants())
        .allSatisfy(p -> assertThat(p.avatar()).isNull());
  }

  @Test
  void onlyHostMutesMicrophoneAndRetryDoesNotMuteAgain() {
    var host = host();
    var guest = guest(host);
    var command = new Command(UUID.randomUUID(), "microphone.mute", null, guest.participantId(), 0);
    Runnable rpc = mock(Runnable.class);
    assertThatThrownBy(() -> rooms.muteMicrophone(host.roomId(), guest.credential(), command, rpc))
        .isInstanceOf(Problem.class);
    verifyNoInteractions(rpc);
    rooms.muteMicrophone(host.roomId(), host.credential(), command, rpc);
    rooms.muteMicrophone(host.roomId(), host.credential(), command, rpc);
    verify(rpc, times(1)).run();
  }

  /**
   * Название и режим входа записывались один раз, при создании: опечатку комната несла до конца, а
   * решение «пускать всех» приходилось принимать до того, как стало ясно, кто придёт.
   */
  @Test
  void onlyHostRenamesTheRoomAndChangesWhoMayEnter() {
    var host = rooms.create(new Create(UUID.randomUUID(), "Опечатка", "Организатор", false));
    var guest = guest(host);
    assertThatThrownBy(
            () ->
                rooms.roomSettings(
                    host.roomId(), guest.credential(), new RoomSettings("Чужое название", true)))
        .isInstanceOf(Problem.class);

    var updated =
        rooms.roomSettings(host.roomId(), host.credential(), new RoomSettings("  Вечер  ", true));
    assertThat(updated.title()).isEqualTo("Вечер");
    assertThat(updated.approvalRequired()).isTrue();
    // Остальные узнают об этом из снимка, а не из своей копии: правку объявляет room.changed.
    assertThat(rooms.snapshot(host.roomId(), guest.credential()).title()).isEqualTo("Вечер");

    // Режим входа — не только запись в снимке: следующий гость должен ждать подтверждения.
    var waiting =
        rooms.join(
            host.roomId(),
            new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Поздний"));
    assertThat(
            rooms.snapshot(host.roomId(), host.credential()).participants().stream()
                .filter(p -> p.id().equals(waiting.participantId()))
                .findFirst()
                .orElseThrow()
                .status())
        .isEqualTo(RoomState.Status.WAITING);
  }

  @Test
  void closedRoomKeepsItsNameAndAdmission() {
    var host = host();
    command(host, "close", null, 0);
    assertThatThrownBy(
            () ->
                rooms.roomSettings(
                    host.roomId(), host.credential(), new RoomSettings("Поздно", true)))
        .isInstanceOf(Problem.class);
  }

  @Test
  void onlyHostCanChangeIntegrationPermissionAndItSurvivesReturn() {
    var host = rooms.create(new Create(UUID.randomUUID(), "Комната", "Организатор", false, false));
    assertThat(host.snapshot().integrationsAllowed()).isFalse();
    var guest = guest(host);
    assertThatThrownBy(() -> rooms.integrationSettings(host.roomId(), guest.credential(), true))
        .isInstanceOf(Problem.class);
    assertThat(
            rooms.integrationSettings(host.roomId(), host.credential(), true).integrationsAllowed())
        .isTrue();
    command(host, "leave", null, 0);
    var returned =
        rooms.rejoin(
            host.roomId(), host.credential(), new Rejoin(UUID.randomUUID(), "Организатор"));
    assertThat(returned.snapshot().integrationsAllowed()).isTrue();
  }

  @Test
  void musicServiceIsIdempotentConsumesOneSeatAndHasNoHostRights() {
    var host = host();
    var id = UUID.randomUUID();
    var music = rooms.addMusicService(host.roomId(), id);
    assertThat(rooms.addMusicService(host.roomId(), id)).isEqualTo(music);
    var participant =
        rooms.snapshot(host.roomId(), host.credential()).participants().stream()
            .filter(p -> p.id().equals(music.participantId()))
            .findFirst()
            .orElseThrow();
    assertThat(participant.service()).isEqualTo("music");
    assertThat(participant.owner()).isFalse();
    assertThatThrownBy(() -> command(music, "close", null, 0)).isInstanceOf(Problem.class);
    assertThatThrownBy(() -> rooms.addMusicService(host.roomId(), UUID.randomUUID()))
        .isInstanceOf(Problem.class)
        .extracting("code")
        .isEqualTo("SERVICE_EXISTS");
    for (int i = 0; i < 8; i++) guest(host);
    assertThatThrownBy(() -> guest(host))
        .isInstanceOf(Problem.class)
        .extracting("code")
        .isEqualTo("ROOM_FULL");
    command(music, "leave", null, 0);
    var replacement = rooms.addMusicService(host.roomId(), UUID.randomUUID());
    assertThat(replacement.participantId()).isNotEqualTo(music.participantId());
  }

  @Test
  void admissionIsIdempotentAndDoesNotDuplicateSeats() {
    var request = new Create(UUID.randomUUID(), "Встреча", "Имя", false);
    var first = rooms.create(request);
    var retry = rooms.create(request);
    assertThat(retry).isEqualTo(first);
    assertThat(rooms.read(first.roomId()).members).hasSize(1);
    assertThatThrownBy(
            () -> rooms.create(new Create(request.commandId(), "Другое имя", "Имя", false)))
        .isInstanceOf(Problem.class);
  }

  @Test
  void admissionIsAtomicForTenSeats() throws Exception {
    var host = host();
    try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
      var work = new ArrayList<Future<Boolean>>();
      for (int i = 0; i < 25; i++)
        work.add(
            pool.submit(
                () -> {
                  try {
                    guest(host);
                    return true;
                  } catch (Problem e) {
                    assertThat(e.code()).isEqualTo("ROOM_FULL");
                    return false;
                  }
                }));
      int admitted = 0;
      for (var result : work) if (result.get()) admitted++;
      assertThat(admitted).isEqualTo(9);
      assertThat(rooms.read(host.roomId()).members).hasSize(10);
    }
  }

  @Test
  void numericCodeRequiresApprovalBeforeHistoryAndMediaAccess() {
    var host = rooms.create(new Create(UUID.randomUUID(), "С подтверждением", "Организатор", true));
    assertThat(host.snapshot().code()).matches("[0-9]{9}");
    rooms.command(
        host.roomId(),
        host.credential(),
        new Command(UUID.randomUUID(), "message.send", "Private conversation", null, 0));
    var file =
        attachments.reserve(
            host.roomId(),
            host.credential(),
            new AttachmentService.Reserve(UUID.randomUUID(), "private.txt", 10));
    var request = new JoinCode(UUID.randomUUID(), host.snapshot().code(), "По коду");
    var pending = rooms.joinCode(request);
    assertThat(rooms.joinCode(request)).isEqualTo(pending);
    assertThat(pending.snapshot().participants()).hasSize(1);
    assertThat(pending.snapshot().participants().getFirst().status())
        .isEqualTo(RoomState.Status.WAITING);
    assertThat(rooms.snapshot(host.roomId(), pending.credential()).messages()).isEmpty();
    assertThat(rooms.replay(host.roomId(), pending.credential(), -1).events()).isEmpty();
    assertThat(attachments.list(host.roomId(), pending.credential())).isEmpty();
    assertThatThrownBy(() -> attachments.download(file.id(), pending.credential()))
        .isInstanceOf(Problem.class);
    assertThatThrownBy(() -> media.token(host.roomId(), pending.credential()))
        .isInstanceOf(Problem.class);
    command(host, "participant.approve", pending.participantId(), 0);
    assertThat(rooms.snapshot(host.roomId(), pending.credential()).messages()).hasSize(1);
  }

  /**
   * Правильный номер — это и есть приглашение. Комната, которая никого не просит подождать, не
   * должна держать у двери тех, кто ввёл её код: настройка «По ссылке и коду — сразу» обещает
   * именно это, а вход по коду годами ждал подтверждения вопреки ей.
   */
  @Test
  void numericCodeAdmitsDirectlyWhenTheRoomAsksNobodyToWait() {
    var host = host();
    rooms.command(
        host.roomId(),
        host.credential(),
        new Command(UUID.randomUUID(), "message.send", "Уже сказанное", null, 0));
    var guest =
        rooms.joinCode(new JoinCode(UUID.randomUUID(), host.snapshot().code(), "По коду сразу"));
    assertThat(guest.snapshot().participants()).hasSize(2);
    assertThat(
            guest.snapshot().participants().stream()
                .filter(p -> p.id().equals(guest.participantId()))
                .findFirst()
                .orElseThrow()
                .status())
        .isEqualTo(RoomState.Status.JOINING);
    // Раз войти можно сразу, то и разговор виден сразу: отдельного «допуска» здесь нет.
    assertThat(rooms.snapshot(host.roomId(), guest.credential()).messages()).hasSize(1);
    assertThatCode(() -> media.token(host.roomId(), guest.credential())).doesNotThrowAnyException();
    // Вернувшийся по коду тоже не начинает ждать заново.
    command(guest, "leave", null, 0);
    var again =
        rooms.rejoin(host.roomId(), guest.credential(), new Rejoin(UUID.randomUUID(), "Он же"));
    assertThat(
            again.snapshot().participants().stream()
                .filter(p -> p.id().equals(again.participantId()))
                .findFirst()
                .orElseThrow()
                .status())
        .isEqualTo(RoomState.Status.JOINING);
  }

  @Test
  void explicitReturnKeepsConversationAndHostRightsButFencesOldSessions() {
    var host = host();
    var oldRoom = rooms.read(host.roomId());
    var oldToken =
        new MediaGateway(config).token(oldRoom, oldRoom.members.get(host.participantId())).token();
    rooms.command(
        host.roomId(),
        host.credential(),
        new Command(UUID.randomUUID(), "message.send", "Продолжим", null, 0));
    command(host, "leave", null, 0);
    var request = new Rejoin(UUID.randomUUID(), "Вернувшийся организатор");
    var returned = rooms.rejoin(host.roomId(), host.credential(), request);
    assertThat(rooms.rejoin(host.roomId(), host.credential(), request)).isEqualTo(returned);
    assertThat(returned.participantId()).isNotEqualTo(host.participantId());
    assertThatThrownBy(() -> command(host, "leave", null, 0)).isInstanceOf(Problem.class);
    assertThatThrownBy(() -> rooms.snapshot(host.roomId(), host.credential()))
        .isInstanceOf(Problem.class);
    var state = rooms.snapshot(returned.roomId(), returned.credential());
    assertThat(state.participants()).hasSize(1);
    assertThat(state.participants().getFirst().owner()).isTrue();
    assertThat(state.messages()).extracting(RoomState.Message::text).containsExactly("Продолжим");
    assertThatThrownBy(() -> media.authorizeSignaling(oldToken)).isInstanceOf(Problem.class);
    assertThatThrownBy(() -> command(host, "close", null, 0)).isInstanceOf(Problem.class);
    assertThatThrownBy(
            () ->
                rooms.rejoin(
                    host.roomId(), host.credential(), new Rejoin(UUID.randomUUID(), "Ещё раз")))
        .isInstanceOf(Problem.class);
    command(returned, "close", null, 0);
    assertThatThrownBy(
            () ->
                rooms.rejoin(
                    returned.roomId(),
                    returned.credential(),
                    new Rejoin(UUID.randomUUID(), "Поздно")))
        .isInstanceOf(Problem.class);
  }

  @Test
  void returnCannotBypassPendingApprovalRemovalOrCapacity() {
    var host = rooms.create(new Create(UUID.randomUUID(), "С подтверждением", "Организатор", true));
    var pending =
        rooms.joinCode(new JoinCode(UUID.randomUUID(), host.snapshot().code(), "Ожидающий"));
    command(pending, "leave", null, 0);
    var returned =
        rooms.rejoin(
            host.roomId(), pending.credential(), new Rejoin(UUID.randomUUID(), "Ожидающий"));
    assertThat(returned.snapshot().participants().getFirst().status())
        .isEqualTo(RoomState.Status.WAITING);
    command(host, "participant.remove", returned.participantId(), 0);
    assertThatThrownBy(
            () ->
                rooms.rejoin(
                    host.roomId(), returned.credential(), new Rejoin(UUID.randomUUID(), "Снова")))
        .isInstanceOf(Problem.class);
    var guest = guest(host);
    command(guest, "leave", null, 0);
    for (int i = 0; i < 9; i++) guest(host);
    assertThatThrownBy(
            () ->
                rooms.rejoin(
                    host.roomId(), guest.credential(), new Rejoin(UUID.randomUUID(), "Места нет")))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("десять");
  }

  @Test
  void ownerApprovalDoesNotGrantGuestAdministrativeRights() {
    var host = rooms.create(new Create(UUID.randomUUID(), "Закрытая", "Хост", true));
    var guest = guest(host);
    assertThat(rooms.read(host.roomId()).members.get(guest.participantId()).status)
        .isEqualTo(RoomState.Status.WAITING);
    assertThatThrownBy(() -> media.token(host.roomId(), guest.credential()))
        .isInstanceOf(Problem.class);
    assertThatThrownBy(() -> command(guest, "close", null, 0)).isInstanceOf(Problem.class);
    command(host, "participant.approve", guest.participantId(), 0);
    assertThat(rooms.read(host.roomId()).members.get(guest.participantId()).status)
        .isEqualTo(RoomState.Status.JOINING);
  }

  @Test
  void approvedGuestGetsInitialJoinWindowWithoutExtendingEstablishedRecovery() {
    var host = rooms.create(new Create(UUID.randomUUID(), "Допуск", "Хост", true));
    connected(host);
    var guest = guest(host);
    now.addAndGet(45000);
    command(host, "participant.approve", guest.participantId(), 0);
    long approvedAt = now.get();
    now.addAndGet(25000);
    lifecycle.sweepRoom(host.roomId());
    var joining = rooms.read(host.roomId()).members.get(guest.participantId());
    assertThat(joining.status).isEqualTo(RoomState.Status.JOINING);
    assertThat(joining.recoveryDeadline).isEqualTo(approvedAt + config.joinSeconds() * 1000L);
    media.token(host.roomId(), guest.credential());
    command(guest, "media.restored", null, joining.generation);
    var active = rooms.read(host.roomId()).members.get(guest.participantId());
    command(guest, "media.lost", null, active.generation);
    assertThat(rooms.read(host.roomId()).members.get(guest.participantId()).recoveryDeadline)
        .isEqualTo(now.get() + config.recoverySeconds() * 1000L);
  }

  /**
   * Исключение и отзыв приглашения действуют сразу: прежний вход перестаёт работать в тот же миг.
   */
  @Test
  void revokedInvitesAndRemovedSessionsStopWorkingAtOnce() {
    var host = host();
    var guest = guest(host);
    var room = rooms.read(host.roomId());
    var token =
        new MediaGateway(config).token(room, room.members.get(guest.participantId())).token();
    media.authorizeSignaling(token);
    command(host, "participant.remove", guest.participantId(), 0);
    assertThatThrownBy(() -> media.authorizeSignaling(token)).isInstanceOf(Problem.class);
    assertThatThrownBy(() -> rooms.snapshot(host.roomId(), guest.credential()))
        .isInstanceOf(Problem.class);
    command(host, "invite.revoke", null, 0);
    assertThatThrownBy(() -> guest(host))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("отозвано");
  }

  @Test
  void retriesCannotExtendDeadlineAndOldGenerationCannotBreakRecoveredSession() {
    var host = host();
    connected(host);
    var member = rooms.read(host.roomId()).members.get(host.participantId());
    long generation = member.generation;
    command(host, "media.lost", null, generation);
    long deadline = rooms.read(host.roomId()).members.get(host.participantId()).recoveryDeadline;
    now.addAndGet(5000);
    command(host, "media.lost", null, generation);
    assertThat(rooms.read(host.roomId()).members.get(host.participantId()).recoveryDeadline)
        .isEqualTo(deadline);
    connected(host);
    assertThat(rooms.read(host.roomId()).members.get(host.participantId()).status)
        .isEqualTo(RoomState.Status.RECOVERING);
    command(host, "media.restored", null, generation);
    command(host, "media.lost", null, generation);
    assertThat(rooms.read(host.roomId()).members.get(host.participantId()).status)
        .isEqualTo(RoomState.Status.CONNECTED);
    var current = rooms.read(host.roomId()).members.get(host.participantId());
    command(host, "media.lost", null, current.generation);
    now.addAndGet(20000);
    lifecycle.sweepRoom(host.roomId());
    assertThat(rooms.read(host.roomId()).members.get(host.participantId()).status)
        .isEqualTo(RoomState.Status.EXPIRED);
    connected(host);
    assertThat(rooms.read(host.roomId()).members.get(host.participantId()).status)
        .isEqualTo(RoomState.Status.EXPIRED);
  }

  @Test
  void staleSfuDepartureDoesNotRemoveANewConnection() {
    var host = host();
    connected(host);
    media.webhook(
        host.roomId(), host.participantId(), "PA_new", "participant_joined", now.incrementAndGet());
    media.webhook(
        host.roomId(), host.participantId(), "PA_first", "participant_left", now.incrementAndGet());
    assertThat(rooms.read(host.roomId()).members.get(host.participantId()).status)
        .isEqualTo(RoomState.Status.CONNECTED);
  }

  @Test
  void onlyTwoScreenSlotsCanBeGrantedConcurrently() throws Exception {
    var host = host();
    var a = guest(host);
    var b = guest(host);
    try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
      var jobs =
          List.of(host, a, b).stream()
              .map(
                  p ->
                      pool.submit(
                          () -> {
                            try {
                              media.screen(p.roomId(), p.credential(), UUID.randomUUID(), true);
                              return true;
                            } catch (Problem e) {
                              assertThat(e.code()).isEqualTo("SCREEN_LIMIT");
                              return false;
                            }
                          }))
              .toList();
      int accepted = 0;
      for (var job : jobs) if (job.get()) accepted++;
      assertThat(accepted).isEqualTo(2);
    }
  }

  @Test
  void failedSfuPermissionChangeDoesNotConsumeAScreenSlot() {
    var host = host();
    doThrow(new Problem(503, "MEDIA_UNAVAILABLE", "Offline"))
        .when(gateway)
        .permissions(anyString(), anyString(), eq(true));
    assertThatThrownBy(
            () -> media.screen(host.roomId(), host.credential(), UUID.randomUUID(), true))
        .isInstanceOf(Problem.class);
    assertThat(rooms.read(host.roomId()).members.get(host.participantId()).screen).isFalse();
  }

  @Test
  void commandReplayDeliversOneMessageAndFallsBackToSnapshotAfterTrimming() {
    var host = host();
    var message = new Command(UUID.randomUUID(), "message.send", "Привет", null, 0);
    var first = rooms.command(host.roomId(), host.credential(), message);
    var second = rooms.command(host.roomId(), host.credential(), message);
    assertThat(first).isEqualTo(second);
    assertThat(rooms.snapshot(host.roomId(), host.credential()).messages()).hasSize(1);
    for (int i = 0; i < 8; i++)
      rooms.command(
          host.roomId(),
          host.credential(),
          new Command(UUID.randomUUID(), "message.send", "Сообщение " + i, null, 0));
    assertThat(rooms.replay(host.roomId(), host.credential(), 0).reset()).isTrue();
    long seq = rooms.read(host.roomId()).sequence;
    assertThat(rooms.replay(host.roomId(), host.credential(), seq).events()).isEmpty();
  }

  @Test
  void expiredFilesAreDeniedBeforePhysicalSweepAndQuotaIsEnforced() throws Exception {
    var host = host();
    var guest = guest(host);
    var file =
        attachments.reserve(
            host.roomId(),
            host.credential(),
            new AttachmentService.Reserve(UUID.randomUUID(), "document.txt", 4));
    assertThatThrownBy(() -> attachments.begin(file.id(), guest.credential(), 4))
        .isInstanceOf(Problem.class);
    assertThatThrownBy(() -> attachments.begin(file.id(), host.credential(), 5))
        .isInstanceOf(Problem.class);
    attachments.begin(file.id(), host.credential(), 4);
    Files.createDirectories(attachments.path(file.id()).getParent());
    Files.writeString(attachments.path(file.id()), "test");
    attachments.complete(file.id(), 4);
    assertThat(attachments.download(file.id(), guest.credential()).sha256()).hasSize(64);
    assertThatThrownBy(
            () ->
                attachments.reserve(
                    host.roomId(),
                    host.credential(),
                    new AttachmentService.Reserve(
                        UUID.randomUUID(), "large", config.fileMaxBytes() + 1)))
        .isInstanceOf(Problem.class);
    command(host, "close", null, 0);
    now.addAndGet(config.retention().closedHistory().toMillis());
    assertThatThrownBy(() -> attachments.download(file.id(), host.credential()))
        .isInstanceOf(Problem.class);
    assertThat(Files.exists(attachments.path(file.id()))).isTrue();
    attachments.sweep();
    assertThat(Files.exists(attachments.path(file.id()))).isFalse();
  }

  @Test
  void unusedRoomsAndEmptyMeetingsCloseAtDifferentDeadlines() {
    // Обе комнаты сохранены в избранное: иначе закрытие и удаление случаются одним проходом,
    // и проверять сроки закрытия стало бы не на чем. Про само удаление — отдельный тест.
    var unused = host();
    saved(unused);
    now.addAndGet(300000);
    lifecycle.sweepRoom(unused.roomId());
    assertThat(rooms.read(unused.roomId()).closedAt).isNotNull();
    var used = host();
    saved(used);
    connected(used);
    command(used, "leave", null, 0);
    lifecycle.sweepRoom(used.roomId());
    now.addAndGet(59999);
    lifecycle.sweepRoom(used.roomId());
    assertThat(rooms.read(used.roomId()).closedAt).isNull();
    now.incrementAndGet();
    lifecycle.sweepRoom(used.roomId());
    assertThat(rooms.read(used.roomId()).closedAt).isNotNull();
  }

  @Test
  void cancellationDeniesAccessBeforeADeferredTusDeletion() {
    var host = host();
    var file =
        attachments.reserve(
            host.roomId(),
            host.credential(),
            new AttachmentService.Reserve(UUID.randomUUID(), "partial.bin", 100));
    attachments.begin(file.id(), host.credential(), 100);
    attachments.cancel(file.id(), host.credential());
    assertThatThrownBy(() -> attachments.authorizeUpload(file.id(), host.credential(), "PATCH"))
        .isInstanceOf(Problem.class);
    assertThat(attachments.list(host.roomId(), host.credential())).isEmpty();
    when(tus.terminate(file.id())).thenReturn(false);
    attachments.sweep();
    assertThat(attachments.get(file.id())).isNotNull();
    when(tus.terminate(file.id())).thenReturn(true);
    attachments.sweep();
    assertThatThrownBy(() -> attachments.get(file.id())).isInstanceOf(Problem.class);
  }

  @Test
  void favoritesRequireMembershipAndSaveAtomically() throws Exception {
    String profile = "A".repeat(43);
    var hosts = java.util.stream.IntStream.range(0, 12).mapToObj(_ -> host()).toList();
    try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
      var results =
          hosts.stream()
              .map(h -> pool.submit(() -> favorites.save(profile, h.roomId(), h.credential())))
              .toList();
      for (var result : results) result.get();
    }
    // Числа комнат больше нет: одновременная запись двенадцати сохраняет все двенадцать, по
    // одной записи на комнату и без гонок.
    assertThat(favorites.list(profile)).hasSize(12);
    assertThat(favorites.list("B".repeat(43))).isEmpty();
    var first = hosts.getFirst();
    var closed =
        rooms.create(new Create(UUID.randomUUID(), "С подтверждением", "Организатор", true));
    var pending =
        rooms.joinCode(new JoinCode(UUID.randomUUID(), closed.snapshot().code(), "Ожидающий"));
    assertThatThrownBy(() -> favorites.save("B".repeat(43), closed.roomId(), pending.credential()))
        .isInstanceOf(Problem.class);
    assertThatThrownBy(() -> favorites.save("B".repeat(43), first.roomId(), "invalid"))
        .isInstanceOf(Problem.class);
  }

  @Test
  void favoriteDefinitionSurvivesAsLongAsAnyoneKeepsIt() {
    var host = host();
    var guest = guest(host);
    String a = "A".repeat(43), b = "B".repeat(43);
    favorites.save(a, host.roomId(), host.credential());
    favorites.save(b, host.roomId(), guest.credential());
    command(host, "leave", null, 0);
    command(guest, "leave", null, 0);
    now.addAndGet(3 * 86400000L);
    favorites.remove(a, host.roomId());
    lifecycle.sweepRoom(host.roomId());
    assertThat(rooms.read(host.roomId()).closedAt).isNotNull();
    now.addAndGet(3600000);
    lifecycle.sweepRoom(host.roomId());
    assertThat(favorites.list(b)).hasSize(1);
    var returned = favorites.join(b, host.roomId(), new Rejoin(UUID.randomUUID(), "Снова вместе"));
    assertThat(returned.snapshot().title()).isEqualTo(host.snapshot().title());
    assertThat(returned.snapshot().code()).isEqualTo(host.snapshot().code());
    assertThat(returned.snapshot().closedAt()).isNull();
    command(returned, "leave", null, 0);
    favorites.remove(b, host.roomId());
    // Последний убрал встречу из избранного: держать её больше не для кого, и уходит она тем
    // же проходом, который её закрывает, — без часа ожидания неизвестно кого.
    lifecycle.sweepRoom(host.roomId());
    assertThatThrownBy(() -> rooms.read(host.roomId())).isInstanceOf(Problem.class);
  }

  /**
   * Встречу, которую никто себе не сохранил, ждать некому.
   *
   * <p>ЗАЧЕМ ТЕСТ. Раньше такая комната лежала в базе час после завершения — на случай, которого не
   * бывает: вернуться в неё можно только по ссылке из списка недавних, а список этот живёт у того,
   * кто уже ушёл. Час оплачивался снимком, расписками и ежесекундной уборкой на каждую брошенную
   * встречу. Проверяем обе половины срока {@code stream.retention.unsaved-room}: несохранённая
   * уходит сразу, сохранённая в том же проходе остаётся.
   */
  @Test
  void aMeetingNobodySavedDisappearsWithTheConversation() {
    var forgotten = host();
    connected(forgotten);
    command(forgotten, "leave", null, 0);
    var kept = host();
    connected(kept);
    favorites.save("D".repeat(43), kept.roomId(), kept.credential());
    command(kept, "leave", null, 0);
    // Первый проход отмечает, что комнаты опустели, второй — по истечении срока — закрывает.
    lifecycle.sweepRoom(forgotten.roomId());
    lifecycle.sweepRoom(kept.roomId());
    now.addAndGet(config.emptyRoomSeconds() * 1000L);
    lifecycle.sweepRoom(forgotten.roomId());
    lifecycle.sweepRoom(kept.roomId());
    assertThatThrownBy(() -> rooms.read(forgotten.roomId())).isInstanceOf(Problem.class);
    assertThat(rooms.read(kept.roomId()).closedAt).isNotNull();
  }

  /**
   * Неделя без единого входа — и встреча уходит у всех разом.
   *
   * <p>Проверяются обе половины обещания: комната исчезает из базы, и вместе с ней исчезают записи
   * избранного у каждого, кто её сохранил, — даже у того, кто ничего не удалял. Отдельного «убрать
   * у всех» в коде нет: избранное держит ссылку на комнату, а не её копию.
   */
  @Test
  void aMeetingNobodyReturnsToDisappearsFromEveryFavoriteList() {
    var host = host();
    var guest = guest(host);
    String a = "A".repeat(43), b = "B".repeat(43);
    favorites.save(a, host.roomId(), host.credential());
    favorites.save(b, host.roomId(), guest.credential());
    command(host, "leave", null, 0);
    command(guest, "leave", null, 0);
    now.addAndGet(config.unusedRoomSeconds() * 1000L);
    lifecycle.sweepRoom(host.roomId());
    assertThat(rooms.read(host.roomId()).closedAt).isNotNull();
    // За день до срока комната на месте: её держит избранное, как и держало.
    now.addAndGet(config.retention().savedRoom().toMillis() - 86400000L);
    lifecycle.sweepRoom(host.roomId());
    assertThat(favorites.list(a)).hasSize(1);
    now.addAndGet(86400000L);
    lifecycle.sweepRoom(host.roomId());
    assertThatThrownBy(() -> rooms.read(host.roomId())).isInstanceOf(Problem.class);
    assertThat(favorites.list(a)).isEmpty();
    assertThat(favorites.list(b)).isEmpty();
    assertThatThrownBy(
            () -> favorites.join(b, host.roomId(), new Rejoin(UUID.randomUUID(), "Поздно")))
        .isInstanceOf(Problem.class);
  }

  /** Пока во встречу возвращаются, срок отсчитывается заново — сколько бы ей ни было месяцев. */
  @Test
  void returningToASavedMeetingStartsTheRetentionWindowOver() {
    var host = host();
    String profile = "A".repeat(43);
    favorites.save(profile, host.roomId(), host.credential());
    command(host, "leave", null, 0);
    for (int week = 0; week < 3; week++) {
      now.addAndGet(config.retention().savedRoom().toMillis() - 86400000L);
      lifecycle.sweepRoom(host.roomId());
      assertThat(favorites.list(profile)).hasSize(1);
      var returned = favorites.join(profile, host.roomId(), new Rejoin(UUID.randomUUID(), "Снова"));
      command(returned, "leave", null, 0);
      lifecycle.sweepRoom(host.roomId());
    }
    now.addAndGet(config.retention().savedRoom().toMillis());
    lifecycle.sweepRoom(host.roomId());
    assertThatThrownBy(() -> rooms.read(host.roomId())).isInstanceOf(Problem.class);
  }

  /**
   * Пустая комната не переписывается каждый проход.
   *
   * <p>ЗАЧЕМ ТЕСТ. Раньше {@code sweepRoom} сохранял комнату безусловно, и тридцать сохранённых
   * встреч означали тридцать обновлений строки в секунду навсегда — при том что не менялось ничего.
   * Видно это не было ниоткуда: снимок оставался прежним, а росли только WAL и раздувание таблицы.
   * Сторож здесь — {@code updated_at}: он обязан стоять, пока комната не изменилась.
   */
  @Test
  void anIdleRoomIsNotRewrittenOnEverySweep() {
    var host = host();
    // Встречу сохранили: та, которую не сохранил никто, до «лежит и не меняется» не доживает —
    // она уходит вместе с разговором, и переписывать там нечего.
    String profile = saved(host);
    command(host, "leave", null, 0);
    now.addAndGet(config.unusedRoomSeconds() * 1000L);
    lifecycle.sweepRoom(host.roomId());
    assertThat(rooms.read(host.roomId()).closedAt).isNotNull();
    long settled = updatedAt(host.roomId());
    for (int pass = 0; pass < 5; pass++) {
      now.addAndGet(1000);
      lifecycle.sweepRoom(host.roomId());
    }
    assertThat(updatedAt(host.roomId())).isEqualTo(settled);
    // А изменение всё так же записывается — и вместе с ним отметка последнего входа.
    var returned = favorites.join(profile, host.roomId(), new Rejoin(UUID.randomUUID(), "Я"));
    assertThat(updatedAt(host.roomId())).isGreaterThan(settled);
    command(returned, "leave", null, 0);
    now.addAndGet(config.unusedRoomSeconds() * 1000L);
    lifecycle.sweepRoom(host.roomId());
    assertThat(lastSeenAt(host.roomId())).isGreaterThan(settled);
  }

  String saved(Admission host) {
    String profile = "C".repeat(43);
    favorites.save(profile, host.roomId(), host.credential());
    return profile;
  }

  long updatedAt(String roomId) {
    return jdbc.sql("SELECT updated_at FROM rooms WHERE id=?")
        .param(roomId)
        .query(Long.class)
        .single();
  }

  long lastSeenAt(String roomId) {
    return jdbc.sql("SELECT last_seen_at FROM rooms WHERE id=?")
        .param(roomId)
        .query(Long.class)
        .single();
  }

  @Test
  void reopeningSavedRoomDoesNotExtendClosedChatOrFileRetention() throws Exception {
    var host = host();
    String profile = "A".repeat(43);
    favorites.save(profile, host.roomId(), host.credential());
    rooms.command(
        host.roomId(),
        host.credential(),
        new Command(UUID.randomUUID(), "message.send", "Временно", null, 0));
    var file =
        attachments.reserve(
            host.roomId(),
            host.credential(),
            new AttachmentService.Reserve(UUID.randomUUID(), "old.txt", 4));
    attachments.begin(file.id(), host.credential(), 4);
    Files.createDirectories(attachments.path(file.id()).getParent());
    Files.writeString(attachments.path(file.id()), "test");
    attachments.complete(file.id(), 4);
    command(host, "close", null, 0);
    now.addAndGet(1800000);
    var request = new Rejoin(UUID.randomUUID(), "Организатор");
    var returned = favorites.join(profile, host.roomId(), request);
    assertThat(favorites.join(profile, host.roomId(), request)).isEqualTo(returned);
    assertThat(rooms.snapshot(host.roomId(), returned.credential()).messages()).hasSize(1);
    now.addAndGet(1800000);
    assertThat(rooms.snapshot(host.roomId(), returned.credential()).messages()).isEmpty();
    assertThatThrownBy(() -> attachments.download(file.id(), returned.credential()))
        .isInstanceOf(Problem.class);
    var again =
        favorites.join(profile, host.roomId(), new Rejoin(UUID.randomUUID(), "Организатор"));
    assertThat(again.snapshot().participants()).hasSize(1);
    assertThatThrownBy(() -> rooms.snapshot(host.roomId(), returned.credential()))
        .isInstanceOf(Problem.class);
  }

  Ack watch(
      Admission admission, String type, String provider, String kind, String id, Long position) {
    return rooms.command(
        admission.roomId(),
        admission.credential(),
        new Command(UUID.randomUUID(), type, null, null, 0, provider, kind, id, position));
  }

  @Test
  void sharedVideoOpensPausedAndCarriesItsAnchorToEveryone() {
    var host = host();
    var guest = guest(host);
    watch(host, "watch.open", "youtube", "video", "dQw4w9WgXcQ", null);
    var opened = rooms.snapshot(host.roomId(), guest.credential()).watch();
    assertThat(opened.provider()).isEqualTo("youtube");
    assertThat(opened.contentId()).isEqualTo("dQw4w9WgXcQ");
    // Пока комната загружает ролик, играть нечему: открытый ролик стоит в начале на паузе.
    assertThat(opened.paused()).isTrue();
    assertThat(opened.positionMs()).isZero();
    assertThat(opened.openedBy()).isEqualTo(host.participantId());
    now.addAndGet(5000);
    watch(host, "watch.play", null, null, null, 12000L);
    var playing = rooms.snapshot(host.roomId(), host.credential()).watch();
    assertThat(playing.paused()).isFalse();
    assertThat(playing.positionMs()).isEqualTo(12000);
    assertThat(playing.anchorAt()).isEqualTo(now.get());
    assertThat(playing.revision()).isGreaterThan(opened.revision());
  }

  @Test
  void liveChannelHasNoPositionToShareAndCannotBeStopped() {
    var host = host();
    watch(host, "watch.open", "twitch", "channel", "some_channel", null);
    assertThat(rooms.read(host.roomId()).watch.paused).isFalse();
    assertThatThrownBy(() -> watch(host, "watch.pause", null, null, null, 0L))
        .isInstanceOf(Problem.class);
    assertThatThrownBy(() -> watch(host, "watch.seek", null, null, null, 60000L))
        .isInstanceOf(Problem.class);
  }

  @Test
  void watchingTogetherObeysTheIntegrationPermission() {
    var host = host();
    var guest = guest(host);
    rooms.integrationSettings(host.roomId(), host.credential(), false);
    assertThatThrownBy(() -> watch(guest, "watch.open", "youtube", "video", "abc", null))
        .isInstanceOf(Problem.class);
    assertThatThrownBy(() -> watch(guest, "watch.close", null, null, null, null))
        .isInstanceOf(Problem.class);
    rooms.integrationSettings(host.roomId(), host.credential(), true);
    watch(guest, "watch.open", "youtube", "video", "abc", null);
    assertThat(rooms.read(host.roomId()).watch.openedBy).isEqualTo(guest.participantId());
  }

  @Test
  void anybodyWatchingMayStopItForEveryone() {
    var host = host();
    var guest = guest(host);
    var third = guest(host);
    watch(guest, "watch.open", "youtube", "video", "abc", null);
    // Пауза общая: смотрят вместе свои, и просить принёсшего нажать её вслух незачем.
    watch(guest, "watch.play", null, null, null, 1000L);
    watch(host, "watch.pause", null, null, null, 2000L);
    watch(third, "watch.play", null, null, null, 3000L);
    assertThat(rooms.read(host.roomId()).watch.paused).isFalse();
    assertThat(rooms.read(host.roomId()).watch.positionMs).isEqualTo(3000);
    watch(third, "watch.open", "youtube", "video", "xyz", null);
    assertThat(rooms.read(host.roomId()).watch.openedBy).isEqualTo(third.participantId());
    watch(guest, "watch.close", null, null, null, null);
    assertThat(rooms.read(host.roomId()).watch).isNull();
  }

  @Test
  void theRemoteFollowsTheIntegrationPermissionAndNotTheOpener() {
    var host = host();
    var guest = guest(host);
    var third = guest(host);
    watch(guest, "watch.open", "youtube", "video", "abc", null);
    watch(third, "watch.pause", null, null, null, 5000L);
    assertThat(rooms.read(host.roomId()).watch.paused).isTrue();
    // «Интеграции только мне» отбирает пульт у всех, включая принёсшего: это то же самое
    // разрешение трогать во встрече постороннее, а не отдельное право на паузу.
    rooms.integrationSettings(host.roomId(), host.credential(), false);
    assertThatThrownBy(() -> watch(third, "watch.play", null, null, null, 0L))
        .isInstanceOf(Problem.class);
    assertThatThrownBy(() -> watch(guest, "watch.play", null, null, null, 0L))
        .isInstanceOf(Problem.class);
    watch(host, "watch.play", null, null, null, 0L);
    assertThat(rooms.read(host.roomId()).watch.paused).isFalse();
  }

  @Test
  void anEmptyRoomStopsWatchingBeforeItCloses() {
    var host = host();
    var guest = guest(host);
    watch(host, "watch.open", "youtube", "video", "abc", null);
    command(host, "leave", null, 0);
    lifecycle.sweepRoom(host.roomId());
    // Один остался — кино идёт: комната ещё смотрит, просто вдвое тише.
    assertThat(rooms.read(host.roomId()).watch).isNotNull();
    command(guest, "leave", null, 0);
    lifecycle.sweepRoom(host.roomId());
    // Пустой зал не должен тянуть сегменты минутами до закрытия комнаты, а вернувшийся —
    // попадать в середину чужого фильма вместо своей встречи.
    assertThat(rooms.read(host.roomId()).watch).isNull();
  }

  @Test
  void oneIntegrationAtATime() {
    var host = host();
    rooms.addMusicService(host.roomId(), UUID.randomUUID());
    // Музыка уже занимает комнату — кинозалу в ней места нет, и наоборот.
    assertThatThrownBy(() -> watch(host, "watch.open", "youtube", "video", "abc", null))
        .isInstanceOf(Problem.class);
    var music =
        rooms.read(host.roomId()).members.values().stream()
            .filter(m -> "music".equals(m.service))
            .findFirst()
            .orElseThrow();
    command(host, "participant.remove", music.id, 0);
    watch(host, "watch.open", "youtube", "video", "abc", null);
    assertThatThrownBy(() -> rooms.addMusicService(host.roomId(), UUID.randomUUID()))
        .isInstanceOf(Problem.class);
  }

  @Test
  void endedMeetingLeavesNothingPlaying() {
    var host = host();
    watch(host, "watch.open", "youtube", "video", "abc", null);
    command(host, "close", null, 0);
    assertThat(rooms.snapshot(host.roomId(), host.credential()).watch()).isNull();
    assertThatThrownBy(() -> watch(host, "watch.open", "youtube", "video", "abc", null))
        .isInstanceOf(Problem.class);
  }

  @Test
  void waitingGuestDoesNotSeeWhatTheRoomIsWatching() {
    var host = rooms.create(new Create(UUID.randomUUID(), "Закрытая встреча", "Организатор", true));
    var guest = guest(host);
    watch(host, "watch.open", "youtube", "video", "abc", null);
    assertThat(rooms.snapshot(host.roomId(), guest.credential()).watch()).isNull();
    command(host, "participant.approve", guest.participantId(), 0);
    assertThat(rooms.snapshot(host.roomId(), guest.credential()).watch()).isNotNull();
  }

  /**
   * Исключение заканчивает встречу для человека, а не знакомство с комнатой.
   *
   * <p>Прежний вход после него всё так же мёртв — иначе автоматическое переподключение отменяло бы
   * решение ведущего через секунду. А вот войти заново можно: той же дверью и на тех же условиях,
   * что и всем. Комната без подтверждения пускает сразу — ровно как пускала по ссылке-приглашению,
   * которая и раньше была открыта: запрет действовал только на сохранённую комнату, то есть был не
   * запретом, а неудобством.
   */
  @Test
  void removedParticipantReturnsThroughTheSameDoorAsEveryoneElse() {
    var host = host();
    var guest = guest(host);
    String profile = "B".repeat(43);
    favorites.save(profile, host.roomId(), guest.credential());
    command(host, "participant.remove", guest.participantId(), 0);
    assertThatThrownBy(() -> rooms.snapshot(host.roomId(), guest.credential()))
        .isInstanceOf(Problem.class);
    assertThat(favorites.list(profile).getFirst().canJoin()).isTrue();
    var again = favorites.join(profile, host.roomId(), new Rejoin(UUID.randomUUID(), "Снова"));
    assertThat(rooms.read(host.roomId()).members.get(again.participantId()).status)
        .isEqualTo(RoomState.Status.JOINING);
  }

  /** А комната с подтверждением спрашивает ведущего снова: прежнее согласие не наследуется. */
  @Test
  void returningAfterRemovalWaitsForApprovalWhenTheRoomAsksForIt() {
    var host = rooms.create(new Create(UUID.randomUUID(), "С подтверждением", "Организатор", true));
    var guest = guest(host);
    command(host, "participant.approve", guest.participantId(), 0);
    String profile = "C".repeat(43);
    favorites.save(profile, host.roomId(), guest.credential());
    command(host, "participant.remove", guest.participantId(), 0);
    var again = favorites.join(profile, host.roomId(), new Rejoin(UUID.randomUUID(), "Снова"));
    assertThat(rooms.read(host.roomId()).members.get(again.participantId()).status)
        .isEqualTo(RoomState.Status.WAITING);
  }

  Ack poker(Admission admission, String type, String option, Integer seat, Long chips) {
    return rooms.command(
        admission.roomId(),
        admission.credential(),
        new Command(
            UUID.randomUUID(), type, null, null, 0, null, null, null, null, option, seat, chips));
  }

  /**
   * Принести стол во встречу и играть за ним — разные права.
   *
   * <p>Иначе получалось бы, что в комнате, где интеграции ограничены ведущим, играет в карты один
   * ведущий. Стол приносит тот, кому комната разрешила приносить постороннее; садится за него любой
   * участник.
   */
  @Test
  void aTableIsBroughtByWhoeverMayBringIntegrationsAndPlayedByEveryone() {
    var host = host();
    var guest = guest(host);
    rooms.integrationSettings(host.roomId(), host.credential(), false);
    assertThatThrownBy(() -> poker(guest, "poker.open", "friendly", null, null))
        .isInstanceOf(Problem.class);
    poker(host, "poker.open", "friendly", null, null);
    poker(guest, "poker.sit", null, 3, null);
    assertThat(rooms.read(host.roomId()).poker.seats.get(3).memberId)
        .isEqualTo(guest.participantId());
    assertThatThrownBy(() -> poker(guest, "poker.deal", null, null, null))
        .isInstanceOf(Problem.class);
    assertThatThrownBy(() -> poker(guest, "poker.close", null, null, null))
        .isInstanceOf(Problem.class);
    poker(host, "poker.close", null, null, null);
    assertThat(rooms.read(host.roomId()).poker).isNull();
  }

  /** Главное свойство карточной игры в общей комнате: снимок у каждого свой. */
  @Test
  void nobodyEverReceivesSomebodyElsesCards() {
    var host = host();
    var guest = guest(host);
    poker(host, "poker.open", "friendly", null, null);
    poker(host, "poker.sit", null, 0, null);
    poker(guest, "poker.sit", null, 1, null);
    poker(host, "poker.deal", null, null, null);
    var mine = rooms.snapshot(host.roomId(), host.credential()).poker();
    assertThat(mine.seats().get(0).cards()).hasSize(2);
    assertThat(mine.seats().get(1).cards()).isEmpty();
    assertThat(mine.seats().get(1).held()).isEqualTo(2);
    var theirs = rooms.snapshot(host.roomId(), guest.credential()).poker();
    assertThat(theirs.seats().get(1).cards()).hasSize(2);
    assertThat(theirs.seats().get(0).cards()).isEmpty();
    // Тот же снимок приезжает и каналом событий, когда клиент отстал. Раньше там отдавался
    // общий снимок комнаты — с покером это означало бы чужие карты в первом же переподключении.
    var replay = rooms.replay(host.roomId(), guest.credential(), -1);
    assertThat(replay.reset()).isTrue();
    assertThat(replay.snapshot().poker().seats().get(0).cards()).isEmpty();
  }

  /** Сцена в комнате одна: стол и кинозал не делят её, а исключают друг друга. */
  @Test
  void theTableAndTheCinemaCannotShareTheStage() {
    var host = host();
    poker(host, "poker.open", "friendly", null, null);
    assertThatThrownBy(() -> watch(host, "watch.open", "youtube", "video", "abc", null))
        .isInstanceOf(Problem.class);
    poker(host, "poker.close", null, null, null);
    watch(host, "watch.open", "youtube", "video", "abc", null);
    assertThatThrownBy(() -> poker(host, "poker.open", "friendly", null, null))
        .isInstanceOf(Problem.class);
  }

  /** Место и фишки принадлежат человеку, а не сессии: вернувшийся садится на свой стул. */
  @Test
  void aSeatAndItsChipsSurviveAReturnToTheMeeting() {
    var host = host();
    poker(host, "poker.open", "friendly", null, null);
    poker(host, "poker.sit", null, 2, null);
    var again =
        rooms.rejoin(host.roomId(), host.credential(), new Rejoin(UUID.randomUUID(), "Снова"));
    var seat = rooms.read(host.roomId()).poker.seats.get(2);
    assertThat(seat.memberId).isEqualTo(again.participantId());
    assertThat(seat.stack).isEqualTo(5000);
  }

  /** Часы стола идут на сервере: ход, который никто не сделал, кончается сам. */
  @Test
  void theTableMovesItselfWhenNobodyActs() {
    var host = host();
    var guest = guest(host);
    poker(host, "poker.open", "friendly", null, null);
    poker(host, "poker.sit", null, 0, null);
    poker(guest, "poker.sit", null, 1, null);
    poker(host, "poker.deal", null, null, null);
    long first = rooms.read(host.roomId()).poker.deadline;
    now.set(first + 1);
    lifecycle.advanceGame(host.roomId());
    // Сначала в дело идёт банк времени — он для «отвернулся на минуту», а не поблажка.
    long second = rooms.read(host.roomId()).poker.deadline;
    assertThat(second).isGreaterThan(first);
    now.set(second + 1);
    lifecycle.advanceGame(host.roomId());
    var table = rooms.read(host.roomId()).poker;
    assertThat(table.phase).isEqualTo("showdown");
    assertThat(table.seats.get(table.button).folded).isTrue();
  }

  /** Завершённая встреча не открывает стол тому, кто зашёл в неё за историей переписки. */
  @Test
  void closingTheMeetingTakesTheTableAwayWithIt() {
    var host = host();
    var guest = guest(host);
    poker(host, "poker.open", "friendly", null, null);
    poker(host, "poker.sit", null, 0, null);
    poker(guest, "poker.sit", null, 1, null);
    poker(host, "poker.deal", null, null, null);
    command(host, "close", null, 0);
    assertThat(rooms.read(host.roomId()).poker).isNull();
    // Стола нет, а игра была: её итог остаётся в истории беседы.
    var games = rooms.read(host.roomId()).pokerGames;
    assertThat(games).hasSize(1);
    assertThat(games.get(0).ending()).isEqualTo("meeting");
  }

  /**
   * Стол убрали руками — игра кончилась, но не исчезла.
   *
   * <p>Иначе «убрать стол» означало бы стереть то, что за ним происходило полчаса. А вот стол, за
   * которым не сыграли ни одной раздачи, в историю не идёт: это не игра с нулевой статистикой, а
   * отсутствие игры.
   */
  @Test
  void removingTheTableKeepsTheResultOfWhatWasActuallyPlayed() {
    var host = host();
    var guest = guest(host);
    poker(host, "poker.open", "friendly", null, null);
    poker(host, "poker.close", null, null, null);
    assertThat(rooms.read(host.roomId()).pokerGames).isNull();
    poker(host, "poker.open", "friendly", null, null);
    poker(host, "poker.sit", null, 0, null);
    poker(guest, "poker.sit", null, 1, null);
    poker(host, "poker.deal", null, null, null);
    poker(host, "poker.close", null, null, null);
    var games = rooms.games(host.roomId(), host.credential());
    assertThat(games).hasSize(1);
    assertThat(games.get(0).ending()).isEqualTo("closed");
    assertThat(games.get(0).hands()).isEqualTo(1);
    // Метка в снимке — единственное, по чему браузер узнаёт, что историю пора перечитать.
    assertThat(rooms.snapshot(host.roomId(), host.credential()).pokerGamesAt())
        .isEqualTo(games.get(0).finishedAt());
    assertThat(games.get(0).players())
        .extracting(dev.mikki.stream.game.GameSummary.PlayerSummary::name)
        .containsExactlyInAnyOrder("Организатор", "Гость");
  }

  /**
   * Стол, за которым десять минут никого, заканчивает игру сам.
   *
   * <p>Раньше он стоял до конца встречи: люди вставали, уходили, возвращались через час — и
   * заставали чужую игру на сцене. Проверяется именно то, чего в этой логике боишься: девять минут
   * ничего не происходит, а на одиннадцатой игра уходит в историю целиком, а не наполовину.
   */
  @Test
  void aTableNobodySitsAtEndsTheGameAfterTenMinutes() {
    // Ядро считает простой только с момента своего запуска, и здесь он — сейчас: иначе часы
    // соседних проверок, уехавшие на дни вперёд, отсекали бы весь отсчёт этой.
    lifecycle.started();
    var host = host();
    var guest = guest(host);
    media.observe(
        host.roomId(),
        Map.of(host.participantId(), "PA_host", guest.participantId(), "PA_guest"),
        now.incrementAndGet());
    poker(host, "poker.open", "friendly", null, null);
    poker(host, "poker.sit", null, 0, null);
    poker(guest, "poker.sit", null, 1, null);
    poker(host, "poker.deal", null, null, null);
    // Оба встали из-за стола; раздача при этом доигрывается своим чередом.
    poker(host, "poker.stand", null, null, null);
    poker(guest, "poker.stand", null, null, null);
    now.set(rooms.read(host.roomId()).poker.deadline + 1);
    lifecycle.sweepRoom(host.roomId());
    var waiting = rooms.read(host.roomId()).poker;
    assertThat(waiting).isNotNull();
    assertThat(waiting.deserted()).isTrue();
    assertThat(waiting.closesAt()).isGreaterThan(now.get());
    // Девять минут — стол на месте: это «мы отошли», а не «мы разошлись».
    now.addAndGet(9 * 60_000);
    lifecycle.sweepRoom(host.roomId());
    assertThat(rooms.read(host.roomId()).poker).isNotNull();
    // Одиннадцатая минута — игры больше нет, а её итог есть.
    now.addAndGet(2 * 60_000);
    lifecycle.sweepRoom(host.roomId());
    var room = rooms.read(host.roomId());
    assertThat(room.poker).isNull();
    assertThat(room.pokerGames).hasSize(1);
    assertThat(room.pokerGames.get(0).ending()).isEqualTo("idle");
    assertThat(room.pokerGames.get(0).players()).hasSize(2);
    assertThat(rooms.games(host.roomId(), host.credential())).hasSize(1);
  }

  /** Стол, за которым сидят, не заканчивается сам — сколько бы ни ждал следующей раздачи. */
  @Test
  void aTableWithSomebodyAtItIsNeverEndedByTheClock() {
    var host = host();
    media.observe(host.roomId(), Map.of(host.participantId(), "PA_host"), now.incrementAndGet());
    poker(host, "poker.open", "friendly", null, null);
    poker(host, "poker.sit", null, 0, null);
    for (int minutes = 0; minutes < 30; minutes++) {
      now.addAndGet(60_000);
      lifecycle.sweepRoom(host.roomId());
    }
    var table = rooms.read(host.roomId()).poker;
    assertThat(table).isNotNull();
    assertThat(table.closesAt()).isZero();
    assertThat(table.seats.get(0).memberId).isEqualTo(host.participantId());
  }
}
