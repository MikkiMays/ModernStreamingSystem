package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.mikki.stream.game.Gartic;
import dev.mikki.stream.shared.Problem;
import java.util.Set;
import org.junit.jupiter.api.Test;

class GarticTest {
  private static final long NOW = 1_700_000_000_000L;

  private Gartic game(String mode, int players) {
    var game = Gartic.open("p0", "Игрок 0", mode, NOW);
    for (int i = 1; i < players; i++) game.join("p" + i, "Игрок " + i, NOW);
    return game;
  }

  private String stroke(String id) {
    return "{\"strokes\":[{\"id\":\""
        + id
        + "\",\"color\":\"#123abc\",\"width\":4,\"points\":[[0,1000],[500,500]]}]}";
  }

  @Test
  void classicChoicesAndAnswerStayPrivateAndCorrectGuessNeverLeaksThroughChat() throws Exception {
    var game = game("classic", 3);
    game.start(NOW);
    var drawer = game.view("p0", NOW);
    assertThat(drawer.you().choices()).hasSize(3);
    assertThat(game.view("p1", NOW).you().choices()).isEmpty();
    assertThat(game.view("spectator", NOW).you()).isNull();
    String answer = drawer.you().choices().get(0);
    game.choose("p0", 0, game.turnToken, NOW);
    assertThat(game.view("p1", NOW).answer()).isNull();
    assertThat(game.view("p1", NOW).you().prompt()).isNull();
    game.guess("p1", "  " + answer.toUpperCase() + "  ", game.turnToken, NOW + 1000);
    assertThat(game.players.get(1).score).isEqualTo(495);
    assertThat(game.players.get(0).score).isEqualTo(100);
    var view = game.view("p2", NOW + 1000);
    assertThat(view.guesses()).hasSize(1);
    assertThat(view.guesses().getFirst().correct()).isTrue();
    assertThat(new ObjectMapper().writeValueAsString(view)).doesNotContain(answer);
    assertThatThrownBy(() -> game.guess("p1", answer, game.turnToken, NOW + 2000))
        .isInstanceOf(Problem.class);
  }

  @Test
  void allGuessedRevealsAnswerAndOldPhaseCannotModifyTheNextTurn() {
    var game = game("classic", 2);
    game.configure("rounds", 2L, NOW);
    game.start(NOW);
    game.choose("p0", 0, game.turnToken, NOW);
    long token = game.turnToken;
    String answer = game.view("p0", NOW).you().prompt();
    game.guess("p1", answer, token, NOW + 1000);
    assertThat(game.phase).isEqualTo("round-reveal");
    assertThat(game.view("spectator", NOW).answer()).isEqualTo(answer);
    game.tick(game.deadline);
    assertThat(game.view("p1", NOW).you().choices()).hasSize(3);
    assertThatThrownBy(() -> game.draw("p0", stroke("late"), token, NOW + 5000))
        .isInstanceOf(Problem.class);
    assertThat(game.view("p0", NOW).canvas()).isEmpty();
  }

  @Test
  void strokesAreAtomicIdempotentAndCannotBeResurrectedAfterUndoOrClear() {
    var game = game("classic", 2);
    game.start(NOW);
    game.choose("p0", 0, game.turnToken, NOW);
    game.draw("p0", stroke("one"), game.turnToken, NOW);
    game.draw("p0", stroke("one"), game.turnToken, NOW);
    assertThat(game.view("p1", NOW).canvas()).hasSize(1);
    String invalid = stroke("two").replace("[500,500]", "[1001,500]");
    assertThatThrownBy(() -> game.draw("p0", invalid, game.turnToken, NOW))
        .isInstanceOf(Problem.class);
    assertThatThrownBy(
            () -> game.draw("p0", stroke("two").replace("4,", "4.5,"), game.turnToken, NOW))
        .isInstanceOf(Problem.class);
    assertThatThrownBy(() -> game.draw("p1", stroke("two"), game.turnToken, NOW))
        .isInstanceOf(Problem.class);
    assertThat(game.view("p1", NOW).canvas()).hasSize(1);
    game.canvas("p0", "undo", game.turnToken, NOW);
    game.draw("p0", stroke("one"), game.turnToken, NOW);
    assertThat(game.view("p1", NOW).canvas()).isEmpty();
    game.draw("p0", stroke("two"), game.turnToken, NOW);
    game.canvas("p0", "clear", game.turnToken, NOW);
    game.draw("p0", stroke("two"), game.turnToken, NOW);
    assertThat(game.view("p1", NOW).canvas()).isEmpty();
  }

  @Test
  void boundedCanvasRejectsOverflowWithoutDroppingExistingInk() {
    var game = game("classic", 2);
    game.start(NOW);
    game.choose("p0", 0, game.turnToken, NOW);
    for (int i = 0; i < 256; i++) game.draw("p0", stroke("s" + i), game.turnToken, NOW);
    assertThatThrownBy(() -> game.draw("p0", stroke("overflow"), game.turnToken, NOW))
        .isInstanceOf(Problem.class);
    assertThat(game.view("p1", NOW).canvas()).hasSize(256);
    game.canvas("p0", "undo", game.turnToken, NOW);
    game.draw("p0", stroke("replacement"), game.turnToken, NOW);
    assertThat(game.view("p1", NOW).canvas()).hasSize(256);
  }

  @Test
  void telephoneAssignmentHidesOtherChainsAndFullMatchRevealsOnlySelectedEntry() throws Exception {
    var game = game("telephone", 3);
    game.start(NOW);
    long token = game.turnToken;
    game.submit("p0", "Красная лодка", token, NOW);
    game.submit("p1", "Синий кит", token, NOW);
    game.submit("p2", "Зелёный лес", token, NOW);
    assertThat(game.phase).isEqualTo("drawing");
    assertThat(game.view("p1", NOW).you().prompt()).isEqualTo("Красная лодка");
    assertThat(new ObjectMapper().writeValueAsString(game.view("p1", NOW)))
        .doesNotContain("Синий кит", "Зелёный лес");
    assertThat(new ObjectMapper().writeValueAsString(game.view("spectator", NOW)))
        .doesNotContain("Красная лодка", "Синий кит", "Зелёный лес");
    token = game.turnToken;
    for (int i = 0; i < 3; i++) {
      game.draw("p" + i, stroke("draw" + i), token, NOW);
      game.submit("p" + i, null, token, NOW);
    }
    assertThat(game.phase).isEqualTo("describing");
    assertThat(game.view("p2", NOW).you().previous().strokes().getFirst().id()).isEqualTo("draw1");
    assertThat(game.view("p2", NOW).you().prompt()).isNull();
    token = game.turnToken;
    for (int i = 0; i < 3; i++) game.submit("p" + i, "Описание " + i, token, NOW);
    assertThat(game.phase).isEqualTo("reveal");
    assertThat(game.view("spectator", NOW).albums()).hasSize(3);
    assertThat(game.view("spectator", NOW).revealed().text()).isEqualTo("Красная лодка");
    game.reveal(0, 1, game.turnToken, NOW);
    var selected = game.view("spectator", NOW);
    assertThat(selected.revealed().strokes().getFirst().id()).isEqualTo("draw1");
    assertThat(selected.revealed().authorId()).isEqualTo("p1");
    assertThat(selected.canvas()).isEmpty();
    assertThat(new ObjectMapper().writeValueAsString(selected)).doesNotContain("draw0", "draw2");
  }

  @Test
  void telephoneTimeoutsAndDeparturesNeverBlockRemainingPlayers() {
    var game = game("telephone", 3);
    game.start(NOW);
    game.leave("p1", NOW);
    game.submit("p0", "Кот", game.turnToken, NOW);
    game.submit("p2", "Дом", game.turnToken, NOW);
    assertThat(game.phase).isEqualTo("drawing");
    game.draw("p0", stroke("draft"), game.turnToken, NOW);
    game.tick(game.deadline);
    assertThat(game.phase).isEqualTo("describing");
    assertThat(game.view("p1", NOW).you()).isNull();
    game.tick(game.deadline);
    assertThat(game.phase).isEqualTo("reveal");
    game.reveal(2, 1, game.turnToken, NOW);
    assertThat(game.view("p0", NOW).revealed().strokes()).hasSize(1);
    game.reveal(1, 0, game.turnToken, NOW);
    assertThat(game.view("p0", NOW).revealed().skipped()).isTrue();
  }

  @Test
  void restartAndRebindPreservePhoneDraftAndFrozenRoster() throws Exception {
    var game = game("telephone", 3);
    game.start(NOW);
    for (int i = 0; i < 3; i++) game.submit("p" + i, "Текст " + i, game.turnToken, NOW);
    game.draw("p0", stroke("saved"), game.turnToken, NOW);
    var mapper = new ObjectMapper();
    var loaded = mapper.readValue(mapper.writeValueAsString(game), Gartic.class);
    assertThat(loaded.rebind("p0", "returned", "Вернулся")).isTrue();
    assertThat(loaded.hostId).isEqualTo("returned");
    assertThat(loaded.view("returned", NOW).canvas()).hasSize(1);
    loaded.join("late", "Поздний", NOW);
    assertThat(loaded.view("late", NOW).you().playing()).isFalse();
    assertThat(loaded.view("late", NOW).you().previous()).isNull();
    assertThat(loaded.presence(Set.of("returned", "p2", "late"), NOW)).isTrue();
    assertThat(loaded.players.get(1).away).isTrue();
    assertThat(loaded.players.get(1).active).isTrue();
    loaded.tick(loaded.deadline);
    assertThat(loaded.totalSteps).isEqualTo(3);
    assertThat(loaded.phase).isEqualTo("describing");
  }

  @Test
  void classicDeadlinesFinishMatchAndRestartRotatesIdentity() {
    var game = game("classic", 2);
    game.configure("rounds", 2L, NOW);
    game.start(NOW);
    String firstId = game.gameId;
    for (int i = 0; i < 12; i++) assertThat(game.tick(game.deadline)).isTrue();
    assertThat(game.phase).isEqualTo("finished");
    assertThat(game.deadline).isZero();
    long previousToken = game.turnToken;
    game.start(NOW + 1_000_000);
    assertThat(game.gameId).isNotEqualTo(firstId);
    assertThat(game.turnToken).isGreaterThan(previousToken);
    assertThatThrownBy(() -> game.choose("p0", 0, previousToken, NOW + 1_000_001))
        .isInstanceOf(Problem.class);
  }

  @Test
  void departedClassicDrawerEndsTurnAndNoPlayersEndsGame() {
    var game = game("classic", 2);
    game.start(NOW);
    game.choose("p0", 0, game.turnToken, NOW);
    game.leave("p0", NOW + 1000);
    assertThat(game.phase).isEqualTo("round-reveal");
    game.leave("p1", NOW + 1000);
    assertThat(game.phase).isEqualTo("finished");
    assertThat(game.playing()).isFalse();
  }

  @Test
  void lateJoinParticipatesInNextMatchAndExplicitLeaverDoesNot() {
    var game = game("classic", 2);
    game.start(NOW);
    game.join("late", "Следующий", NOW);
    assertThat(game.view("late", NOW).you().playing()).isFalse();
    game.leave("p1", NOW);
    assertThat(game.view("p1", NOW).you()).isNull();
    game.tick(NOW + 1_000_000);
    assertThat(game.phase).isEqualTo("finished");
    game.start(NOW + 1_000_001);
    assertThat(game.roster).containsExactly("p0", "late");
  }

  @Test
  void oversizedSegmentsPointBudgetAndMixedValidInvalidBatchesAreAtomic() {
    var game = game("classic", 2);
    game.start(NOW);
    game.choose("p0", 0, game.turnToken, NOW);
    String points = "[1,2],".repeat(127) + "[1,2]";
    String segment =
        "{\"strokes\":[{\"id\":\"long\",\"color\":\"#ffffff\",\"width\":1,\"points\":["
            + points
            + "]}]}";
    for (int i = 0; i < 31; i++)
      game.draw("p0", segment.replace("long", "long" + i), game.turnToken, NOW);
    assertThatThrownBy(() -> game.draw("p0", segment, game.turnToken, NOW))
        .isInstanceOf(Problem.class);
    assertThat(game.drawing.points).isEqualTo(3968);
    String oversized = segment.replace("[1,2]]", "[1,2],[1,2]]");
    assertThatThrownBy(() -> game.draw("p0", oversized, game.turnToken, NOW))
        .isInstanceOf(Problem.class);
    String valid = stroke("valid");
    String invalid = stroke("invalid").replace("[500,500]", "[500.1,500]");
    String combined =
        "{\"strokes\":["
            + valid.substring(12, valid.length() - 2)
            + ","
            + invalid.substring(12, invalid.length() - 2)
            + "]}";
    assertThatThrownBy(() -> game.draw("p0", combined, game.turnToken, NOW))
        .isInstanceOf(Problem.class);
    assertThat(game.view("p1", NOW).canvas()).hasSize(31);
    assertThatThrownBy(() -> game.draw("p0", stroke("extra") + "{}", game.turnToken, NOW))
        .isInstanceOf(Problem.class);
  }

  @Test
  void expiredPhaseRejectsCommandsWithoutChangingTheDrawer() {
    var game = game("classic", 2);
    game.start(NOW);
    game.presence(Set.of("p0", "p1"), NOW);
    assertThat(game.players.getFirst().active).isTrue();
    assertThat(game.phase).isEqualTo("choosing");
    assertThatThrownBy(() -> game.choose("p0", 0, game.turnToken, game.deadline))
        .isInstanceOf(Problem.class);
    game.tick(game.deadline);
    assertThat(game.phase).isEqualTo("drawing");
    assertThat(game.view("p0", NOW).you().prompt()).isNotBlank();
  }

  @Test
  void roomDepartureSkipsCurrentTaskWhileKeepingIdentityForReturn() {
    var classic = game("classic", 3);
    classic.start(NOW);
    classic.presence(Set.of("p1", "p2"), NOW);
    assertThat(classic.phase).isEqualTo("round-reveal");
    assertThat(classic.players.getFirst().active).isTrue();
    classic.tick(classic.deadline);
    assertThat(classic.drawerId).isEqualTo("p1");
    classic.presence(Set.of("p0", "p1", "p2"), NOW);
    assertThat(classic.players.getFirst().away).isFalse();

    var phone = game("telephone", 3);
    phone.start(NOW);
    phone.presence(Set.of("p0", "p2"), NOW);
    phone.submit("p0", "Кот", phone.turnToken, NOW);
    phone.submit("p2", "Дом", phone.turnToken, NOW);
    assertThat(phone.phase).isEqualTo("drawing");
    assertThat(phone.players.get(1).submitted).isTrue();
    phone.presence(Set.of("p0", "p1", "p2"), NOW);
    phone.submit("p0", null, phone.turnToken, NOW);
    phone.submit("p2", null, phone.turnToken, NOW);
    assertThat(phone.phase).isEqualTo("describing");
    assertThat(phone.view("p1", NOW).you().canSubmit()).isTrue();
  }

  @Test
  void maxTelephoneMatchCompletesAfterDowntimeWithoutExposingUnselectedAlbums() {
    var game = game("telephone", 10);
    game.start(NOW);
    game.tick(NOW + 2_000_000);
    var view = game.view("spectator", NOW + 2_000_000);
    assertThat(view.phase()).isEqualTo("reveal");
    assertThat(view.albums()).hasSize(10).allSatisfy(a -> assertThat(a.entries()).isEqualTo(10));
    assertThat(view.revealed().step()).isZero();
    long token = game.turnToken;
    game.reveal(9, 9, token, NOW + 2_000_000);
    assertThatThrownBy(() -> game.reveal(0, 0, token, NOW + 2_000_000)).isInstanceOf(Problem.class);
    assertThat(game.view("spectator", NOW).revealed().step()).isEqualTo(9);
  }

  @Test
  void idleDrawingEmitsEachHintOnceWithoutChangingDeadlineOrTurnToken() {
    var game = game("classic", 2);
    game.start(NOW);
    game.choose("p0", 0, game.turnToken, NOW);
    game.word = "воздушный шар";
    long token = game.turnToken;
    long deadline = game.deadline;
    assertThat(game.tick(NOW + 29_999)).isFalse();
    assertThat(game.tick(NOW + 30_000)).isTrue();
    assertThat(game.view("p1", NOW + 30_000).hint()).isEqualTo("в________ ___");
    assertThat(game.tick(NOW + 30_001)).isFalse();
    assertThat(game.tick(NOW + 45_000)).isTrue();
    assertThat(game.view("p1", NOW + 45_000).hint()).isEqualTo("во_______ ___");
    assertThat(game.tick(NOW + 45_001)).isFalse();
    assertThat(game.turnToken).isEqualTo(token);
    assertThat(game.deadline).isEqualTo(deadline);
  }
}
