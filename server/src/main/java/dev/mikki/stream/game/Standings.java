package dev.mikki.stream.game;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.function.ToLongFunction;

/**
 * Итоги игры: то, с чем люди встали из-за стола.
 *
 * <p>ПОЧЕМУ ОТДЕЛЬНО ОТ СТОЛА. {@link Table} — это правила: кто ходит, сколько стоит повышение,
 * кому достался банк. Здесь ничего не решается — здесь читается уже посчитанное и складывается в
 * одну запись. Смешав то и это, мы получили бы полторы тысячи строк, в которых правила игры
 * перемешаны с подписями к таблице.
 *
 * <p>Статистику копит сам стол по ходу игры ({@link Table.Player}) — иначе к концу её не собрать: в
 * конце нет ни карт, ни ставок, ни половины сидевших.
 */
public final class Standings {
  private Standings() {}

  /** Сколько прикольных строчек показываем. Больше — это уже не «прикольно», а простыня. */
  private static final int HIGHLIGHTS = 8;

  /**
   * Собрать итог игры.
   *
   * @param ending чем кончилась игра; какие концы бывают — в {@link GameSummary#ending()}
   */
  public static GameSummary of(Table table, String ending, long now) {
    var players = players(table);
    return new GameSummary(
        // Имя записи даёт сам стол и не меняет его: снимок собирается заново на каждый запрос, и
        // новый идентификатор в каждом означал бы, что браузер перерисовывает итоги без причины.
        table.gameId == null ? UUID.randomUUID().toString() : table.gameId,
        table.mode,
        table.settings().name(),
        table.openedAt,
        now,
        table.handNumber,
        table.startingStack,
        table.smallBlind,
        table.bigBlind,
        table.level,
        table.biggestPot,
        !table.rebuyAllowed,
        ending,
        players,
        highlights(players, table));
  }

  /**
   * Кто играл и с чем остался.
   *
   * <p>Живое место важнее памяти: тот, кто сидит прямо сейчас, оценивается по своему стеку, а не по
   * тому, что запомнилось при последнем изменении. Порядок — турнирными местами, где они есть, и
   * прибылью там, где мест нет: в дружеской игре «первое место» ничего не значит, а «плюс тысяча»
   * значит всё.
   */
  private static List<GameSummary.PlayerSummary> players(Table table) {
    var list = new ArrayList<GameSummary.PlayerSummary>();
    for (var entry : table.tally.entrySet()) {
      var player = entry.getValue();
      var seat = table.seatOf(entry.getKey());
      long stack = seat != null ? seat.stack : player.stack;
      int place = seat != null && seat.place > 0 ? seat.place : player.place;
      list.add(
          new GameSummary.PlayerSummary(
              player.name == null ? "Игрок" : player.name,
              place,
              player.buyIn,
              player.rebuys,
              stack,
              stack - player.buyIn,
              player.invested,
              player.won,
              player.hands,
              player.handsWon,
              player.showdowns,
              player.showdownWins,
              player.allIns,
              player.folds,
              player.checks,
              player.calls,
              player.raises,
              player.voluntary,
              player.biggestBet,
              player.biggestPotWon,
              Math.max(player.peakStack, stack),
              player.knockouts,
              player.bestStreak,
              player.bestHand == null ? "" : player.bestHand));
    }
    boolean places = list.stream().anyMatch(player -> player.place() > 0);
    list.sort(
        places
            ? Comparator.comparingInt(
                    (GameSummary.PlayerSummary player) ->
                        player.place() > 0 ? player.place() : Integer.MAX_VALUE)
                .thenComparing(Comparator.comparingLong(GameSummary.PlayerSummary::net).reversed())
            : Comparator.comparingLong(GameSummary.PlayerSummary::net)
                .reversed()
                .thenComparing(GameSummary.PlayerSummary::name));
    return List.copyOf(list);
  }

  /**
   * Прикольные строчки про игру.
   *
   * <p>Числа в таблице отвечают на «сколько», а эти — на «кто»: их и обсуждают, вставая из-за
   * стола. Каждая появляется только тогда, когда в ней есть смысл: «главный охотник» без выбитых
   * или «серия побед» из одной раздачи — это не статистика, а заполненная графа.
   */
  private static List<GameSummary.Highlight> highlights(
      List<GameSummary.PlayerSummary> players, Table table) {
    var list = new ArrayList<GameSummary.Highlight>();
    best(
        list,
        players,
        "pot",
        "Самый крупный банк",
        GameSummary.PlayerSummary::biggestPotWon,
        player -> player.biggestPotWon() > 0,
        player -> chips(player.biggestPotWon()),
        "за одну раздачу");
    /*
     Сила комбинации — единственная номинация, которую нельзя измерить полем таблицы: «каре»
     и «стрит» в ней лежат словами, а сравнивать их нужно как числа. Счёт комбинации наружу не
     отдаётся (в итогах игры он ничего не объясняет), поэтому эта строчка читает память стола.
    */
    Table.Player strongest = null;
    for (var player : table.tally.values())
      if (player.bestHand != null
          && (strongest == null || player.bestHandScore > strongest.bestHandScore))
        strongest = player;
    if (strongest != null)
      list.add(
          new GameSummary.Highlight(
              "hand",
              "Лучшая комбинация",
              strongest.name == null ? "Игрок" : strongest.name,
              strongest.bestHand,
              "сильнейшее вскрытие игры"));
    best(
        list,
        players,
        "allin",
        "Больше всех ва-банков",
        player -> player.allIns(),
        player -> player.allIns() > 0,
        player -> plural(player.allIns(), "раз", "раза", "раз"),
        "пошёл на всё");
    best(
        list,
        players,
        "knockouts",
        "Главный охотник",
        player -> player.knockouts(),
        player -> player.knockouts() > 0,
        player -> plural(player.knockouts(), "выбитый", "выбитых", "выбитых"),
        "забрал чужой стек");
    best(
        list,
        players,
        "streak",
        "Серия побед",
        player -> player.bestStreak(),
        player -> player.bestStreak() > 1,
        player -> player.bestStreak() + " подряд",
        "раздачи одна за другой");
    best(
        list,
        players,
        "peak",
        "Самая большая горка",
        GameSummary.PlayerSummary::peakStack,
        player -> player.peakStack() > 0,
        player -> chips(player.peakStack()),
        "столько было в лучший момент");
    best(
        list,
        players,
        "invested",
        "Больше всех поставил",
        GameSummary.PlayerSummary::invested,
        player -> player.invested() > 0,
        player -> chips(player.invested()),
        "за всю игру");
    best(
        list,
        players,
        "rebuys",
        "Чаще всех докупался",
        player -> player.rebuys(),
        player -> player.rebuys() > 0,
        player -> plural(player.rebuys(), "докупка", "докупки", "докупок"),
        "фишки кончались");
    best(
        list,
        players,
        "loose",
        "Самый азартный",
        player -> player.voluntary(),
        player -> player.hands() >= 4 && player.voluntary() > 0,
        player -> "играл " + player.voluntary() + " из " + player.hands(),
        "вкладывался сам, не блайндом");
    best(
        list,
        players,
        "tight",
        "Самый терпеливый",
        player -> player.hands() - player.voluntary(),
        player -> player.hands() >= 4 && player.hands() - player.voluntary() > 1,
        player -> "сбросил " + (player.hands() - player.voluntary()) + " из " + player.hands(),
        "ждал свою руку");
    best(
        list,
        players,
        "showdown",
        "Железная рука",
        GameSummary.PlayerSummary::showdownWins,
        player -> player.showdowns() > 1 && player.showdownWins() == player.showdowns(),
        player -> "все " + plural(player.showdowns(), "вскрытие", "вскрытия", "вскрытий"),
        "вскрывался и выигрывал");
    best(
        list,
        players,
        "profit",
        "Главный плюс",
        GameSummary.PlayerSummary::net,
        player -> player.net() > 0,
        player -> "+" + chips(player.net()),
        "столько забрал сверх взятого");
    return list.size() > HIGHLIGHTS ? List.copyOf(list.subList(0, HIGHLIGHTS)) : List.copyOf(list);
  }

  /** Один победитель в одной номинации — или ни одного, если номинации не из чего сложиться. */
  private static void best(
      List<GameSummary.Highlight> into,
      List<GameSummary.PlayerSummary> players,
      String id,
      String title,
      ToLongFunction<GameSummary.PlayerSummary> measure,
      Predicate<GameSummary.PlayerSummary> counts,
      Function<GameSummary.PlayerSummary, String> value,
      String hint) {
    GameSummary.PlayerSummary winner = null;
    for (var player : players)
      if (counts.test(player)
          && (winner == null || measure.applyAsLong(player) > measure.applyAsLong(winner)))
        winner = player;
    if (winner == null) return;
    into.add(new GameSummary.Highlight(id, title, winner.name(), value.apply(winner), hint));
  }

  /**
   * Число со словом.
   *
   * <p>«5 раза» и «1 докупки» в итогах игры выглядят как недоделанная таблица, поэтому правило
   * русского счёта здесь одно на все подписи: единица, двойка-четвёрка и всё остальное, с изъятием
   * на подростковые одиннадцать-четырнадцать.
   */
  private static String plural(int count, String one, String few, String many) {
    int tail = count % 10;
    int teen = count % 100;
    if (teen >= 11 && teen <= 14) return count + " " + many;
    if (tail == 1) return count + " " + one;
    if (tail >= 2 && tail <= 4) return count + " " + few;
    return count + " " + many;
  }

  /**
   * Фишки словами.
   *
   * <p>Разряды разделяются узким неразрывным пробелом — тем же, что и в браузере ({@code
   * web/src/core/poker.ts}): эти строки показываются рядом, и «1 250» с «1250» в одной таблице
   * читаются как две разные системы счёта.
   */
  static String chips(long amount) {
    var digits = Long.toString(Math.abs(amount));
    var text = new StringBuilder();
    for (int index = 0; index < digits.length(); index++) {
      if (index > 0 && (digits.length() - index) % 3 == 0) text.append(' ');
      text.append(digits.charAt(index));
    }
    return (amount < 0 ? "−" : "") + text;
  }
}
