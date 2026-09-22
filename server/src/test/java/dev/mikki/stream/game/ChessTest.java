package dev.mikki.stream.game;

import static org.assertj.core.api.Assertions.*;

import dev.mikki.stream.shared.Json;
import dev.mikki.stream.shared.Problem;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class ChessTest {
  private static final long NOW = 1_700_000_000_000L;

  private Chess game(String preset) {
    var game = Chess.open("w", "Белые", preset, NOW);
    game.sit("b", "Чёрные", 1, NOW);
    game.start(game.id, NOW);
    return game;
  }

  private void move(Chess game, String uci) {
    game.move(game.turn.equals("white") ? "w" : "b", game.id, (long) game.ply, uci, NOW + 1);
  }

  private Chess position(String fen) {
    var game = game("untimed");
    game.fen = fen;
    game.initialFen = fen;
    game.turn = fen.split(" ")[1].equals("w") ? "white" : "black";
    game.repetitions.clear();
    return game;
  }

  @Test
  void validatesTurnLegalityAndTokensWithoutChangingThePosition() {
    var game = game("10-5");
    var initial = game.fen;
    assertThatThrownBy(() -> game.move("spectator", game.id, 0L, "e2e4", NOW + 1))
        .isInstanceOfSatisfying(
            Problem.class,
            problem -> {
              assertThat(problem.status()).isEqualTo(409);
              assertThat(problem.code()).isEqualTo("CHESS_NOT_SEATED");
            });
    assertThatThrownBy(() -> game.move("b", game.id, 0L, "e7e5", NOW + 1))
        .isInstanceOf(Problem.class);
    assertThatThrownBy(() -> game.move("w", "old-game", 0L, "e2e4", NOW + 1))
        .isInstanceOf(Problem.class);
    assertThatThrownBy(() -> game.move("w", game.id, 1L, "e2e4", NOW + 1))
        .isInstanceOf(Problem.class);
    assertThatThrownBy(() -> move(game, "e2e5")).isInstanceOf(Problem.class);
    assertThatThrownBy(() -> move(game, "a9a8")).isInstanceOf(Problem.class);
    assertThat(game.fen).isEqualTo(initial);
    assertThat(game.moves).isEmpty();
    move(game, "e2e4");
    assertThat(game.moves.getFirst().san()).isEqualTo("e4");
    assertThat(game.turn).isEqualTo("black");
    assertThat(game.view("spectator", NOW).legalMoves()).isEmpty();
    assertThat(game.view("b", NOW).legalMoves()).contains("e7e5");
  }

  @Test
  void rejectsMovesExposingOwnKingAndCastleThroughAttack() {
    var pinned = position("4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1");
    assertThatThrownBy(() -> move(pinned, "e2f2")).isInstanceOf(Problem.class);
    var attacked = position("4kr2/8/8/8/8/8/8/R3K2R w KQ - 0 1");
    assertThatThrownBy(() -> move(attacked, "e1g1")).isInstanceOf(Problem.class);
  }

  @Test
  void performsBothCastlesAndRequiresExplicitPromotionPiece() {
    var castles = position("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
    move(castles, "e1g1");
    move(castles, "e8c8");
    assertThat(castles.fen).startsWith("2kr3r/8/8/8/8/8/8/R4RK1 w - -");
    assertThat(castles.moves).extracting(ChessView.ChessMove::san).containsExactly("O-O", "O-O-O");
    var promotion = position("7k/P7/8/8/8/8/8/7K w - - 0 1");
    assertThatThrownBy(() -> move(promotion, "a7a8")).isInstanceOf(Problem.class);
    assertThat(promotion.view("w", NOW).legalMoves()).contains("a7a8q", "a7a8r", "a7a8b", "a7a8n");
    move(promotion, "a7a8n");
    assertThat(promotion.fen).startsWith("N6k/");
    assertThat(promotion.result).isEqualTo("insufficient-material");
  }

  @Test
  void enPassantExpiresAfterOneReplyAndCannotExposeKing() {
    var game = game("untimed");
    for (var uci : List.of("e2e4", "a7a6", "e4e5", "d7d5")) move(game, uci);
    var recovered = Json.read(Json.write(game), Chess.class);
    move(recovered, "e5d6");
    assertThat(recovered.fen).startsWith("rnbqkbnr/1pp1pppp/p2P4/8/");
    assertThat(recovered.moves.getLast().san()).isEqualTo("exd6");
    move(game, "h2h3");
    move(game, "h7h6");
    assertThatThrownBy(() -> move(game, "e5d6")).isInstanceOf(Problem.class);
    var pinned = position("4r1k1/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
    assertThatThrownBy(() -> move(pinned, "e5d6")).isInstanceOf(Problem.class);
  }

  @Test
  void checkmateAndStalemateAreDifferentAndMatePrecedesAutomaticDraw() {
    var mate = game("untimed");
    for (var uci : List.of("f2f3", "e7e5", "g2g4", "d8h4")) move(mate, uci);
    assertThat(mate.phase).isEqualTo("over");
    assertThat(mate.result).isEqualTo("checkmate");
    assertThat(mate.winner).isEqualTo("black");
    assertThat(mate.moves.getLast().san()).isEqualTo("Qh4#");
    assertThat(mate.view("w", NOW).pgn()).contains("1. f3 e5 2. g4 Qh4# 0-1");
    var stalemate = position("7k/5K2/6Q1/8/8/8/8/8 w - - 0 1");
    move(stalemate, "g6f5");
    assertThat(stalemate.result).isEqualTo("stalemate");
    var lastMoveMate = position("7k/5K2/6Q1/8/8/8/8/8 w - - 149 1");
    move(lastMoveMate, "g6g7");
    assertThat(lastMoveMate.result).isEqualTo("checkmate");
  }

  @Test
  void threefoldMustBeClaimedButFivefoldIsAutomaticAndSurvivesSerialization() {
    var game = game("untimed");
    var cycle = List.of("g1f3", "g8f6", "f3g1", "f6g8");
    for (int i = 0; i < 2; i++) for (var uci : cycle) move(game, uci);
    assertThat(game.phase).isEqualTo("playing");
    assertThat(game.view("w", NOW).claimableDraws()).contains("threefold");
    var claimed = Json.read(Json.write(game), Chess.class);
    claimed.act("w", claimed.id, (long) claimed.ply, "draw-claim", null, NOW + 1);
    assertThat(claimed.result).isEqualTo("threefold");
    var recovered = Json.read(Json.write(game), Chess.class);
    for (int i = 0; i < 2; i++) for (var uci : cycle) move(recovered, uci);
    assertThat(recovered.result).isEqualTo("fivefold");
  }

  @Test
  void ignoresIneffectiveEnPassantInRepetitionIncludingPinnedPawn() {
    var game = position("4r1k1/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
    // The d6 en-passant square changes no legal move: the e5 pawn is pinned.
    for (int i = 0; i < 2; i++)
      for (var uci : List.of("e1d1", "g8h8", "d1e1", "h8g8")) move(game, uci);
    assertThat(game.view("w", NOW).claimableDraws()).contains("threefold");
    var effective = position("6k1/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
    for (int i = 0; i < 2; i++)
      for (var uci : List.of("e1d1", "g8h8", "d1e1", "h8g8")) move(effective, uci);
    assertThat(effective.view("w", NOW).claimableDraws()).doesNotContain("threefold");
  }

  @Test
  void fiftyMoveClaimsMayDeclareAnIntendedMoveAndSeventyFiveIsAutomatic() {
    var intended = position("7k/8/8/8/8/8/8/R3K3 w - - 99 50");
    intended.act("w", intended.id, 0L, "draw-claim", "a1a2", NOW + 1);
    assertThat(intended.result).isEqualTo("fifty-move");
    assertThat(intended.moves).isEmpty();
    var automatic = position("7k/8/8/8/8/8/8/R3K3 w - - 149 75");
    move(automatic, "a1a2");
    assertThat(automatic.result).isEqualTo("seventy-five-move");
  }

  @Test
  void exposesAndAcceptsProspectiveRepetitionClaimsWithoutPlayingTheDeclaredMove() {
    var game = game("untimed");
    for (var uci : List.of("g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1")) move(game, uci);
    assertThat(game.view("b", NOW).claimableDraws()).isEmpty();
    assertThat(game.view("b", NOW).claimableMoves()).contains("f6g8");
    assertThat(game.view("w", NOW).claimableMoves()).isEmpty();
    game.act("b", game.id, 7L, "draw-claim", "f6g8", NOW + 1);
    assertThat(game.result).isEqualTo("threefold");
    assertThat(game.ply).isEqualTo(7);
  }

  @Test
  void cannotLoseByResigningAgainstABareKingAndSameColorPromotedBishopsAreDead() {
    var game = position("7k/8/8/8/8/8/8/R3K3 w - - 0 1");
    game.act("w", game.id, 0L, "resign", null, NOW + 1);
    assertThat(game.winner).isNull();
    assertThat(game.result).isEqualTo("resignation-insufficient-material");
    var bishops = position("7k/8/8/8/8/8/8/2B1KB2 w - - 0 1");
    move(bishops, "c1d2");
    assertThat(bishops.result).isNull();
    var same = position("6k1/8/8/8/8/8/8/B1B1K3 w - - 0 1");
    move(same, "a1b2");
    assertThat(same.result).isEqualTo("insufficient-material");
  }

  @Test
  void clocksChargeOnlyTheMoverAndTimeoutCommitsInsteadOfThrowing() {
    var game = game("3-2");
    game.move("w", game.id, 0L, "e2e4", NOW + 1000);
    assertThat(game.whiteMs).isEqualTo(181_000);
    assertThat(game.blackMs).isEqualTo(180_000);
    assertThat(game.deadline).isEqualTo(NOW + 181_000);
    var recovered = Json.read(Json.write(game), Chess.class);
    recovered.move("b", recovered.id, 1L, "e7e5", NOW + 181_000);
    assertThat(recovered.result).isEqualTo("timeout");
    assertThat(recovered.winner).isEqualTo("white");
    assertThat(recovered.ply).isEqualTo(1);
    assertThat(recovered.deadline).isZero();
    assertThat(recovered.blackMs).isZero();
  }

  @Test
  void flagAgainstBareKingDrawsButTwoKnightsStillHavePossibleMate() {
    var bare = game("5-0");
    bare.fen = "7k/8/8/8/8/8/8/R3K3 w - - 0 1";
    assertThat(bare.tick(NOW + 300_000)).isTrue();
    assertThat(bare.result).isEqualTo("timeout-insufficient-material");
    var knights = game("5-0");
    knights.fen = "nn5k/8/8/8/8/8/8/4K3 w - - 0 1";
    knights.tick(NOW + 300_000);
    assertThat(knights.result).isEqualTo("timeout");
    assertThat(knights.winner).isEqualTo("black");
  }

  @Test
  void aDrawOfferBelongsToOpponentAndRematchNeedsBothThenSwitchesColors() {
    var game = game("untimed");
    game.act("w", game.id, 0L, "draw-offer", null, NOW);
    assertThatThrownBy(() -> game.act("w", game.id, 0L, "draw-accept", null, NOW))
        .isInstanceOf(Problem.class);
    game.act("b", game.id, 0L, "draw-accept", null, NOW);
    assertThat(game.result).isEqualTo("agreement");
    var oldId = game.id;
    game.act("w", oldId, 0L, "rematch", null, NOW);
    assertThat(game.phase).isEqualTo("over");
    game.act("b", oldId, 0L, "rematch", null, NOW);
    assertThat(game.phase).isEqualTo("playing");
    assertThat(game.id).isNotEqualTo(oldId);
    assertThat(game.white.memberId).isEqualTo("b");
    assertThat(game.black.memberId).isEqualTo("w");
    assertThatThrownBy(() -> game.act("w", oldId, 0L, "resign", null, NOW))
        .isInstanceOf(Problem.class);
  }

  @Test
  void presenceRetainsSeatsAndRejoinRebindsOwnershipAndRematchRequests() {
    var game = game("untimed");
    game.presence(Set.of("b"), NOW);
    assertThat(game.white.away).isTrue();
    assertThat(game.phase).isEqualTo("playing");
    game.rebind("w", "w2", "Вернулся");
    assertThat(game.hostId).isEqualTo("w2");
    assertThat(game.white.memberId).isEqualTo("w2");
    assertThat(game.white.away).isFalse();
    game.move("w2", game.id, 0L, "e2e4", NOW);
    assertThat(game.ply).isEqualTo(1);
    assertThat(game.linger(NOW + 700_000, NOW)).isFalse();
  }
}
