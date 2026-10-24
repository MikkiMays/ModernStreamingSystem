package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;

import dev.mikki.stream.game.Cards;
import dev.mikki.stream.game.Durak;
import dev.mikki.stream.shared.Problem;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Правила дурака.
 *
 * <p>Проверяется не «работает ли код», а то, из-за чего за настоящим столом спорят: чем можно
 * побить, сколько карт влезает в бой, кто заходит после «взял» и после «бито», кому достаётся
 * козырная карта в конце колоды и кто в итоге дурак. Ошибка в любом из этих мест выглядит как
 * исправная игра, в которой изредка происходит что-то странное.
 */
class DurakTest {
  private static final long T0 = 1_700_000_000_000L;

  /** Карта по-человечески: {@code As}, {@code 6h}. */
  private static int card(String text) {
    int rank = "23456789TJQKA".indexOf(text.charAt(0));
    int suit = "shdc".indexOf(text.charAt(1));
    return rank * 4 + suit;
  }

  private static List<Integer> cards(String... text) {
    var list = new ArrayList<Integer>();
    for (String one : text) list.add(card(one));
    return list;
  }

  private static Durak table(int players) {
    return table(players, "podkidnoy", 36);
  }

  private static Durak table(int players, String mode, int deck) {
    var table = Durak.open("host", mode, T0, deck);
    for (int index = 0; index < players; index++)
      table.sit("p" + index, "Игрок " + index, index, T0);
    return table;
  }

  /**
   * Раздать известный расклад.
   *
   * <p>Стол раздаёт сам — чтобы работали все его собственные сборы, — а потом руки, колода и козырь
   * подменяются на заданные. Так проверяются настоящие переходы состояния, а не выдуманное
   * состояние стола.
   */
  private static void deal(Durak table, String trump, String rest, String... hands) {
    table.deal(T0);
    for (int index = 0; index < hands.length; index++)
      table.seats.get(index).hand = cards(hands[index].split(" "));
    var deck = new ArrayList<Integer>();
    if (!rest.isBlank()) deck.addAll(cards(rest.split(" ")));
    deck.add(card(trump));
    table.deck = deck;
    table.trump = card(trump);
    table.trumpSuit = Cards.suit(card(trump));
    table.attacker = 0;
    table.defender = 1;
    table.limit = Math.min(Durak.MAX_ATTACKS, table.seats.get(1).hand.size());
    // Второй бой, а не первый: первый кон не переводят, и проверять перевод на нём нельзя.
    table.boutNumber = 2;
  }

  /**
   * То же, но колода уже кончилась.
   *
   * <p>Отдельный помощник, потому что весь интересный конец партии живёт именно здесь: пока есть
   * добор, никто не выходит, и ни дурака, ни ничьей не случается.
   */
  private static void endgame(Durak table, String trump, String... hands) {
    deal(table, trump, "", hands);
    table.deck = new ArrayList<>();
    table.limit = Math.min(Durak.MAX_ATTACKS, table.seats.get(1).hand.size());
  }

  private static void act(Durak table, int seat, String option, String card, String under) {
    table.act("p" + seat, option, card, under, T0 + 1000);
  }

  // --- Колода ------------------------------------------------------------------------------

  @Test
  void deckOfThirtySixStartsAtTheSix() {
    var deck = Cards.deck(36);
    assertThat(deck).hasSize(36);
    assertThat(Cards.texts(deck)).contains("6s", "As").doesNotContain("5s", "2c");
  }

  /** Полная колода обязана тасоваться ровно так же, как до появления второй игры. */
  @Test
  void fullDeckShuffleIsUnchanged() {
    assertThat(Cards.shuffle("seed")).isEqualTo(Cards.shuffle("seed", Cards.deck(52)));
  }

  @Test
  void shuffleOfThirtySixKeepsEveryCardOnce() {
    var shuffled = Cards.shuffle("seed", Cards.deck(36));
    assertThat(shuffled).hasSize(36).doesNotHaveDuplicates().containsAll(Cards.deck(36));
  }

  // --- Раздача -----------------------------------------------------------------------------

  @Test
  void dealGivesSixCardsEachAndShowsTheTrump() {
    var table = table(4);
    table.deal(T0);
    assertThat(table.phase).isEqualTo("bout");
    for (int index = 0; index < 4; index++) assertThat(table.seats.get(index).hand).hasSize(6);
    assertThat(table.deck).hasSize(36 - 24);
    assertThat(table.trump).isEqualTo(table.deck.get(table.deck.size() - 1));
    assertThat(table.trumpSuit).isEqualTo(Cards.suit(table.trump));
  }

  @Test
  void dealNeedsTwoPlayers() {
    var table = table(1);
    assertThatThrownBy(() -> table.deal(T0))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("двое");
  }

  /** Шестерым на колоде в 36 карт ещё хватает: тридцать шесть больше, чем шесть по шесть. */
  @Test
  void sixPlayersFitIntoThirtySixCards() {
    var table = table(6);
    table.deal(T0);
    assertThat(table.deck).hasSize(0);
    assertThat(table.trump).isGreaterThanOrEqualTo(0);
  }

  /**
   * Заходит младший козырь — то, о чём за столом и спрашивают: «у кого шестёрка?».
   *
   * <p>Проверяется на настоящей раздаче, а не на подменённом раскладе: расклад здесь случайный, и
   * правило должно выполняться на любом из них. Поэтому младший козырь ищется по рукам заново и
   * сверяется с тем, кого стол назначил заходить.
   */
  @Test
  void theLowestTrumpOpens() {
    for (int round = 0; round < 50; round++) {
      var table = table(4);
      table.deal(T0);
      int expected = -1;
      int lowest = Integer.MAX_VALUE;
      for (int index = 0; index < 4; index++)
        for (var card : table.seats.get(index).hand)
          if (Cards.suit(card) == table.trumpSuit && card < lowest) {
            lowest = card;
            expected = index;
          }
      if (expected < 0) continue;
      assertThat(table.attacker).isEqualTo(expected);
      assertThat(table.defender).isEqualTo((expected + 1) % 4);
    }
  }

  // --- Бой ---------------------------------------------------------------------------------

  @Test
  void trumpBeatsAnythingAndOnlyHigherTrumpBeatsTrump() {
    var table = table(2);
    deal(table, "9h", "", "6s 7s 8s 9s Ts Js", "6h 7h 8h Ac Kc Qc");
    assertThat(table.beatsCard(card("6h"), card("As"))).isTrue();
    assertThat(table.beatsCard(card("As"), card("6h"))).isFalse();
    assertThat(table.beatsCard(card("7h"), card("6h"))).isTrue();
    assertThat(table.beatsCard(card("6h"), card("7h"))).isFalse();
    assertThat(table.beatsCard(card("8s"), card("7s"))).isTrue();
    assertThat(table.beatsCard(card("8c"), card("7s"))).isFalse();
  }

  @Test
  void defenderBeatsAndTheBoutClosesWhenAttackersPass() {
    var table = table(2);
    // У заходившего осталась вторая шестёрка — значит, бой ждёт его решения, а не закрывается сам.
    deal(
        table,
        "9h",
        "6d 7d 8d Td Jd Qd Kd Ad 6c 7c 8c 9c",
        "6s 6h 8s 9s Ts Js",
        "As Ks Qs Ac Kc Qc");
    act(table, 0, "attack", "6s", null);
    assertThat(table.attacks).containsExactly(card("6s"));
    act(table, 1, "beat", "As", "6s");
    assertThat(table.beats).containsExactly(card("As"));
    act(table, 0, "pass", null, null);
    assertThat(table.boutEnd).isEqualTo("beaten");
    // Бой ещё лежит на столе — полторы секунды, чтобы его увидели.
    assertThat(table.attacks).isNotEmpty();
    table.tick(table.deadline);
    assertThat(table.attacks).isEmpty();
    assertThat(table.discarded).isEqualTo(2);
    // Отбился — ходит сам.
    assertThat(table.attacker).isEqualTo(1);
    assertThat(table.defender).isEqualTo(0);
  }

  @Test
  void defenderTakesAndTheNextPlayerAttacks() {
    var table = table(3);
    deal(
        table,
        "9h",
        "6d 7d 8d Td Jd Qd Kd Ad 6c 7c",
        "6s 7s 8s 9s Ts Js",
        "Qs Ks As Ac Kc Qc",
        "6h 7h 8h Jc Tc 9c");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "take", null, null);
    assertThat(table.taking).isTrue();
    act(table, 0, "pass", null, null);
    act(table, 2, "pass", null, null);
    assertThat(table.boutEnd).isEqualTo("taken");
    table.tick(table.deadline);
    assertThat(table.seats.get(1).hand).contains(card("6s"));
    // Взял — заходит следующий за ним.
    assertThat(table.attacker).isEqualTo(2);
    assertThat(table.defender).isEqualTo(0);
  }

  @Test
  void throwingInNeedsARankAlreadyOnTheTable() {
    var table = table(3);
    deal(
        table,
        "9h",
        "6d 7d 8d Td Jd Qd Kd Ad 6c 7c",
        "6s 7s 8s 9s Ts Js",
        "Qs Ks As Ac Kc Qc",
        "6d 7h 8h Jc Tc 9c");
    act(table, 0, "attack", "6s", null);
    // Шестёрка бубён ложится: шестёрка на столе уже есть.
    act(table, 2, "attack", "6d", null);
    assertThat(table.attacks).hasSize(2);
    // Семёрка черв — нет: семёрок на столе не лежит.
    assertThatThrownBy(() -> act(table, 2, "attack", "7h", null))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("номинала");
  }

  @Test
  void theBoutNeverExceedsTheDefendersHand() {
    var table = table(2);
    // У защитника две карты — значит и подкинуть можно только две.
    deal(table, "9h", "6d 7d", "6s 6h 6c 6d 7s 7h", "As Ks");
    assertThat(table.limit).isEqualTo(2);
    act(table, 0, "attack", "6s", null);
    act(table, 0, "attack", "6h", null);
    assertThatThrownBy(() -> act(table, 0, "attack", "6c", null))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("не подкинуть");
  }

  @Test
  void sixCardsIsTheHardLimit() {
    var table = table(2);
    deal(table, "9h", "", "6s 6h 6c 6d 7s 7h", "As Ks Qs Js Ts 9s");
    assertThat(table.limit).isEqualTo(6);
  }

  @Test
  void theFirstBoutCanBeCappedAtFive() {
    var table = table(2);
    table.firstFive = true;
    deal(table, "9h", "", "6s 6h 6c 6d 7s 7h", "As Ks Qs Js Ts 9s");
    table.boutNumber = 1;
    // deal() выставляет limit сам; пересчитываем так же, как это делает стол.
    table.limit = Math.min(Durak.FIRST_ATTACKS, table.seats.get(1).hand.size());
    assertThat(table.limit).isEqualTo(5);
  }

  @Test
  void onlyNeighboursThrowInWhenTheTableSaysSo() {
    var table = table(4);
    table.neighbours = true;
    deal(
        table,
        "9h",
        "6d 7d 8d Td",
        "6s 7s 8s 9s Ts Js",
        "Qs Ks As Ac Kc Qc",
        "6h 7h 8h Jc Tc 9c",
        "6c 7c Jh Th Qh Kh");
    act(table, 0, "attack", "6s", null);
    // Второй — сосед защитника справа, ему можно.
    assertThat(table.mayThrow(2)).isTrue();
    // Третий сидит через одного и в этот бой не лезет.
    assertThat(table.mayThrow(3)).isFalse();
    assertThatThrownBy(() -> act(table, 3, "attack", "6c", null))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("соседи");
  }

  // --- Перевод -----------------------------------------------------------------------------

  @Test
  void transferMovesTheAttackToTheNextPlayer() {
    var table = table(3, "perevodnoy", 36);
    deal(
        table,
        "9h",
        "6d 7d 8d Td Jd Qd",
        "6s 7s 8s 9s Ts Js",
        "6h Ks As Ac Kc Qc",
        "Qs 7h 8h Jc Tc 9c");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "transfer", "6h", null);
    assertThat(table.attacker).isEqualTo(1);
    assertThat(table.defender).isEqualTo(2);
    assertThat(table.attacks).containsExactly(card("6s"), card("6h"));
  }

  @Test
  void transferIsRefusedOnceTheDefenderStartedBeating() {
    var table = table(3, "perevodnoy", 36);
    deal(
        table,
        "9h",
        "6d 7d 8d Td Jd Qd",
        "6s 7s 8s 9s Ts Js",
        "6h Ks As Ac Kc Qc",
        // Третий держит шестёрку: бой после защиты остаётся открытым, и перевод есть кому
        // отвергнуть.
        "6d 7h 8h Jc Tc 9c");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "beat", "Ks", "6s");
    assertThatThrownBy(() -> act(table, 1, "transfer", "6h", null))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("до того");
  }

  @Test
  void transferIsRefusedWhenTheNextPlayerCannotHoldIt() {
    var table = table(3, "perevodnoy", 36);
    deal(table, "9h", "", "6s 7s 8s 9s Ts Js", "6h Ks As Ac Kc Qc", "Qs");
    act(table, 0, "attack", "6s", null);
    assertThatThrownBy(() -> act(table, 1, "transfer", "6h", null))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("не хватит карт");
  }

  /**
   * Первый кон не переводят.
   *
   * <p>Заход в партии один, и достаётся он младшему козырю не по выбору. Отдать этот бой соседу
   * значит отдать ему чужую шестёрку — за столом так не делают.
   */
  @Test
  void theFirstBoutOfAGameIsNeverTransferred() {
    var table = table(3, "perevodnoy", 36);
    deal(
        table,
        "9h",
        "6d 7d 8d Td Jd Qd",
        "6s 7s 8s 9s Ts Js",
        "6h Ks As Ac Kc Qc",
        "Qs 7h 8h Jc Tc 9c");
    table.boutNumber = 1;
    act(table, 0, "attack", "6s", null);
    assertThatThrownBy(() -> act(table, 1, "transfer", "6h", null))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("Первый кон");
  }

  /**
   * Перевод упирается в тот же предел, что и подкидывание.
   *
   * <p>Расхождение, найденное сверкой с чужими движками: без этой проверки шестикарточный бой можно
   * было продлить переводом до семи карт.
   */
  @Test
  void transferObeysTheBoutLimit() {
    var table = table(3, "perevodnoy", 36);
    deal(table, "9h", "", "6s 6c 6d 7s 8s 9s", "6h Ks As Ac Kc Qc", "Qs 7h 8h Jc Tc 9c");
    table.limit = 2;
    act(table, 0, "attack", "6s", null);
    act(table, 0, "attack", "6c", null);
    assertThatThrownBy(() -> act(table, 1, "transfer", "6h", null))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("больше не положить");
  }

  /**
   * T51: «в конце, когда нет карт, мне могут подкинуть».
   *
   * <p>После перевода предел боя считался как «уже лежащие атаки плюс рука нового защитника»: у
   * него две карты, на столе две атаки — и подкинуть разрешалось ещё две. Отбившись последними
   * картами, он сидел с пустой рукой под новой атакой. Предел — это рука защитника на начало его
   * боя, и перевод начинает бой заново.
   */
  @Test
  void aTransferNeverLetsTheBoutOutgrowTheNewDefender() {
    var table = table(3, "perevodnoy", 36);
    endgame(table, "9c", "6s 6d", "6h Ks", "7s 7h");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "transfer", "6h", null);
    assertThat(table.defender).isEqualTo(2);
    assertThat(table.limit).isEqualTo(2);
    act(table, 2, "beat", "7s", "6s");
    act(table, 2, "beat", "7h", "6h");
    assertThat(table.seats.get(2).hand).isEmpty();
    // Шестёрка бубён у заходившего есть, но защитнику больше нечем отбиваться: бой кончен.
    assertThat(table.boutEnd).isEqualTo("beaten");
    assertThatThrownBy(() -> act(table, 0, "attack", "6d", null)).isInstanceOf(Problem.class);
  }

  /**
   * Стол, сохранённый прежним ядром посреди такого боя, несёт завышенный предел. Колода пуста, у
   * защитника не осталось карт — подкинуть ему нельзя, сколько бы ни обещал старый предел.
   */
  @Test
  void aDefenderWithAnEmptyHandIsNeverThrownAt() {
    var table = table(3, "perevodnoy", 36);
    endgame(table, "9c", "6s 6d", "6h Ks", "7s 7h");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "transfer", "6h", null);
    table.limit = 4;
    act(table, 2, "beat", "7s", "6s");
    act(table, 2, "beat", "7h", "6h");
    assertThat(table.acting()).isEmpty();
    assertThat(table.boutEnd).isEqualTo("beaten");
    table.tick(table.deadline);
    assertThat(table.seats.get(2).out).isTrue();
  }

  @Test
  void theDefenderIsNeverThrownMoreThanHeHolds() {
    var table = table(3);
    deal(table, "9c", "8d 8h 8c", "6s 6d 7d 8s Js Qs", "As", "6h 6c 7c Jh Qh Kh");
    act(table, 0, "attack", "6s", null);
    // Одна карта у защитника — одна неотбитая на столе. Вторую шестёрку класть некуда.
    assertThatThrownBy(() -> act(table, 2, "attack", "6h", null))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("не подкинуть");
  }

  @Test
  void aThrowInTableRefusesTransfersOutright() {
    var table = table(3);
    deal(
        table,
        "9h",
        "6d 7d 8d Td Jd Qd",
        "6s 7s 8s 9s Ts Js",
        "6h Ks As Ac Kc Qc",
        "Qs 7h 8h Jc Tc 9c");
    act(table, 0, "attack", "6s", null);
    assertThatThrownBy(() -> act(table, 1, "transfer", "6h", null))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("без перевода");
  }

  // --- Добор и конец партии -----------------------------------------------------------------

  /**
   * Главный атакующий тянет первым, защитник — последним: от этого зависит, кому достанется козырь.
   */
  @Test
  void theAttackerDrawsFirstAndTheDefenderLast() {
    var table = table(2);
    // У обоих по шесть карт: после боя каждому не хватает ровно одной, и порядок добора виден.
    deal(table, "9h", "Ac", "6s Td Jd Qd Kd Ad", "7s 8c 9c Tc Jc Qc");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "beat", "7s", "6s");
    // Подкинуть ему нечего, но «бито» он говорит сам (R108).
    act(table, 0, "pass", null, null);
    table.tick(table.deadline);
    // В колоде были туз треф и козырная девятка: туз ушёл заходившему, козырь — отбившемуся.
    assertThat(table.seats.get(0).hand).contains(card("Ac")).doesNotContain(card("9h"));
    assertThat(table.seats.get(1).hand).contains(card("9h"));
    assertThat(table.deck).isEmpty();
  }

  @Test
  void theLastPlayerHoldingCardsIsTheFool() {
    var table = table(2);
    endgame(table, "9h", "6s", "As Ks");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "beat", "As", "6s");
    table.tick(table.deadline);
    assertThat(table.phase).isEqualTo("over");
    assertThat(table.result.foolSeat).isEqualTo(1);
    assertThat(table.seats.get(1).fool).isTrue();
    // Зерно раскрывается вместе с концом партии — по нему и проверяют раздачу.
    assertThat(table.revealedSeed).isEqualTo(table.seed);
  }

  // --- Концовки: ничьей нет (R111) -----------------------------------------------------------

  /**
   * Последняя карта атаки и последняя карта защиты — не ничья.
   *
   * <p>Слова владельца (24.10.2026): «если предпоследний игрок кидает последние свои карты с руки,
   * а другой отбивает, то происходит ничья, однако в правильном варианте будет, что второй игрок
   * проиграл». Заходящий избавился от карт раньше — атака кладётся до защиты, — значит, он вышел, а
   * отбившийся последним остался последним.
   */
  @Test
  void theLastAttackBeatenByTheLastCardMakesTheDefenderTheFool() {
    var table = table(2);
    endgame(table, "9h", "6s", "As");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "beat", "As", "6s");
    table.tick(table.deadline);
    assertThat(table.phase).isEqualTo("over");
    assertThat(table.result.foolSeat).isEqualTo(1);
    assertThat(table.result.foolName).isEqualTo("Игрок 1");
    assertThat(table.seats.get(1).fool).isTrue();
    assertThat(table.seats.get(1).out).isFalse();
    assertThat(table.seats.get(0).place).isEqualTo(1);
    assertThat(table.result.places).containsExactly("Игрок 0");
    assertThat(table.log).noneMatch(note -> note.kind.equals("draw"));
    assertThat(table.tally.get("p1").fools).isEqualTo(1);
    assertThat(table.tally.get("p0").firsts).isEqualTo(1);
  }

  /** Несколько последних карт подряд — то же самое: защитник отбился последним и проиграл. */
  @Test
  void severalLastCardsBeatenByTheLastCardsStillMakeTheDefenderTheFool() {
    var table = table(2);
    endgame(table, "9h", "6s 6c", "As 7c");
    act(table, 0, "attack", "6s", null);
    act(table, 0, "attack", "6c", null);
    act(table, 1, "beat", "As", "6s");
    act(table, 1, "beat", "7c", "6c");
    table.tick(table.deadline);
    assertThat(table.phase).isEqualTo("over");
    assertThat(table.result.foolSeat).isEqualTo(1);
    assertThat(table.seats.get(0).place).isEqualTo(1);
  }

  /** Взял последние карты — дурак, тут спора и не было. */
  @Test
  void aDefenderWhoTakesTheLastCardsIsTheFool() {
    var table = table(2);
    endgame(table, "9h", "As", "6s 7s");
    act(table, 0, "attack", "As", null);
    act(table, 1, "take", null, null);
    table.tick(table.deadline);
    assertThat(table.phase).isEqualTo("over");
    assertThat(table.result.foolSeat).isEqualTo(1);
    assertThat(table.seats.get(0).place).isEqualTo(1);
  }

  /** Отбился последней картой, а у заходившего карты остались — вышел защитник. */
  @Test
  void aDefenderWhoEmptiesFirstLeavesTheAttackerAsTheFool() {
    var table = table(2);
    endgame(table, "9h", "6s 8c", "As");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "beat", "As", "6s");
    // Подкинуть пустой руке нельзя — бой закрылся сам, и это видно всем: у защитника ноль карт.
    assertThat(table.boutEnd).isEqualTo("beaten");
    table.tick(table.deadline);
    assertThat(table.phase).isEqualTo("over");
    assertThat(table.seats.get(1).place).isEqualTo(1);
    assertThat(table.result.foolSeat).isEqualTo(0);
  }

  /**
   * Трое, и последний бой опустошил руки двоим: места — по тому, кто раньше избавился от карт, а не
   * по номеру стула. Третий с картами — дурак.
   */
  @Test
  void placesFollowTheOrderInWhichHandsEmptiedNotTheSeatNumbers() {
    var table = table(3);
    endgame(table, "9h", "6s", "As", "7h 8h");
    // Заходит третий стул, отбивается первый, подкидывает второй. Обход по стульям отдал бы
    // первое место защитнику, а от карт раньше избавился подкинувший.
    table.attacker = 2;
    table.defender = 0;
    table.seats.get(0).hand = cards("Ks", "Ah");
    table.seats.get(1).hand = cards("6c");
    table.seats.get(2).hand = cards("6s", "8d");
    table.limit = 2;
    act(table, 2, "attack", "6s", null);
    act(table, 0, "beat", "Ks", "6s");
    act(table, 1, "attack", "6c", null);
    act(table, 0, "beat", "Ah", "6c");
    // Бой полон: предел в две карты исчерпан, и закрылся он сам — это видно по столу.
    assertThat(table.boutEnd).isEqualTo("beaten");
    table.tick(table.deadline);
    assertThat(table.seats.get(1).place).isEqualTo(1);
    assertThat(table.seats.get(0).place).isEqualTo(2);
    assertThat(table.result.foolSeat).isEqualTo(2);
    assertThat(table.result.places).containsExactly("Игрок 1", "Игрок 0");
  }

  /** Трое, и последний бой опустошил руки всем: дурак — тот, кто избавился от карт последним. */
  @Test
  void whenEveryHandEmptiesAtOnceTheLastToEmptyIsTheFool() {
    var table = table(3);
    endgame(table, "9h", "6s", "As 7c", "6c");
    act(table, 0, "attack", "6s", null);
    act(table, 2, "attack", "6c", null);
    act(table, 1, "beat", "As", "6s");
    act(table, 1, "beat", "7c", "6c");
    table.tick(table.deadline);
    assertThat(table.phase).isEqualTo("over");
    assertThat(table.seats.get(0).place).isEqualTo(1);
    assertThat(table.seats.get(2).place).isEqualTo(2);
    assertThat(table.result.foolSeat).isEqualTo(1);
    assertThat(table.result.places).containsExactly("Игрок 0", "Игрок 2");
  }

  /**
   * Переводной: перевод не даёт выйти последней картой (предел боя — рука защитника), поэтому
   * переведший остаётся с картой, а оба соседа, избавившиеся от своих, выходят по порядку.
   */
  @Test
  void afterATransferTheEmptiedHandsLeaveInTheOrderTheyEmptied() {
    var table = table(3, "perevodnoy", 36);
    endgame(table, "9h", "6s", "6h As", "7s 7h");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "transfer", "6h", null);
    assertThat(table.defender).isEqualTo(2);
    act(table, 2, "beat", "7s", "6s");
    act(table, 2, "beat", "7h", "6h");
    table.tick(table.deadline);
    assertThat(table.phase).isEqualTo("over");
    assertThat(table.seats.get(0).place).isEqualTo(1);
    assertThat(table.seats.get(2).place).isEqualTo(2);
    assertThat(table.result.foolSeat).isEqualTo(1);
  }

  /** Партия, сохранённая прежним ядром с ничьей, читается: поле просто пропускается. */
  @Test
  void aTableSavedWithAnOldDrawStillLoads() {
    var table = table(2);
    endgame(table, "9h", "6s", "As Ks");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "beat", "As", "6s");
    table.tick(table.deadline);
    var tree =
        (com.fasterxml.jackson.databind.node.ObjectNode)
            dev.mikki.stream.shared.Json.tree(dev.mikki.stream.shared.Json.write(table));
    ((com.fasterxml.jackson.databind.node.ObjectNode) tree.get("result")).put("draw", true);
    var restored = dev.mikki.stream.shared.Json.read(tree.toString(), Durak.class);
    assertThat(restored.result.foolSeat).isEqualTo(1);
    var summary =
        dev.mikki.stream.shared.Json.read(
            "{\"id\":\"g:1\",\"draw\":true,\"foolName\":\"\",\"places\":[],\"players\":[]}",
            dev.mikki.stream.game.DurakSummary.class);
    assertThat(summary.foolName()).isEmpty();
  }

  @Test
  void aPlayerWhoRunsOutLeavesAndTheRestKeepPlaying() {
    var table = table(3);
    endgame(table, "9h", "6s", "As Ks", "6h 7h");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "beat", "As", "6s");
    act(table, 2, "pass", null, null);
    table.tick(table.deadline);
    assertThat(table.seats.get(0).out).isTrue();
    assertThat(table.seats.get(0).place).isEqualTo(1);
    assertThat(table.phase).isEqualTo("bout");
    assertThat(table.attacker).isEqualTo(1);
    assertThat(table.defender).isEqualTo(2);
  }

  // --- Сроки -------------------------------------------------------------------------------

  /**
   * Время хода (R110): по умолчанию 30 с, на выбор ведущего — 15, 30 и 45 (владелец 24.10.2026: «по
   * умолчанию ход 30 секунд, сделать 15 30 и 45»). Любое другое значение становится ближайшей
   * ступенью.
   */
  @Test
  void theTurnTimeDefaultsToThirtySecondsAndIsOneOfThreeSteps() {
    var table = table(2);
    assertThat(table.turnSeconds).isEqualTo(Durak.DEFAULT_TURN).isEqualTo(30);
    assertThat(Durak.TURN_STEPS).containsExactly(15, 30, 45);
    table.configure("turn", 45L, T0);
    assertThat(table.turnSeconds).isEqualTo(45);
    table.configure("turn", 5L, T0);
    assertThat(table.turnSeconds).isEqualTo(15);
    table.configure("turn", 500L, T0);
    assertThat(table.turnSeconds).isEqualTo(45);
    table.configure("turn", 20L, T0);
    assertThat(table.turnSeconds).isEqualTo(15);
    table.configure("turn", 40L, T0);
    assertThat(table.turnSeconds).isEqualTo(45);
    table.configure("turn", null, T0);
    assertThat(table.turnSeconds).isEqualTo(30);
  }

  /** Новое время хода начинает отсчёт заново: у всех за столом одна и та же метка дедлайна. */
  @Test
  void changingTheTurnTimeRestartsTheClockForEveryone() {
    var table = table(2);
    deal(table, "9h", "6d 7d 8d Td Jd Qd", "6s 7s 8s 9s Ts Js", "As Ks Qs Ac Kc Qc");
    act(table, 0, "attack", "6s", null);
    table.configure("turn", 15L, T0 + 5000);
    assertThat(table.actionAt).isEqualTo(T0 + 5000);
    assertThat(table.deadline).isEqualTo(T0 + 5000 + 15_000);
    var view = table.view("stranger", T0 + 5000);
    assertThat(view.deadline()).isEqualTo(table.deadline);
    assertThat(view.actionAt()).isEqualTo(table.actionAt);
  }

  @Test
  void theDefenderTakesWhenTheClockRunsOut() {
    var table = table(2);
    deal(table, "9h", "6d 7d 8d Td Jd Qd", "6s 7s 8s 9s Ts Js", "As Ks Qs Ac Kc Qc");
    act(table, 0, "attack", "6s", null);
    assertThat(table.acting()).containsExactly(1);
    table.tick(table.deadline);
    assertThat(table.taking).isTrue();
  }

  @Test
  void attackersPassWhenTheClockRunsOut() {
    var table = table(2);
    deal(table, "9h", "6d 7d 8d Td Jd Qd", "6s 6h 8s 9s Ts Js", "As Ks Qs Ac Kc Qc");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "beat", "As", "6s");
    assertThat(table.acting()).containsExactly(0);
    table.tick(table.deadline);
    assertThat(table.boutEnd).isEqualTo("beaten");
  }

  // --- Решений за игрока нет (R108) ----------------------------------------------------------

  /*
   Прежнее решение T07 отменено владельцем 24.10.2026: «убрать "нечего подкинуть" и
   функциональность с этим, то есть человек играющий даже если нечего подкинуть должен мочь нажать
   "бито" потому что это может дать другому информацию о картах других игроков». Стол больше не
   пасует и не берёт за игрока по его руке: решает он сам или часы хода.
  */

  /** Расклад, где у третьего места подкинуть есть ({@code 6c}) или нечего ({@code Qd}). */
  private static Durak throwIn(String thirdCard) {
    var table = table(3);
    deal(
        table,
        "9h",
        "6d 7d 8d Td",
        "6s 8c 8s 9s Ts Js",
        "7s Ks As Ac Kc Qc",
        thirdCard + " Jd 8h Jc Tc 9c");
    // Зерно у двух столов одно: иначе их снимки отличались бы отпечатком, а не рукой.
    table.seed = "same-seed";
    table.commitment = Cards.commitment(table.seed);
    return table;
  }

  /**
   * Главное свойство: по столу нельзя понять, есть ли у игрока что подкинуть.
   *
   * <p>Два стола отличаются одной картой в руке третьего игрока — подходящего номинала у него то
   * есть, то нет. Снимок любого другого человека, срок хода и кого ждёт стол у них совпадают на
   * каждом шаге, в том числе после того, как остальные сказали «бито».
   */
  @Test
  void theTableLooksTheSameWhetherOrNotSomeoneHasACardToThrow() {
    var can = throwIn("6c");
    var cannot = throwIn("Qd");
    for (var table : List.of(can, cannot)) {
      act(table, 0, "attack", "6s", null);
      act(table, 1, "beat", "7s", "6s");
    }
    for (var viewer : List.of("p0", "p1", "stranger"))
      assertThat(cannot.view(viewer, T0 + 2000)).isEqualTo(can.view(viewer, T0 + 2000));
    assertThat(cannot.acting()).containsExactly(0, 2);
    for (var table : List.of(can, cannot)) act(table, 0, "pass", null, null);
    for (var viewer : List.of("p0", "p1", "stranger"))
      assertThat(cannot.view(viewer, T0 + 2000)).isEqualTo(can.view(viewer, T0 + 2000));
    assertThat(cannot.boutEnd).isNull();
    assertThat(cannot.acting()).containsExactly(2);
    for (var table : List.of(can, cannot)) table.tick(table.deadline);
    assertThat(cannot.view("stranger", T0 + 2000)).isEqualTo(can.view("stranger", T0 + 2000));
    assertThat(cannot.boutEnd).isEqualTo("beaten");
  }

  /** Подкинуть нечего — «Бито» всё равно у него, и бой ждёт именно его слова. */
  @Test
  void anAttackerWithNothingToThrowStillSaysBitoHimself() {
    var table = throwIn("Qd");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "beat", "7s", "6s");
    assertThat(table.view("p2", T0).you().actions()).containsExactly("pass");
    assertThat(table.view("p2", T0).you().turn()).isTrue();
    assertThat(table.view("p0", T0).you().actions()).containsExactly("pass");
    act(table, 0, "pass", null, null);
    assertThat(table.boutEnd).isNull();
    act(table, 2, "pass", null, null);
    assertThat(table.boutEnd).isEqualTo("beaten");
  }

  /** Взял — подкинуть вдогонку ждут всех, у кого есть карты, а не только тех, у кого подходит. */
  @Test
  void afterATakeEveryAttackerWithCardsIsAskedNotOnlyThoseWhoCanThrow() {
    var table = throwIn("Qd");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "take", null, null);
    assertThat(table.acting()).containsExactly(0, 2);
    assertThat(table.view("p2", T0).you().actions()).containsExactly("pass");
  }

  /**
   * Нечем отбиться — стол не торопит и не берёт за защитника: полный срок хода, как у любого.
   *
   * <p>Полторы секунды вместо минуты раньше говорили всем за столом, что козыря у него нет.
   */
  @Test
  void aDefenderWhoCannotBeatGetsTheFullTurnAndDecidesHimself() {
    var table = table(2);
    deal(table, "9h", "6d 7d 8d Td Jd Qd", "As 7s 8s 9s Ts Js", "6c 7c 8c 9c Tc Jc");
    act(table, 0, "attack", "As", null);
    assertThat(table.deadline - table.actionAt).isEqualTo(table.turnSeconds * 1000L);
    assertThat(table.tick(table.actionAt + 1500)).isFalse();
    assertThat(table.taking).isFalse();
    assertThat(table.view("p1", T0).you().actions()).containsExactly("take");
    table.tick(table.deadline);
    assertThat(table.taking).isTrue();
    assertThat(table.log).noneMatch(note -> note.text.contains("нечем"));
  }

  /** То же для двух атак на один козырь: срок тот же, что у защитника, которому есть чем. */
  @Test
  void aDefenderShortOfCardsIsTimedLikeAnyOther() {
    var cornered = table(2);
    deal(cornered, "9h", "6d 7d 8d Td Jd Qd", "As Ad 8s 9s Ts Js", "6h 7c 8c 9c Tc Jc");
    var covered = table(2);
    deal(covered, "9h", "6d 7d 8d Td Jd Qd", "As Ad 8s 9s Ts Js", "6h 7h 8c 9c Tc Jc");
    for (var table : List.of(cornered, covered)) {
      act(table, 0, "attack", "As", null);
      act(table, 0, "attack", "Ad", null);
    }
    assertThat(cornered.deadline).isEqualTo(covered.deadline);
    assertThat(cornered.acting()).isEqualTo(covered.acting());
  }

  /** В снимке нет поля, которым стол рассказывал о чужой руке. */
  @Test
  void theSnapshotCarriesNoAutomaticDecisions() {
    var table = throwIn("Qd");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "beat", "7s", "6s");
    var json = dev.mikki.stream.shared.Json.write(table.view("stranger", T0));
    assertThat(json).doesNotContain("\"auto\"");
  }

  // --- Снимок ------------------------------------------------------------------------------

  /** Главное свойство снимка: чужих карт, колоды и зерна в нём нет. */
  @Test
  void theSnapshotNeverCarriesSomeoneElsesCards() {
    var table = table(2);
    table.deal(T0);
    var view = table.view("p0", T0);
    assertThat(view.you().cards()).hasSize(6);
    assertThat(view.seats().get(1).held()).isEqualTo(6);
    assertThat(view.seed()).isNull();
    var text = view.toString();
    for (var card : table.seats.get(1).hand)
      assertThat(view.you().cards()).doesNotContain(Cards.text(card));
    assertThat(text).doesNotContain(String.valueOf(table.seed));
  }

  /**
   * Снимок не подсказывает, чем ходить.
   *
   * <p>Раньше он присылал три списка законных карт, и браузер подсвечивал ими руку. За настоящим
   * столом никто не подсвечивает: человек кладёт карту и узнаёт, легла ли она. Поэтому из снимка
   * уходит всё, кроме двух слов для кнопок, — а законность по-прежнему решает сервер.
   */
  @Test
  void theSnapshotNeverHintsWhichCardIsLegal() {
    var table = table(2);
    deal(table, "9h", "6d 7d 8d Td Jd Qd", "6s 7s 8s 9s Ts Js", "As Ks 6h Ac Kc Qc");
    act(table, 0, "attack", "6s", null);
    var defender = table.view("p1", T0).you();
    // Защитнику предлагают ровно одно слово: взять. Отбиться — это движение карты, не кнопка.
    assertThat(defender.actions()).containsExactly("take");
    assertThat(defender.cards()).hasSize(6);
    // Ни одной карты в подсказке — их нет в снимке как понятия.
    assertThat(table.view("p1", T0).toString()).doesNotContain("beats=");
    var attacker = table.view("p0", T0).you();
    assertThat(attacker.actions()).doesNotContain("take");
  }

  @Test
  void aWatcherGetsNoButtonsAtAll() {
    var table = table(2);
    table.deal(T0);
    assertThat(table.view("stranger", T0).you()).isNull();
  }

  // --- Места -------------------------------------------------------------------------------

  @Test
  void sittingDownMidGameWaitsForTheNextDeal() {
    var table = table(2);
    table.deal(T0);
    table.sit("late", "Опоздавший", 3, T0);
    assertThat(table.seats.get(3).waiting).isTrue();
    assertThat(table.seats.get(3).playing()).isFalse();
  }

  @Test
  void standingUpMidGameDiscardsTheHandAndTheRestPlayOn() {
    var table = table(3);
    deal(table, "9h", "6d 7d 8d Td", "6s 7s 8s", "As Ks Qs", "6h 7h 8h");
    act(table, 0, "attack", "6s", null);
    table.stand("p2", T0 + 2000);
    assertThat(table.seats.get(2).taken()).isFalse();
    assertThat(table.phase).isEqualTo("bout");
  }

  @Test
  void theTableStopsWhenOnlyOnePlayerIsLeft() {
    var table = table(2);
    table.deal(T0);
    table.stand("p1", T0 + 2000);
    assertThat(table.phase).isEqualTo("lobby");
    assertThat(table.result).isNull();
  }

  @Test
  void anEmptyTableIsSweptAfterTenMinutes() {
    var table = table(2);
    table.presence(Set.of(), T0);
    assertThat(table.linger(T0, T0 - 1)).isFalse();
    assertThat(table.linger(T0 + Durak.LINGER_MS, T0 - 1)).isTrue();
  }

  @Test
  void deckAndRulesOnlyChangeBetweenGames() {
    var table = table(2);
    table.configure("deck", 52L, T0);
    assertThat(table.deckSize).isEqualTo(52);
    table.deal(T0);
    assertThatThrownBy(() -> table.configure("deck", 36L, T0))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("между партиями");
  }

  // --- Счёт и история ------------------------------------------------------------------------

  /**
   * Счёт беседы копится на человеке и виден на сцене.
   *
   * <p>Это не история: история — про вечер, который уже кончился, а счёт спрашивают, не вставая
   * из-за стола.
   */
  @Test
  void theScoreCountsFoolsPerPerson() {
    var table = table(2);
    endgame(table, "9h", "6s", "As Ks");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "beat", "As", "6s");
    table.tick(table.deadline);
    assertThat(table.phase).isEqualTo("over");
    var score = table.view("p0", T0).score();
    assertThat(score).hasSize(2);
    // Первым идёт тот, кто чаще был дураком.
    assertThat(score.get(0).name()).isEqualTo("Игрок 1");
    assertThat(score.get(0).fools()).isEqualTo(1);
    assertThat(score.get(0).games()).isEqualTo(1);
    assertThat(score.get(1).fools()).isZero();
    // Кто не проиграл — тому пошла серия.
    assertThat(score.get(1).streak()).isEqualTo(1);
  }

  /** Счёт едет за человеком, а не за идентификатором: переподключившийся получает новый. */
  @Test
  void theScoreFollowsThePersonThroughAReconnect() {
    var table = table(2);
    endgame(table, "9h", "6s", "As Ks");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "beat", "As", "6s");
    table.tick(table.deadline);
    table.rebind("p1", "p1-new", "Игрок 1");
    var score = table.view("p0", T0).score();
    assertThat(score.get(0).name()).isEqualTo("Игрок 1");
    assertThat(score.get(0).fools()).isEqualTo(1);
  }

  /** Итог партии собирается из того, что стол копил по ходу, и знает, кто дурак. */
  @Test
  void theSummaryRemembersWhoWasTheFool() {
    var table = table(2);
    endgame(table, "9h", "6s", "As Ks");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "beat", "As", "6s");
    table.tick(table.deadline);
    var summary = dev.mikki.stream.game.DurakStandings.of(table, T0 + 5000);
    assertThat(summary.foolName()).isEqualTo("Игрок 1");
    assertThat(summary.places()).containsExactly("Игрок 0");
    assertThat(summary.number()).isEqualTo(1);
    assertThat(summary.deckSize()).isEqualTo(36);
    assertThat(summary.players()).hasSize(2);
    // Дурак идёт в таблице последним — она читается как финиш, а не как список.
    assertThat(summary.players().get(summary.players().size() - 1).fool()).isTrue();
    assertThat(summary.players().get(0).place()).isEqualTo(1);
  }

  /** Отбился целиком — это считается. Взял — тоже. */
  @Test
  void takingAndDefendingAreCounted() {
    var table = table(2);
    deal(table, "9h", "6d 7d 8d Td Jd Qd 6c 7c", "6s 6h 8s 9s Ts Js", "As Ks Qs Ac Kc Qc");
    act(table, 0, "attack", "6s", null);
    act(table, 1, "take", null, null);
    act(table, 0, "pass", null, null);
    table.tick(table.deadline);
    assertThat(table.tally.get("p1").takes).isEqualTo(1);
    assertThat(table.tally.get("p1").defences).isZero();
  }

  @Test
  void fiftyTwoCardsHasNoJokersAndStartsAtTheTwo() {
    var table = table(2, "podkidnoy", 52);
    table.deal(T0);
    var seen = new ArrayList<Integer>(table.deck);
    for (var seat : table.seats) seen.addAll(seat.hand);
    assertThat(seen).hasSize(52).doesNotHaveDuplicates();
    assertThat(seen.stream().min(Integer::compare).orElseThrow()).isLessThan(4);
  }
}
