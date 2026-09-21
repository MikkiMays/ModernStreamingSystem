package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;

import dev.mikki.stream.game.Cards;
import dev.mikki.stream.game.Hands;
import dev.mikki.stream.game.Table;
import dev.mikki.stream.shared.Problem;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Правила стола.
 *
 * <p>Проверяется не «работает ли код», а то, из-за чего за настоящим столом спорят: кто ходит
 * первым, сколько стоит повышение, кому достаётся лишняя фишка и что происходит с деньгами, когда
 * ва-банк оказался больше чужого стека. Ошибка в любом из этих мест выглядит как исправная игра, в
 * которой изредка не сходятся фишки.
 */
class PokerTest {
  private static final long T0 = 1_700_000_000_000L;

  /** Карта по-человечески: {@code As}, {@code Td}. */
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

  private static Table table(String mode, int players) {
    var table = Table.open("host", mode, T0);
    for (int index = 0; index < players; index++)
      table.sit("p" + index, "Игрок " + index, index, T0);
    return table;
  }

  /**
   * Раздать на известном раскладе.
   *
   * <p>Карты игрокам кладутся в руки, а борд — обратно в колоду в том порядке, в каком стол его сам
   * достанет: со сжиганием перед каждой улицей. Так проверяются настоящие правила, а не подменённое
   * состояние.
   */
  private static void deal(Table table, long now, String board, String... holes) {
    table.deal(now);
    var used = new ArrayList<Integer>();
    for (int index = 0; index < holes.length; index++) {
      var hole = cards(holes[index].split(" "));
      table.seats.get(index).cards = hole;
      used.addAll(hole);
    }
    var upcoming = board.isBlank() ? new ArrayList<Integer>() : cards(board.split(" "));
    used.addAll(upcoming);
    var spare = new ArrayList<Integer>();
    for (int card = 0; card < 52; card++) if (!used.contains(card)) spare.add(card);
    var deck = new ArrayList<Integer>();
    if (upcoming.size() >= 3) {
      deck.add(spare.remove(0));
      deck.addAll(upcoming.subList(0, 3));
    }
    if (upcoming.size() >= 4) {
      deck.add(spare.remove(0));
      deck.add(upcoming.get(3));
    }
    if (upcoming.size() >= 5) {
      deck.add(spare.remove(0));
      deck.add(upcoming.get(4));
    }
    deck.addAll(spare);
    table.deck = deck;
    table.board = new ArrayList<>();
  }

  /** Доиграть борд, когда ставить уже некому: стол делает это паузами, по своим часам. */
  private static void runOut(Table table) {
    for (int guard = 0; guard < 12 && table.playing(); guard++) table.tick(table.deadline);
  }

  /** Прочекать круг до конца. */
  private static void checkAround(Table table) {
    while (table.playing() && table.actor >= 0) table.act("p" + table.actor, "check", 0, T0);
  }

  private static Table.Seat seat(Table table, int index) {
    return table.seats.get(index);
  }

  // --- Комбинации -------------------------------------------------------------------------

  @Test
  void handsAreRankedAndNamedByWhatTheyActuallyAre() {
    assertThat(Hands.best(cards("As", "Ks", "Qs", "Js", "Ts", "2h", "3d")).name())
        .isEqualTo("Флеш-рояль");
    // Туз играет и снизу: A-2-3-4-5 — стрит до пятёрки, а не старшая карта.
    var wheel = Hands.best(cards("As", "2h", "3d", "4c", "5s", "Kd", "9h"));
    assertThat(wheel.category()).isEqualTo(Hands.Category.STRAIGHT);
    assertThat(wheel.name()).isEqualTo("Стрит до пятёрки");
    assertThat(Hands.best(cards("Ah", "Ad", "Ac", "As", "Kd", "Kh", "2c")).name())
        .isEqualTo("Каре тузов");
    assertThat(Hands.best(cards("Qh", "Qd", "Qc", "3s", "3d", "7h", "2c")).name())
        .isEqualTo("Фулл-хаус: дамы и тройки");
    assertThat(Hands.best(cards("Kh", "Kd", "7c", "7s", "2d", "9h", "4c")).name())
        .isEqualTo("Две пары: короли и семёрки");
  }

  @Test
  void kickersDecideWhatTheCategoryCannot() {
    var higher = Hands.best(cards("Ah", "Ad", "Ks", "9c", "4d", "2h", "3s"));
    var lower = Hands.best(cards("Ah", "Ad", "Qs", "9c", "4d", "2h", "3s"));
    assertThat(higher.score()).isGreaterThan(lower.score());
    // Флеш всегда старше стрита, каким бы высоким тот ни был.
    var flush = Hands.best(cards("2s", "4s", "6s", "8s", "Ts", "Ah", "Kd"));
    var straight = Hands.best(cards("9h", "Td", "Jc", "Qs", "Kh", "2c", "3d"));
    assertThat(flush.score()).isGreaterThan(straight.score());
    // Лучшая пятёрка — это именно пять карт, а не семь.
    assertThat(flush.cards()).hasSize(5);
  }

  // --- Тасовка ----------------------------------------------------------------------------

  @Test
  void shuffleIsRepeatableFromItsSeedAndHoldsEveryCardOnce() {
    var seed = Cards.seed();
    var once = Cards.shuffle(seed);
    assertThat(Cards.shuffle(seed)).isEqualTo(once);
    assertThat(Set.copyOf(once)).hasSize(52);
    assertThat(Cards.shuffle(Cards.seed())).isNotEqualTo(once);
    // Обязательство проверяется по тому же зерну, которое стол раскрывает после раздачи.
    assertThat(Cards.commitment(seed)).hasSize(64).isEqualTo(Cards.commitment(seed));
  }

  // --- Порядок хода -----------------------------------------------------------------------

  @Test
  void blindsAndFirstActionSitWhereTheyShould() {
    var table = table("friendly", 3);
    table.deal(T0);
    // Кнопка, малый, большой: ходит первым тот, кто за большим блайндом.
    assertThat(table.button).isZero();
    assertThat(seat(table, 1).bet).isEqualTo(25);
    assertThat(seat(table, 2).bet).isEqualTo(50);
    assertThat(table.actor).isZero();
    assertThat(table.betToCall).isEqualTo(50);
    assertThat(seat(table, 0).cards).hasSize(2);
  }

  @Test
  void headsUpPutsTheButtonOnTheSmallBlindAndMakesItActFirst() {
    var table = table("friendly", 2);
    table.deal(T0);
    assertThat(seat(table, table.button).bet).isEqualTo(25);
    assertThat(table.actor).isEqualTo(table.button);
    // После флопа первым говорит большой блайнд, а не кнопка.
    table.act("p" + table.actor, "call", 0, T0);
    table.act("p" + table.actor, "check", 0, T0);
    assertThat(table.phase).isEqualTo("flop");
    assertThat(table.actor).isNotEqualTo(table.button);
  }

  @Test
  void theBigBlindStillGetsToRaiseAfterEveryoneCalls() {
    var table = table("friendly", 3);
    table.deal(T0);
    table.act("p0", "call", 0, T0);
    table.act("p1", "call", 0, T0);
    // Круг не закончился: большой блайнд ещё не говорил.
    assertThat(table.phase).isEqualTo("preflop");
    assertThat(table.actor).isEqualTo(2);
    table.act("p2", "check", 0, T0);
    assertThat(table.phase).isEqualTo("flop");
    assertThat(table.pot).isEqualTo(150);
  }

  // --- Размеры ставок ---------------------------------------------------------------------

  @Test
  void minimumRaiseIsThePreviousRaiseAndNothingLess() {
    var table = table("friendly", 3);
    table.deal(T0);
    assertThatThrownBy(() -> table.act("p0", "raise", 70, T0))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("Минимум");
    table.act("p0", "raise", 150, T0);
    // Повысили на сто: следующее повышение — не меньше чем до двухсот пятидесяти.
    assertThatThrownBy(() -> table.act("p1", "raise", 200, T0)).isInstanceOf(Problem.class);
    table.act("p1", "raise", 250, T0);
    assertThat(table.betToCall).isEqualTo(250);
  }

  @Test
  void shortAllInDoesNotReopenBettingForThoseWhoAlreadyActed() {
    var table = table("friendly", 3);
    seat(table, 2).stack = 180;
    table.deal(T0);
    table.act("p0", "raise", 150, T0);
    table.act("p1", "call", 0, T0);
    // Большой блайнд идёт ва-банк на 180: это меньше полного повышения (150 + 100).
    table.act("p2", "allin", 0, T0);
    assertThat(table.betToCall).isEqualTo(180);
    assertThat(table.actor).isZero();
    assertThatThrownBy(() -> table.act("p0", "raise", 400, T0))
        .isInstanceOf(Problem.class)
        .hasMessageContaining("только ответить");
    table.act("p0", "call", 0, T0);
    table.act("p1", "call", 0, T0);
    assertThat(table.phase).isEqualTo("flop");
  }

  @Test
  void anUncalledBetComesBackInsteadOfBeingWon() {
    var table = table("friendly", 3);
    seat(table, 1).stack = 400;
    table.deal(T0);
    table.act("p0", "raise", 1000, T0);
    table.act("p1", "allin", 0, T0);
    table.act("p2", "fold", 0, T0);
    // Уравняли только четырьмястами — шестьсот вернулись тому, кто их поставил.
    assertThat(seat(table, 0).stack).isEqualTo(5000 - 400);
    assertThat(table.pot).isEqualTo(400 + 400 + 50);
  }

  // --- Банки ------------------------------------------------------------------------------

  @Test
  void sidePotIsBuiltFromWhatEachPlayerCouldActuallyCover() {
    var table = table("friendly", 3);
    seat(table, 0).stack = 500;
    seat(table, 1).stack = 1500;
    seat(table, 2).stack = 3000;
    deal(table, T0, "2c 7d 9s Jh 4c", "As Ah", "Ks Kh", "Qs Qh");
    table.act("p0", "allin", 0, T0);
    table.act("p1", "allin", 0, T0);
    table.act("p2", "call", 0, T0);
    runOut(table);
    assertThat(table.phase).isEqualTo("showdown");
    assertThat(table.board).hasSize(5);
    // Главный банк — пятьсот с каждого; побочный — по тысяче с двух оставшихся.
    assertThat(seat(table, 0).stack).isEqualTo(1500);
    assertThat(seat(table, 1).stack).isEqualTo(2000);
    assertThat(seat(table, 2).stack).isEqualTo(1500);
    assertThat(table.result.awards).hasSize(2);
  }

  @Test
  void aSplitPotGivesTheOddChipToTheSeatLeftOfTheButton() {
    var table = table("friendly", 3);
    // Большой блайнд короче блайнда: банк выходит нечётным, и лишней фишке нужен хозяин.
    seat(table, 2).stack = 45;
    deal(table, T0, "2c 7d 9s Jh 4c", "Ad Kc", "Ah Ks", "3h 5d");
    table.act("p0", "call", 0, T0);
    table.act("p1", "call", 0, T0);
    checkAround(table);
    checkAround(table);
    checkAround(table);
    assertThat(table.phase).isEqualTo("showdown");
    // Две одинаковые руки делят 135 на двоих: 68 достаётся тому, кто слева от кнопки.
    int leftOfButton = (table.button + 1) % Table.SEATS;
    assertThat(seat(table, leftOfButton).stack).isEqualTo(seat(table, table.button).stack + 1);
    assertThat(table.result.awards).allMatch(award -> award.split);
  }

  @Test
  void everybodyFoldingEndsTheHandWithoutShowingAnything() {
    var table = table("friendly", 3);
    deal(table, T0, "", "As Ah", "Ks Kh", "Qs Qh");
    table.act("p0", "fold", 0, T0);
    table.act("p1", "fold", 0, T0);
    assertThat(table.phase).isEqualTo("showdown");
    assertThat(table.result.showdown).isFalse();
    assertThat(seat(table, 2).revealed).isFalse();
    assertThat(seat(table, 2).stack).isEqualTo(5000 + 25);
  }

  // --- Время и отсутствие -----------------------------------------------------------------

  @Test
  void aClockThatRunsOutChecksWhenItCanAndFoldsWhenItCannot() {
    var table = table("turbo", 3);
    table.deal(T0);
    long deadline = table.deadline;
    // Банк времени даётся раз на посадку: сначала он, и только потом решение за игрока.
    assertThat(table.tick(deadline)).isTrue();
    assertThat(table.actor).isZero();
    assertThat(table.tick(table.deadline)).isTrue();
    assertThat(seat(table, 0).folded).isTrue();
    assertThat(table.actor).isEqualTo(1);
  }

  @Test
  void leavingTheMeetingHandsOverTheTurnInsteadOfStoppingTheGame() {
    var table = table("friendly", 3);
    table.deal(T0);
    assertThat(table.actor).isZero();
    // Сначала стол лишь замечает, что человека нет: связь могла и моргнуть.
    table.presence(Set.of("p1", "p2"), T0);
    assertThat(seat(table, 0).away).isTrue();
    assertThat(seat(table, 0).folded).isFalse();
    table.presence(Set.of("p1", "p2"), T0 + Table.AWAY_ACT_MS + 1);
    assertThat(seat(table, 0).folded).isTrue();
    assertThat(table.actor).isEqualTo(1);
  }

  @Test
  void standingUpDropsTheHandAndFreesTheSeatAfterTheHand() {
    var table = table("friendly", 3);
    table.deal(T0);
    table.stand("p1", T0);
    assertThat(seat(table, 1).folded).isTrue();
    assertThat(seat(table, 1).leaving).isTrue();
    table.act("p0", "fold", 0, T0);
    table.tick(table.deadline);
    assertThat(seat(table, 1).taken()).isFalse();
  }

  // --- Вылет ------------------------------------------------------------------------------

  @Test
  void aTournamentRemembersWhoWentOutAndWhen() {
    var table = table("tournament", 3);
    seat(table, 0).stack = 300;
    seat(table, 1).stack = 600;
    deal(table, T0, "2c 7d 9s Jh 4c", "Ks Kh", "Qs Qh", "As Ah");
    table.act("p0", "allin", 0, T0);
    table.act("p1", "allin", 0, T0);
    table.act("p2", "call", 0, T0);
    runOut(table);
    table.tick(table.deadline);
    // Оба проиграли в одной раздаче: у кого стек был больше, тот и выше в таблице.
    assertThat(seat(table, 1).place).isEqualTo(2);
    assertThat(seat(table, 0).place).isEqualTo(3);
    assertThat(table.phase).isEqualTo("over");
  }

  @Test
  void afterAHandTheTableDealsItselfTheNextOne() {
    var table = table("friendly", 3);
    table.deal(T0);
    table.act("p0", "fold", 0, T0);
    table.act("p1", "fold", 0, T0);
    long ends = table.deadline;
    table.tick(ends);
    assertThat(table.phase).isEqualTo("lobby");
    assertThat(table.deadline).isEqualTo(ends + Table.NEXT_HAND_MS);
    table.tick(table.deadline);
    assertThat(table.phase).isEqualTo("preflop");
    assertThat(table.handNumber).isEqualTo(2);
    // Кнопка сдвинулась — блайнды платит следующий.
    assertThat(table.button).isEqualTo(1);
  }

  @Test
  void pausingStopsTheTableAfterTheHandRatherThanInsideIt() {
    var table = table("friendly", 3);
    table.deal(T0);
    table.configure("pause", T0);
    assertThat(table.phase).isEqualTo("preflop");
    table.act("p0", "fold", 0, T0);
    table.act("p1", "fold", 0, T0);
    table.tick(table.deadline);
    assertThat(table.phase).isEqualTo("lobby");
    assertThat(table.deadline).isZero();
  }

  // --- Что видно кому ---------------------------------------------------------------------

  @Test
  void nobodySeesSomebodyElsesCardsUntilTheyAreShown() {
    var table = table("friendly", 3);
    deal(table, T0, "", "As Ah", "Ks Kh", "Qs Qh");
    var mine = table.view("p0", T0);
    assertThat(mine.seats().get(0).cards()).containsExactly("As", "Ah");
    assertThat(mine.seats().get(1).cards()).isEmpty();
    assertThat(mine.seats().get(1).held()).isEqualTo(2);
    assertThat(mine.you().seat()).isZero();
    assertThat(mine.you().actions()).contains("fold", "call", "raise");
    // Зритель не видит ничьих карт и не получает кнопок.
    var watcher = table.view("nobody", T0);
    assertThat(watcher.you()).isNull();
    assertThat(watcher.seats().stream().allMatch(seat -> seat.cards().isEmpty())).isTrue();
    // Зерно тасовки не уходит никому, пока раздача не сыграна.
    assertThat(mine.seed()).isEmpty();
    assertThat(mine.commitment()).isNotEmpty();
  }

  @Test
  void theSeedIsRevealedOnlyOnceTheHandIsDecided() {
    var table = table("friendly", 2);
    table.deal(T0);
    var secret = table.seed;
    table.act("p" + table.actor, "fold", 0, T0);
    assertThat(table.view("p0", T0).seed()).isEqualTo(secret);
    assertThat(Cards.commitment(secret)).isEqualTo(table.commitment);
  }
}
