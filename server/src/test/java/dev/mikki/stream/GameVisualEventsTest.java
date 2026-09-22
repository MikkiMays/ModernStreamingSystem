package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.mikki.stream.game.Cards;
import dev.mikki.stream.game.Durak;
import dev.mikki.stream.game.GameVisualEvent;
import dev.mikki.stream.game.Table;
import dev.mikki.stream.shared.Problem;
import java.util.List;
import org.junit.jupiter.api.Test;

class GameVisualEventsTest {
  private static final long NOW = 1_700_000_000_000L;

  private Durak durak() {
    var game = Durak.open("p0", "podkidnoy", NOW, 36);
    game.sit("p0", "First", 0, NOW);
    game.sit("p3", "Second", 3, NOW);
    return game;
  }

  @Test
  void dealEventsFollowSparseSeatsAndNeverContainPrivateCards() {
    var game = durak();
    game.deal(NOW);
    var events = game.view(null, NOW).visualEvents();
    assertThat(events).hasSize(12);
    assertThat(events)
        .extracting(GameVisualEvent::toSeat)
        .containsExactly(0, 3, 0, 3, 0, 3, 0, 3, 0, 3, 0, 3);
    assertThat(events)
        .allSatisfy(
            event -> {
              assertThat(event.cards()).isEmpty();
              assertThat(event.type()).isEqualTo("deal");
              assertThat(event.count()).isEqualTo(1);
              assertThat(event.at()).isEqualTo(NOW);
            });
    assertThat(events).extracting(GameVisualEvent::id).isSorted().doesNotHaveDuplicates();
    assertThat(game.view("p0", NOW).visualEvents()).isEqualTo(events);
    assertThat(game.view("p3", NOW).visualEvents()).isEqualTo(events);
  }

  @Test
  void pokerDealsAlsoHideBothHandsFromEveryViewer() {
    var game = Table.open("p0", "friendly", NOW);
    game.sit("p0", "First", 0, NOW);
    game.sit("p3", "Second", 3, NOW);
    game.deal(NOW);
    var events = game.view(null, NOW).visualEvents();
    assertThat(events).hasSize(4);
    assertThat(events).allSatisfy(event -> assertThat(event.cards()).isEmpty());
    assertThat(game.view("p0", NOW).visualEvents()).isEqualTo(events);
  }

  @Test
  void takeThenRefillEmitsOnlyPublicPlayedCardsAndHiddenDrawsInOrder() {
    var game = durak();
    game.deal(NOW);
    int attacker = game.attacker;
    int defender = game.defender;
    var attack = Cards.text(game.seats.get(attacker).hand.getFirst());
    game.act("p" + attacker, "attack", attack, null, NOW + 2000);
    game.act("p" + defender, "take", null, null, NOW + 2100);
    if (game.boutEnd == null) game.act("p" + attacker, "pass", null, null, NOW + 2200);
    assertThat(game.visualEvents.getLast().type()).isEqualTo("take");
    assertThat(game.visualEvents.getLast().toSeat()).isEqualTo(defender);
    game.tick(game.deadline);
    var events = game.view(null, NOW + 5000).visualEvents().subList(12, game.visualEvents.size());
    assertThat(events).extracting(GameVisualEvent::type).containsExactly("play", "take", "draw");
    assertThat(events.get(0).cards()).containsExactly(attack);
    assertThat(events.get(1).cards()).containsExactly(attack);
    assertThat(events.get(2).cards()).isEmpty();
    assertThat(events.get(2).toSeat()).isEqualTo(attacker);
    assertThat(events).extracting(GameVisualEvent::at).isSorted();
  }

  @Test
  void failedMoveDoesNotCreateEventAndLeavingNeverPublishesPrivateCards() {
    var game = durak();
    game.deal(NOW);
    var before = List.copyOf(game.visualEvents);
    assertThatThrownBy(() -> game.act("spectator", "attack", "As", null, NOW + 2000))
        .isInstanceOf(Problem.class);
    assertThat(game.visualEvents).isEqualTo(before);
    game.stand("p0", NOW + 3000);
    assertThat(game.visualEvents.getLast().type()).isEqualTo("discard");
    assertThat(game.visualEvents.getLast().count()).isEqualTo(6);
    assertThat(game.visualEvents.getLast().cards()).isEmpty();
  }

  @Test
  void previousSnapshotsDefaultToEmptyAdditiveCollections() throws Exception {
    var mapper = new ObjectMapper();
    var original = mapper.valueToTree(durak());
    ((com.fasterxml.jackson.databind.node.ObjectNode) original)
        .remove(List.of("visualEvents", "visualSequence", "reactions", "reactionSequence"));
    var restored = mapper.treeToValue(original, Durak.class);
    assertThat(restored.view(null, NOW).visualEvents()).isEmpty();
    assertThat(restored.view(null, NOW).reactions()).isEmpty();
    restored.react("p0", "durak-online-01", NOW);
    restored.deal(NOW);
    assertThat(restored.visualEvents.getFirst().id()).isEqualTo(1);
  }

  private int card(String value) {
    return "23456789TJQKA".indexOf(value.charAt(0)) * 4 + "shdc".indexOf(value.charAt(1));
  }

  @Test
  void defenceAndDiscardPublishOnlyTheBoardAndRefillInRuleOrder() {
    var game = durak();
    game.deal(NOW);
    game.attacker = 0;
    game.defender = 3;
    game.seats.get(0).hand = new java.util.ArrayList<>(List.of(card("6s"), card("8h")));
    game.seats.get(3).hand = new java.util.ArrayList<>(List.of(card("7s"), card("9h")));
    game.trumpSuit = 1;
    game.act("p0", "attack", "6s", null, NOW + 2000);
    game.act("p3", "beat", "7s", "6s", NOW + 2100);
    assertThat(game.boutEnd).isEqualTo("beaten");
    var discarded = game.visualEvents.getLast();
    assertThat(discarded.type()).isEqualTo("discard");
    assertThat(discarded.cards()).containsExactly("6s", "7s");
    assertThat(discarded.count()).isEqualTo(2);
    game.tick(game.deadline);
    var draws = game.visualEvents.stream().filter(event -> event.type().equals("draw")).toList();
    assertThat(draws)
        .extracting(GameVisualEvent::toSeat)
        .containsExactly(0, 0, 0, 0, 0, 3, 3, 3, 3, 3);
    assertThat(draws).allSatisfy(event -> assertThat(event.cards()).isEmpty());
  }

  @Test
  void pokerBoardEventsNeverExposeBurnCardsAndFoldEventsNeverExposeHands() {
    var game = Table.open("p0", "friendly", NOW);
    game.sit("p0", "First", 0, NOW);
    game.sit("p1", "Second", 1, NOW);
    game.deal(NOW);
    long at = NOW + 5000;
    while (game.phase.equals("preflop")) {
      int actor = game.actor;
      var seat = game.seats.get(actor);
      game.act("p" + actor, seat.bet < game.betToCall ? "call" : "check", 0, at++);
    }
    var draws = game.visualEvents.stream().filter(event -> event.type().equals("draw")).toList();
    assertThat(draws).hasSize(3);
    assertThat(draws.stream().flatMap(event -> event.cards().stream()).toList())
        .containsExactlyElementsOf(Cards.texts(game.board))
        .doesNotContainAnyElementsOf(Cards.texts(game.burned));
    game.act("p" + game.actor, "fold", 0, at);
    var fold = game.visualEvents.stream().filter(event -> event.type().equals("discard")).toList();
    assertThat(fold)
        .singleElement()
        .satisfies(
            event -> {
              assertThat(event.count()).isEqualTo(2);
              assertThat(event.cards()).isEmpty();
            });
  }

  @Test
  void reactionsRequireASeatValidateCatalogAndRespectExactCooldownAndExpiry() {
    var game = durak();
    assertThatThrownBy(() -> game.react("spectator", "durak-online-01", NOW))
        .isInstanceOf(Problem.class);
    for (String invalid : List.of("durak-online-00", "durak-online-55", "https://x/image", "01"))
      assertThatThrownBy(() -> game.react("p0", invalid, NOW)).isInstanceOf(Problem.class);
    game.react("p0", "durak-online-01", NOW);
    assertThatThrownBy(() -> game.react("p0", "durak-online-02", NOW + 1499))
        .isInstanceOf(Problem.class);
    game.react("p3", "durak-online-54", NOW);
    assertThat(game.view(null, NOW + 2499).reactions()).hasSize(2);
    assertThat(game.view(null, NOW + 2500).reactions()).isEmpty();
    game.react("p0", "durak-online-02", NOW + 1500);
    assertThat(game.view(null, NOW + 2500).reactions())
        .singleElement()
        .satisfies(reaction -> assertThat(reaction.stickerId()).isEqualTo("durak-online-02"));
  }

  @Test
  void recoveryPreservesEventOrderAndReactionCooldownIncludingMemberRebind() throws Exception {
    var game = durak();
    game.deal(NOW);
    game.react("p0", "durak-online-01", NOW);
    var mapper = new ObjectMapper();
    var restored = mapper.readValue(mapper.writeValueAsBytes(game), Durak.class);
    assertThat(restored.view(null, NOW).visualEvents())
        .isEqualTo(game.view(null, NOW).visualEvents());
    restored.rebind("p0", "p-new", "First");
    assertThatThrownBy(() -> restored.react("p-new", "durak-online-02", NOW + 1499))
        .isInstanceOf(Problem.class);
    restored.react("p-new", "durak-online-02", NOW + 1500);
    assertThat(restored.view(null, NOW + 1500).reactions().getFirst().id()).isGreaterThan(1);
  }

  @Test
  void visualHistoryIsBoundedAndCountersNeverResetBetweenHands() {
    var game = durak();
    for (int round = 0; round < 20; round++) {
      game.phase = "lobby";
      game.deal(NOW + round * 10000L);
    }
    var events = game.view(null, NOW + 200000).visualEvents();
    assertThat(events).hasSize(128);
    assertThat(events.getLast().id()).isEqualTo(240);
    assertThat(events).extracting(GameVisualEvent::id).isSorted().doesNotHaveDuplicates();
  }
}
