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
    var host = host();
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
    var host = host();
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
  void revokedInvitesAndRemovedParticipantsCannotReenter() {
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
    now.addAndGet(config.closedRetentionSeconds() * 1000L);
    assertThatThrownBy(() -> attachments.download(file.id(), host.credential()))
        .isInstanceOf(Problem.class);
    assertThat(Files.exists(attachments.path(file.id()))).isTrue();
    attachments.sweep();
    assertThat(Files.exists(attachments.path(file.id()))).isFalse();
  }

  @Test
  void unusedRoomsAndEmptyMeetingsCloseAtDifferentDeadlines() {
    var unused = host();
    now.addAndGet(300000);
    lifecycle.sweepRoom(unused.roomId());
    assertThat(rooms.read(unused.roomId()).closedAt).isNotNull();
    var used = host();
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
  void favoritesRequireMembershipAndLimitFiveAtomically() throws Exception {
    String profile = "A".repeat(43);
    var hosts = java.util.stream.IntStream.range(0, 12).mapToObj(_ -> host()).toList();
    try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
      var results =
          hosts.stream()
              .map(
                  h ->
                      pool.submit(
                          () -> {
                            try {
                              favorites.save(profile, h.roomId(), h.credential());
                              return true;
                            } catch (Problem problem) {
                              assertThat(problem.code()).isEqualTo("FAVORITE_LIMIT");
                              return false;
                            }
                          }))
              .toList();
      int saved = 0;
      for (var result : results) if (result.get()) saved++;
      assertThat(saved).isEqualTo(5);
    }
    assertThat(favorites.list(profile)).hasSize(5);
    assertThat(favorites.list("B".repeat(43))).isEmpty();
    var first = hosts.getFirst();
    var pending =
        rooms.joinCode(new JoinCode(UUID.randomUUID(), first.snapshot().code(), "Ожидающий"));
    assertThatThrownBy(() -> favorites.save("B".repeat(43), first.roomId(), pending.credential()))
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
    lifecycle.sweepRoom(host.roomId());
    assertThat(rooms.read(host.roomId()).closedAt).isNotNull();
    now.addAndGet(3600000);
    lifecycle.sweepRoom(host.roomId());
    assertThatThrownBy(() -> rooms.read(host.roomId())).isInstanceOf(Problem.class);
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

  @Test
  void removedParticipantCannotUseFavoriteToEvadeRemoval() {
    var host = host();
    var guest = guest(host);
    String profile = "B".repeat(43);
    favorites.save(profile, host.roomId(), guest.credential());
    command(host, "participant.remove", guest.participantId(), 0);
    assertThat(favorites.list(profile).getFirst().canJoin()).isFalse();
    assertThatThrownBy(
            () -> favorites.join(profile, host.roomId(), new Rejoin(UUID.randomUUID(), "Снова")))
        .isInstanceOf(Problem.class);
  }
}
