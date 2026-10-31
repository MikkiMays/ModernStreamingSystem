package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;

import dev.mikki.stream.room.Permissions;
import dev.mikki.stream.room.Permissions.Action;
import dev.mikki.stream.room.RoomState;
import dev.mikki.stream.shared.Problem;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/**
 * Матрица прав встречи — ровно таблица из {@code docs/superpowers/specs/2026-10-19-permissions.md}.
 *
 * <p>Каждая клетка — два знака: при включённом и при выключенном флаге «интеграции всем». Столбцы:
 * создатель, участник, ведущий игры (участник, который принёс все столы), ожидающий, бот, ушедший.
 * Во встрече стоят все четыре стола, и принёс их не тот, кто в столбце «участник».
 */
class PermissionsTest {
  private static final String HOST = "game-host";

  @ParameterizedTest(name = "{0}")
  @CsvSource(
      delimiter = '|',
      textBlock =
          """
          # действие          | создатель | участник | ведущий игры | ожидающий | бот | ушедший
          room.close          | ++ | -- | -- | -- | -- | --
          room.settings       | ++ | -- | -- | -- | -- | --
          room.integrations   | ++ | -- | -- | -- | -- | --
          invite.manage       | ++ | -- | -- | -- | -- | --
          participant.approve | ++ | -- | -- | -- | -- | --
          participant.remove  | ++ | -- | -- | -- | -- | --
          participant.mute    | ++ | -- | -- | -- | -- | --
          telegram.link       | ++ | -- | -- | -- | -- | --
          integrations.use    | ++ | +- | +- | -- | -- | --
          music.view          | ++ | ++ | ++ | -- | -- | --
          music.enable        | ++ | +- | +- | -- | -- | --
          music.control       | ++ | +- | +- | -- | -- | --
          music.upload        | ++ | +- | +- | -- | -- | --
          music.remove        | ++ | +- | +- | -- | -- | --
          music.search        | ++ | +- | +- | -- | -- | --
          music.link          | ++ | +- | +- | -- | -- | --
          yandex.connect      | ++ | +- | +- | -- | -- | --
          yandex.search       | ++ | +- | +- | -- | -- | --
          yandex.queue        | ++ | +- | +- | -- | -- | --
          yandex.disconnect   | ++ | +- | +- | -- | -- | --
          cinema.browse       | ++ | ++ | ++ | -- | -- | --
          cinema.resolve      | ++ | ++ | ++ | -- | -- | --
          watch.open          | ++ | +- | +- | -- | -- | --
          watch.control       | ++ | +- | +- | -- | -- | --
          watch.close         | ++ | +- | +- | -- | -- | --
          poker.open          | ++ | +- | +- | -- | -- | --
          durak.open          | ++ | +- | +- | -- | -- | --
          chess.open          | ++ | +- | +- | -- | -- | --
          gartic.open         | ++ | +- | +- | -- | -- | --
          poker.manage        | ++ | -- | ++ | -- | -- | --
          durak.manage        | ++ | -- | ++ | -- | -- | --
          chess.manage        | ++ | -- | ++ | -- | -- | --
          gartic.manage       | ++ | -- | ++ | -- | -- | --
          board.open          | ++ | +- | +- | -- | -- | --
          board.draw          | ++ | ++ | ++ | -- | -- | --
          board.settings      | ++ | +- | +- | -- | -- | --
          board.clear         | ++ | +- | +- | -- | -- | --
          board.close         | ++ | -- | ++ | -- | -- | --
          """)
  void matrix(
      String action,
      String creator,
      String participant,
      String gameHost,
      String waiting,
      String bot,
      String left) {
    var known = Action.of(action);
    assertThat(known).as("действие %s есть в ядре", action).isPresent();
    var cells =
        List.of(
            new Cell(member("creator", true, RoomState.Status.CONNECTED), creator),
            new Cell(member("guest", false, RoomState.Status.CONNECTED), participant),
            new Cell(member(HOST, false, RoomState.Status.RECOVERING), gameHost),
            new Cell(member("door", false, RoomState.Status.WAITING), waiting),
            new Cell(bot(), bot),
            new Cell(member("gone", false, RoomState.Status.LEFT), left));
    for (var flag : new boolean[] {true, false}) {
      var room = room(flag);
      for (var cell : cells) {
        room.members.put(cell.member.id, cell.member);
        var expected = cell.signs.charAt(flag ? 0 : 1) == '+';
        assertThat(Permissions.allows(room, cell.member, known.get()))
            .as("%s, %s, флаг %s", action, cell.member.id, flag)
            .isEqualTo(expected);
        assertThat(Permissions.granted(room, cell.member).contains(action))
            .as("you.can: %s, %s, флаг %s", action, cell.member.id, flag)
            .isEqualTo(expected);
      }
    }
  }

  @Test
  void everyActionIsInTheMatrixAndNamesAreStable() {
    assertThat(Arrays.stream(Action.values()).map(Action::wire))
        .doesNotHaveDuplicates()
        .allSatisfy(name -> assertThat(name).matches("[a-z]+\\.[a-z]+"))
        .hasSize(38);
  }

  /**
   * Доска «рисует ведущий» (R159): перо, очистка и выбор, кто рисует, — только у создателя встречи,
   * иначе участник вернул бы себе перо той же кнопкой. Закрыть может и тот, кто открыл.
   */
  @Test
  void hostOnlyBoardLeavesThePenWithTheCreator() {
    var room = room(true);
    room.board.drawers = RoomState.Board.HOST;
    var creator = member("creator", true, RoomState.Status.CONNECTED);
    var guest = member("guest", false, RoomState.Status.CONNECTED);
    var opener = member(HOST, false, RoomState.Status.CONNECTED);
    for (var m : List.of(creator, guest, opener)) room.members.put(m.id, m);
    assertThat(Permissions.granted(room, creator))
        .contains("board.draw", "board.settings", "board.clear", "board.close");
    assertThat(Permissions.granted(room, guest))
        .doesNotContain("board.draw", "board.settings", "board.clear", "board.close")
        .contains("board.open");
    assertThat(Permissions.granted(room, opener))
        .doesNotContain("board.draw", "board.settings", "board.clear")
        .contains("board.close");
  }

  @Test
  void withoutABoardNobodyDrawsOrClosesIt() {
    var room = room(true);
    room.board = null;
    var creator = member("creator", true, RoomState.Status.CONNECTED);
    room.members.put(creator.id, creator);
    assertThat(Permissions.granted(room, creator))
        .doesNotContain("board.draw", "board.settings", "board.clear", "board.close")
        .contains("board.open");
    var guest = member("guest", false, RoomState.Status.CONNECTED);
    room.members.put(guest.id, guest);
    room.board = new RoomState.Board();
    room.board.openedBy = HOST;
    assertThatThrownBy(() -> Permissions.require(room, guest, Action.BOARD_CLOSE))
        .isInstanceOfSatisfying(
            Problem.class,
            p -> {
              assertThat(p.status()).isEqualTo(409);
              assertThat(p.code()).isEqualTo("BOARD_OWNER_ONLY");
            });
  }

  @Test
  void withoutATableNobodyManagesIt() {
    var room = room(true);
    room.poker = null;
    room.durak = null;
    room.chess = null;
    room.gartic = null;
    var creator = member("creator", true, RoomState.Status.CONNECTED);
    room.members.put(creator.id, creator);
    assertThat(Permissions.granted(room, creator))
        .doesNotContain("poker.manage", "durak.manage", "chess.manage", "gartic.manage")
        .contains("poker.open", "room.close");
  }

  @Test
  void closedRoomAllowsNothingAndAnonymousViewHasNoRights() {
    var room = room(true);
    var creator = member("creator", true, RoomState.Status.CONNECTED);
    room.members.put(creator.id, creator);
    room.closedAt = 1L;
    assertThat(Permissions.granted(room, creator)).isEmpty();
    assertThat(Permissions.granted(room, null)).isEmpty();
  }

  @Test
  void refusalsKeepTheirOldCodes() {
    var room = room(false);
    var guest = member("guest", false, RoomState.Status.CONNECTED);
    room.members.put(guest.id, guest);
    assertThatThrownBy(() -> Permissions.require(room, guest, Action.MUSIC_REMOVE))
        .isInstanceOfSatisfying(Problem.class, p -> assertThat(p.status()).isEqualTo(403));
    assertThatThrownBy(() -> Permissions.require(room, guest, Action.POKER_MANAGE))
        .isInstanceOfSatisfying(Problem.class, p -> assertThat(p.status()).isEqualTo(403));
    assertThatThrownBy(() -> Permissions.require(room, guest, Action.CHESS_MANAGE))
        .isInstanceOfSatisfying(
            Problem.class,
            p -> {
              assertThat(p.status()).isEqualTo(409);
              assertThat(p.code()).isEqualTo("GAME_HOST_ONLY");
            });
    assertThatThrownBy(() -> Permissions.require(room, guest, Action.GARTIC_MANAGE))
        .isInstanceOfSatisfying(Problem.class, p -> assertThat(p.status()).isEqualTo(409));
  }

  @Test
  void anOrdinaryParticipantIsWhatTelegramChatGets() {
    assertThat(Permissions.participant(room(true)))
        .contains("music.control", "music.remove", "music.search", "music.link");
    assertThat(Permissions.participant(room(true))).doesNotContain("telegram.link", "room.close");
    assertThat(Permissions.participant(room(false))).doesNotContain("music.control");
    assertThat(Permissions.participant(room(false))).contains("music.view");
  }

  private record Cell(RoomState.Member member, String signs) {}

  private static RoomState room(boolean integrations) {
    var room = new RoomState();
    room.id = "room";
    room.integrationsAllowed = integrations;
    room.poker = new dev.mikki.stream.game.Table();
    room.poker.hostId = HOST;
    room.durak = new dev.mikki.stream.game.Durak();
    room.durak.hostId = HOST;
    room.chess = new dev.mikki.stream.game.Chess();
    room.chess.hostId = HOST;
    room.gartic = new dev.mikki.stream.game.Gartic();
    room.gartic.hostId = HOST;
    // Доску тоже принёс «ведущий игры»: закрыть её может он и создатель.
    room.board = new RoomState.Board();
    room.board.openedBy = HOST;
    return room;
  }

  private static RoomState.Member member(String id, boolean owner, RoomState.Status status) {
    var member = new RoomState.Member();
    member.id = id;
    member.name = id;
    member.owner = owner;
    member.status = status;
    return member;
  }

  private static RoomState.Member bot() {
    var member = member("music", false, RoomState.Status.CONNECTED);
    member.service = "music";
    return member;
  }
}
