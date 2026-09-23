package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import dev.mikki.stream.attachment.TusGateway;
import dev.mikki.stream.media.MediaGateway;
import dev.mikki.stream.room.*;
import dev.mikki.stream.room.Contracts.*;
import dev.mikki.stream.shared.Json;
import dev.mikki.stream.shared.Problem;
import java.time.Clock;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:newgames;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.max-rooms=200",
      "stream.files-root=./.local/test-uploads"
    })
@ActiveProfiles("local")
class NewGamesIntegrationTest {
  @Autowired RoomService rooms;
  @Autowired Lifecycle lifecycle;
  @Autowired JdbcClient jdbc;
  @MockitoBean MediaGateway gateway;
  @MockitoBean TusGateway tus;
  @MockitoBean Clock clock;
  AtomicLong now = new AtomicLong(1_800_000_000_000L);

  @BeforeEach
  void setup() {
    jdbc.sql("DELETE FROM command_receipts").update();
    jdbc.sql("DELETE FROM rooms").update();
    when(clock.millis()).thenAnswer(_ -> now.get());
  }

  Admission host(boolean approval, boolean integrations) {
    return rooms.create(
        new Create(UUID.randomUUID(), "Игровая встреча", "Белые", approval, integrations));
  }

  Admission guest(Admission host, String name) {
    return rooms.join(
        host.roomId(), new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], name));
  }

  Snapshot state(Admission player) {
    return rooms.snapshot(player.roomId(), player.credential());
  }

  Command input(
      String type, String text, String option, String id, Long turn, Integer seat, Long value) {
    return new Command(
        UUID.randomUUID(), type, text, null, 0, null, null, id, turn, option, seat, value);
  }

  Ack send(Admission player, Command command) {
    return rooms.command(player.roomId(), player.credential(), command);
  }

  Ack send(
      Admission player,
      String type,
      String text,
      String option,
      String id,
      Long turn,
      Integer seat,
      Long value) {
    return send(player, input(type, text, option, id, turn, seat, value));
  }

  @Test
  void chessUsesRoomTransactionsReceiptsAndLegalMovesThroughCheckmate() {
    var a = host(false, true);
    var b = guest(a, "Чёрные");
    send(a, "chess.open", null, "untimed", null, null, null, null);
    var id = state(a).chess().id();
    send(b, "chess.sit", null, null, id, null, 1, null);
    send(a, "chess.start", null, null, id, null, null, null);
    String[] moves = {"f2f3", "e7e5", "g2g4", "d8h4"};
    for (int ply = 0; ply < moves.length; ply++) {
      var player = ply % 2 == 0 ? a : b;
      var command = input("chess.move", moves[ply], null, id, (long) ply, null, null);
      var ack = send(player, command);
      assertThat(send(player, command)).isEqualTo(ack);
      assertThat(state(a).chess().ply()).isEqualTo(ply + 1);
      assertThat(state(b).chess().fen()).isEqualTo(state(a).chess().fen());
    }
    assertThat(state(a).chess().result()).isEqualTo("checkmate");
    assertThat(state(a).chess().pgn()).contains("Qh4#", "0-1");
    assertThatThrownBy(() -> send(a, "chess.move", "e2e4", null, id, 0L, null, null))
        .isInstanceOf(Problem.class);
    send(a, "close", null, null, null, null, null, null);
    assertThat(state(a).chess()).isNull();
  }

  /**
   * Пауза без хозяина. Ведущий стола — не владелец встречи — ставит паузу и уходит, владельца во
   * встрече нет. Раньше стол переходил только владельцу, и оставшимся было некому снять паузу:
   * встать на паузе нельзя, пустым стол с идущей партией не считается — сцена занята до конца
   * встречи. Теперь стол достаётся игроку, который за ним сидит.
   */
  @Test
  void aPausedDurakTableIsNotStrandedWhenItsHostAndTheOwnerLeave() {
    var owner = host(false, true);
    var dealer = guest(owner, "Раздающий");
    var player = guest(owner, "Игрок");
    send(dealer, "durak.open", null, null, null, null, null, null);
    send(dealer, "durak.sit", null, null, null, null, 0, null);
    send(player, "durak.sit", null, null, null, null, 1, null);
    send(dealer, "durak.deal", null, null, null, null, null, null);
    send(dealer, "durak.settings", null, "pause", null, null, null, null);
    assertThat(state(player).durak().paused()).isTrue();
    assertThatThrownBy(() -> send(player, "durak.settings", null, "resume", null, null, null, null))
        .isInstanceOf(Problem.class);

    send(owner, "leave", null, null, null, null, null, null);
    send(dealer, "leave", null, null, null, null, null, null);
    lifecycle.sweepRoom(owner.roomId());

    send(player, "durak.settings", null, "resume", null, null, null, null);
    assertThat(state(player).durak().paused()).isFalse();
  }

  @Test
  void gamePermissionsSeparateOpeningFromPlayingAndEnforceStageExclusivity() {
    var a = host(false, false);
    var b = guest(a, "Игрок");
    assertThatThrownBy(() -> send(b, "gartic.open", null, "classic", null, null, null, null))
        .isInstanceOf(Problem.class);
    send(a, "chess.open", null, "untimed", null, null, null, null);
    String chess = state(a).chess().id();
    send(b, "chess.sit", null, null, chess, null, 1, null);
    assertThatThrownBy(() -> send(b, "chess.start", null, null, chess, null, null, null))
        .isInstanceOf(Problem.class);
    for (String type : new String[] {"poker.open", "durak.open", "gartic.open", "watch.open"})
      assertThatThrownBy(() -> send(a, type, null, null, null, null, null, null))
          .isInstanceOf(Problem.class);
    send(a, "chess.close", null, null, chess, null, null, null);
    send(a, "gartic.open", null, "classic", null, null, null, null);
    String drawing = state(a).gartic().gameId();
    send(b, "gartic.join", null, null, drawing, null, null, null);
    assertThat(state(b).gartic().players()).hasSize(2);
    assertThatThrownBy(() -> send(b, "gartic.close", null, null, drawing, null, null, null))
        .isInstanceOf(Problem.class);
    assertThatThrownBy(() -> send(a, "chess.open", null, null, null, null, null, null))
        .isInstanceOf(Problem.class);
    send(a, "gartic.close", null, null, drawing, null, null, null);
    send(a, "durak.open", null, null, null, null, null, null);
    assertThatThrownBy(() -> send(a, "gartic.open", null, "classic", null, null, null, null))
        .isInstanceOf(Problem.class);
  }

  @Test
  void garticSecretsAreAbsentFromOtherViewersAndReplay() {
    var a = host(false, true);
    var b = guest(a, "Угадывает");
    var spectator = guest(a, "Зритель");
    send(a, "gartic.open", null, "classic", null, null, null, null);
    String id = state(a).gartic().gameId();
    send(b, "gartic.join", null, null, id, null, null, null);
    send(a, "gartic.start", null, null, id, null, null, null);
    var choosing = state(a).gartic();
    var drawer = choosing.drawerId().equals(a.participantId()) ? a : b;
    var guesser = drawer == a ? b : a;
    choosing = state(drawer).gartic();
    String word = choosing.you().choices().getFirst();
    send(drawer, "gartic.choose", null, null, choosing.gameId(), choosing.turnToken(), null, 0L);
    var drawing = state(drawer).gartic();
    assertThat(Json.write(state(guesser))).doesNotContain(word);
    assertThat(Json.write(state(spectator))).doesNotContain(word);
    assertThat(Json.write(rooms.replay(a.roomId(), spectator.credential(), 0)))
        .doesNotContain(word);
    assertThatThrownBy(
            () ->
                send(
                    spectator,
                    "gartic.guess",
                    word,
                    null,
                    drawing.gameId(),
                    drawing.turnToken(),
                    null,
                    null))
        .isInstanceOf(Problem.class);
    send(guesser, "gartic.guess", word, null, drawing.gameId(), drawing.turnToken(), null, null);
    assertThat(
            state(guesser).gartic().players().stream()
                .filter(p -> p.memberId().equals(guesser.participantId()))
                .findFirst()
                .orElseThrow()
                .score())
        .isPositive();
  }

  @Test
  void waitingMembersCannotReadGamesAndPersistedClocksAdvanceWithoutClients() {
    var a = host(true, true);
    send(a, "chess.open", null, "3-2", null, null, null, null);
    var waiting = rooms.joinCode(new JoinCode(UUID.randomUUID(), state(a).code(), "В ожидании"));
    assertThat(state(waiting).chess()).isNull();
    assertThat(state(waiting).gartic()).isNull();
    var b = guest(a, "Допущенный");
    if (state(b).participants().stream()
        .anyMatch(p -> p.id().equals(b.participantId()) && p.status() == RoomState.Status.WAITING))
      send(a, new Command(UUID.randomUUID(), "participant.approve", null, b.participantId(), 0));
    String id = state(a).chess().id();
    send(b, "chess.sit", null, null, id, null, 1, null);
    send(a, "chess.start", null, null, id, null, null, null);
    now.set(state(a).chess().deadline() + 1);
    lifecycle.advanceGame(a.roomId());
    assertThat(state(a).chess().result()).isEqualTo("timeout");
  }

  @Test
  void hostTransferSkipsMembersStillWaitingForAdmission() {
    var a = host(true, true);
    send(a, "gartic.open", null, "classic", null, null, null, null);
    var waiting = rooms.joinCode(new JoinCode(UUID.randomUUID(), state(a).code(), "В ожидании"));
    var b = guest(a, "Допущенный");
    send(a, new Command(UUID.randomUUID(), "participant.approve", null, b.participantId(), 0));
    send(a, "leave", null, null, null, null, null, null);
    lifecycle.sweepRoom(a.roomId());
    assertThat(state(b).gartic().hostId()).isEqualTo(b.participantId());
    assertThat(state(waiting).gartic()).isNull();
  }
}
