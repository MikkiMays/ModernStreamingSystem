package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;

import dev.mikki.stream.game.Cards;
import dev.mikki.stream.game.Durak;
import dev.mikki.stream.game.DurakView.DurakPlay;
import dev.mikki.stream.shared.Json;
import dev.mikki.stream.shared.Problem;
import java.util.ArrayList;
import java.util.Set;
import org.junit.jupiter.api.Test;

class DurakPauseTest {
  private static final long T0 = 1_700_000_000_000L;

  private Durak table() {
    var table = Durak.open("host", "perevodnoy", T0, 36);
    table.sit("p0", "Первый", 0, T0);
    table.sit("p1", "Второй", 1, T0);
    table.deal(T0);
    table.attacker = 0;
    table.defender = 1;
    table.boutNumber = 2;
    table.trumpSuit = 1;
    table.seats.get(0).hand = cards("6s", "9d", "Td");
    table.seats.get(1).hand = cards("7s", "6h", "8c");
    return table;
  }

  private static ArrayList<Integer> cards(String... names) {
    var result = new ArrayList<Integer>();
    for (var name : names)
      for (int card = 0; card < Cards.DECK; card++)
        if (Cards.text(card).equals(name)) result.add(card);
    return result;
  }

  private Durak defending() {
    var table = table();
    table.act("p0", "attack", "6s", null, T0 + 2000);
    return table;
  }

  @Test
  void pauseFreezesTurnAndRejectsMovesWithoutChangingAnyState() {
    var table = defending();
    long actionAt = table.actionAt;
    long deadline = table.deadline;
    long pauseAt = T0 + 9000;
    table.configure("pause", null, pauseAt);
    var frozen = Json.write(table);
    assertThat(table.tick(deadline + 100_000)).isFalse();
    assertThatThrownBy(() -> table.act("p1", "beat", "7s", "6s", deadline))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("паузе");
    assertThatThrownBy(() -> table.stand("p1", deadline)).isInstanceOf(Problem.class);
    assertThatThrownBy(() -> table.configure("turn", 15L, deadline)).isInstanceOf(Problem.class);
    assertThatThrownBy(() -> table.deal(deadline)).isInstanceOf(Problem.class);
    table.configure("pause", null, pauseAt + 1000);
    assertThat(Json.write(table)).isEqualTo(frozen);
    var view = table.view("p1", deadline);
    assertThat(view.paused()).isTrue();
    assertThat(view.pausedAt()).isEqualTo(pauseAt);
    assertThat(view.pausedRemaining()).isEqualTo(deadline - pauseAt);
    assertThat(view.deadline()).isZero();
    assertThat(view.acting()).containsExactly(1);
    assertThat(view.you().turn()).isFalse();
    assertThat(view.you().actions()).isEmpty();
    assertThat(view.you().plays()).isEmpty();
    assertThat(view.you().cards()).containsExactly("7s", "6h", "8c");
    table.configure("resume", null, pauseAt + 60_000);
    assertThat(table.actionAt).isEqualTo(actionAt + 60_000);
    assertThat(table.deadline).isEqualTo(deadline + 60_000);
    assertThat(table.view("p1", pauseAt + 60_000).you().turn()).isTrue();
    assertThat(table.tick(table.deadline - 1)).isFalse();
    assertThat(table.tick(table.deadline)).isTrue();
    assertThat(table.taking).isTrue();
  }

  @Test
  void pauseDuringDealPreservesFutureActionOriginAndTheWholeRemainingDeadline() {
    var table = table();
    long deadline = table.deadline;
    table.configure("pause", null, T0 + 200);
    table.configure("resume", null, T0 + 60_200);
    assertThat(table.dealtAt).isEqualTo(T0 + 60_000);
    assertThat(table.actionAt).isEqualTo(T0 + Durak.DEAL_MS + 60_000);
    assertThat(table.deadline).isEqualTo(deadline + 60_000);
    assertThat(table.tick(deadline + 59_999)).isFalse();
  }

  @Test
  void pauseDuringBoutSettlementKeepsCardsOnTableUntilTheExactResumedDeadline() {
    var table = defending();
    table.act("p1", "take", null, null, T0 + 3000);
    assertThat(table.boutEnd).isEqualTo("taken");
    long boutAt = table.boutAt;
    long deadline = table.deadline;
    table.configure("pause", null, boutAt + 300);
    assertThat(table.tick(deadline + 30_000)).isFalse();
    assertThat(table.attacks).hasSize(1);
    table.configure("resume", null, boutAt + 30_300);
    assertThat(table.boutAt).isEqualTo(boutAt + 30_000);
    assertThat(table.deadline).isEqualTo(deadline + 30_000);
    assertThat(table.tick(table.deadline - 1)).isFalse();
    assertThat(table.tick(table.deadline)).isTrue();
    assertThat(table.boutEnd).isNull();
    assertThat(table.attacks).isEmpty();
  }

  @Test
  void anAlreadyDueTurnDoesNotGetAFreeTurnOrStayStuckOnResume() {
    var table = defending();
    long deadline = table.deadline;
    table.configure("pause", null, deadline + 5);
    assertThat(table.pausedRemaining).isZero();
    table.configure("resume", null, deadline + 60_000);
    assertThat(table.deadline).isEqualTo(deadline + 60_000);
    assertThat(table.tick(table.deadline)).isTrue();
  }

  @Test
  void absenceDuringPauseDoesNotMoveOrConsumeTheAwayGracePeriod() {
    var table = defending();
    table.presence(Set.of("p0"), T0 + 3000);
    table.configure("pause", null, T0 + 4000);
    table.presence(Set.of("p0"), T0 + 120_000);
    assertThat(table.taking).isFalse();
    assertThat(table.deadline).isZero();
    assertThat(table.seats.get(1).hand).hasSize(3);
    table.configure("resume", null, T0 + 120_000);
    table.presence(Set.of("p0"), T0 + 121_999);
    assertThat(table.taking).isFalse();
    table.presence(Set.of("p0"), T0 + 122_001);
    assertThat(table.taking).isTrue();
  }

  @Test
  void newlyAwayAndRejoiningPlayersPreserveThePersistedPause() {
    var table = defending();
    table.hostId = "p1";
    table.configure("pause", null, T0 + 3000);
    table.presence(Set.of("p0"), T0 + 8000);
    var restored = Json.read(Json.write(table), Durak.class);
    assertThat(restored.tick(T0 + 120_000)).isFalse();
    assertThat(restored.rebind("p1", "p1-new", "Вернулся")).isTrue();
    assertThat(restored.hostId).isEqualTo("p1-new");
    assertThat(restored.paused).isTrue();
    assertThat(restored.view("p1-new", T0 + 120_000).you().cards()).hasSize(3);
    restored.configure("resume", null, T0 + 120_000);
    assertThat(restored.deadline).isEqualTo(T0 + 120_000 + table.pausedRemaining);
  }

  @Test
  void anUnseatedIntegrationHostCanRecoverAndResume() {
    var table = defending();
    table.configure("pause", null, T0 + 3000);
    assertThat(table.rebind("host", "host-new", "Ведущий")).isTrue();
    assertThat(table.hostId).isEqualTo("host-new");
    assertThat(table.paused).isTrue();
    assertThat(table.view("host-new", T0 + 4000).you()).isNull();
  }

  @Test
  void resumeIsIdempotentAndPausingALobbyIsRejected() {
    var table = defending();
    var before = Json.write(table);
    table.configure("resume", null, T0 + 3000);
    assertThat(Json.write(table)).isEqualTo(before);
    var lobby = Durak.open("host", "podkidnoy", T0, 36);
    assertThatThrownBy(() -> lobby.configure("pause", null, T0 + 3000))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("не идёт");
    assertThat(lobby.paused).isFalse();
    var legacy = Json.read("{\"phase\":\"lobby\"}", Durak.class);
    assertThat(legacy.paused).isFalse();
    assertThat(legacy.pausedAt).isZero();
  }

  @Test
  void privateChoicesDistinguishBeatAndTransferAndMatchAcceptedMoves() {
    var table = defending();
    var before = Json.write(table);
    var view = table.view("p1", T0 + 3000);
    assertThat(view.you().plays())
        .containsExactlyInAnyOrder(
            new DurakPlay("7s", "beat", "6s"),
            new DurakPlay("6h", "beat", "6s"),
            new DurakPlay("6h", "transfer", null));
    assertThat(table.view("spectator", T0 + 3000).you()).isNull();
    assertThat(table.view("p0", T0 + 3000).you().plays()).isEmpty();
    assertThat(Json.write(table)).isEqualTo(before);
    for (var play : view.you().plays()) {
      var copy = Json.read(before, Durak.class);
      assertThatCode(() -> copy.act("p1", play.option(), play.card(), play.under(), T0 + 3000))
          .doesNotThrowAnyException();
    }
    table.act("p1", "beat", "7s", "6s", T0 + 3000);
    assertThat(table.view("p1", T0 + 3000).you().plays()).isEmpty();
    assertThatThrownBy(() -> table.act("p1", "transfer", "6h", null, T0 + 3001))
        .isInstanceOf(Problem.class);
  }
}
