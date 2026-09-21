package dev.mikki.stream.game;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Во что складываются карты.
 *
 * <p>Лучшая пятёрка ищется перебором: из семи карт двадцать один способ выбрать пять, и каждый
 * оценивается целиком. Перебор выбран не от лени — он заодно <b>называет сами карты</b>, из которых
 * собралась комбинация, а без них стол не смог бы подсветить победную руку. Двадцать один расклад
 * на раздачу — это микросекунды; таблицы на сто килобайт здесь экономили бы то, чего и так нет.
 *
 * <p>Сила руки — одно число: категория в старших разрядах, дальше пять номиналов по убыванию
 * важности. Поэтому сравнение рук — это сравнение двух int, и кикеры разбираются сами собой.
 */
public final class Hands {
  public enum Category {
    HIGH_CARD,
    PAIR,
    TWO_PAIR,
    TRIPS,
    STRAIGHT,
    FLUSH,
    FULL_HOUSE,
    QUADS,
    STRAIGHT_FLUSH
  }

  /** Номиналы по-русски в четырёх падежах: иначе «Пара тузы» и «Стрит до туз». */
  private static final String[] ONE = {
    "двойка",
    "тройка",
    "четвёрка",
    "пятёрка",
    "шестёрка",
    "семёрка",
    "восьмёрка",
    "девятка",
    "десятка",
    "валет",
    "дама",
    "король",
    "туз"
  };

  private static final String[] MANY = {
    "двойки",
    "тройки",
    "четвёрки",
    "пятёрки",
    "шестёрки",
    "семёрки",
    "восьмёрки",
    "девятки",
    "десятки",
    "валеты",
    "дамы",
    "короли",
    "тузы"
  };

  private static final String[] OF = {
    "двоек",
    "троек",
    "четвёрок",
    "пятёрок",
    "шестёрок",
    "семёрок",
    "восьмёрок",
    "девяток",
    "десяток",
    "валетов",
    "дам",
    "королей",
    "тузов"
  };

  private static final String[] UPTO = {
    "двойки",
    "тройки",
    "четвёрки",
    "пятёрки",
    "шестёрки",
    "семёрки",
    "восьмёрки",
    "девятки",
    "десятки",
    "валета",
    "дамы",
    "короля",
    "туза"
  };

  private static final String[] SHORT = {
    "Старшая карта", "Пара", "Две пары", "Сет", "Стрит", "Флеш", "Фулл-хаус", "Каре", "Стрит-флеш"
  };

  private Hands() {}

  /**
   * Готовая рука: чем она является, насколько сильна и из каких карт собрана.
   *
   * @param cards ровно пять карт — те, что участвуют в комбинации, а не все семь
   */
  public record Hand(
      Category category, int score, List<Integer> cards, String name, String shortName)
      implements Comparable<Hand> {
    @Override
    public int compareTo(Hand other) {
      return Integer.compare(score, other.score);
    }
  }

  /** Лучшая пятёрка из пяти, шести или семи карт. */
  public static Hand best(List<Integer> cards) {
    if (cards.size() < 5) throw new IllegalArgumentException("Комбинация собирается из пяти карт");
    if (cards.size() == 5) return score(cards);
    Hand best = null;
    var five = new int[5];
    int n = cards.size();
    for (int a = 0; a < n - 4; a++)
      for (int b = a + 1; b < n - 3; b++)
        for (int c = b + 1; c < n - 2; c++)
          for (int d = c + 1; d < n - 1; d++)
            for (int e = d + 1; e < n; e++) {
              five[0] = cards.get(a);
              five[1] = cards.get(b);
              five[2] = cards.get(c);
              five[3] = cards.get(d);
              five[4] = cards.get(e);
              var hand = score(List.of(five[0], five[1], five[2], five[3], five[4]));
              if (best == null || hand.score() > best.score()) best = hand;
            }
    return best;
  }

  private static Hand score(List<Integer> five) {
    var sorted = new ArrayList<>(five);
    sorted.sort(Comparator.comparingInt(Cards::rank).reversed());
    int[] byRank = new int[13];
    int[] bySuit = new int[4];
    for (int card : sorted) {
      byRank[Cards.rank(card)]++;
      bySuit[Cards.suit(card)]++;
    }
    boolean flush = false;
    for (int count : bySuit) if (count == 5) flush = true;
    int straightHigh = straight(byRank);
    if (flush && straightHigh >= 0)
      return hand(Category.STRAIGHT_FLUSH, order(sorted, straightHigh), straightHigh);
    // Группы: сначала по количеству одинаковых, потом по старшинству. Каре тузов с королём и
    // каре тузов с дамой различаются именно здесь, вторым членом.
    var groups = new ArrayList<int[]>();
    for (int rank = 12; rank >= 0; rank--)
      if (byRank[rank] > 0) groups.add(new int[] {byRank[rank], rank});
    groups.sort((x, y) -> x[0] != y[0] ? y[0] - x[0] : y[1] - x[1]);
    int[] ranks = groups.stream().mapToInt(group -> group[1]).toArray();
    if (groups.get(0)[0] == 4) return hand(Category.QUADS, sorted, ranks[0], ranks[1]);
    if (groups.get(0)[0] == 3 && groups.size() > 1 && groups.get(1)[0] == 2)
      return hand(Category.FULL_HOUSE, sorted, ranks[0], ranks[1]);
    if (flush)
      return hand(
          Category.FLUSH,
          sorted,
          Cards.rank(sorted.get(0)),
          Cards.rank(sorted.get(1)),
          Cards.rank(sorted.get(2)),
          Cards.rank(sorted.get(3)),
          Cards.rank(sorted.get(4)));
    if (straightHigh >= 0)
      return hand(Category.STRAIGHT, order(sorted, straightHigh), straightHigh);
    if (groups.get(0)[0] == 3) return hand(Category.TRIPS, sorted, ranks[0], ranks[1], ranks[2]);
    if (groups.get(0)[0] == 2 && groups.get(1)[0] == 2)
      return hand(Category.TWO_PAIR, sorted, ranks[0], ranks[1], ranks[2]);
    if (groups.get(0)[0] == 2)
      return hand(Category.PAIR, sorted, ranks[0], ranks[1], ranks[2], ranks[3]);
    return hand(Category.HIGH_CARD, sorted, ranks[0], ranks[1], ranks[2], ranks[3], ranks[4]);
  }

  /** Старшая карта стрита или -1. Туз играет и снизу: A-2-3-4-5 — это стрит до пятёрки. */
  private static int straight(int[] byRank) {
    for (int high = 12; high >= 4; high--) {
      boolean all = true;
      for (int step = 0; step < 5; step++) if (byRank[high - step] == 0) all = false;
      if (all) return high;
    }
    if (byRank[12] > 0 && byRank[0] > 0 && byRank[1] > 0 && byRank[2] > 0 && byRank[3] > 0)
      return 3;
    return -1;
  }

  /** Карты стрита по порядку, с тузом внизу, если это «колесо». */
  private static List<Integer> order(List<Integer> sorted, int high) {
    var result = new ArrayList<Integer>(5);
    for (int step = 0; step < 5; step++) {
      int rank = high - step;
      if (rank < 0) rank += 13;
      for (int card : sorted)
        if (Cards.rank(card) == rank && result.stream().noneMatch(taken -> taken == card)) {
          result.add(card);
          break;
        }
    }
    return result;
  }

  private static Hand hand(Category category, List<Integer> cards, int... tiebreak) {
    int score = category.ordinal() << 20;
    for (int i = 0; i < 5; i++) score |= (i < tiebreak.length ? tiebreak[i] : 0) << (16 - i * 4);
    return new Hand(
        category, score, List.copyOf(cards), name(category, tiebreak), SHORT[category.ordinal()]);
  }

  private static String name(Category category, int[] tiebreak) {
    int first = tiebreak.length > 0 ? tiebreak[0] : 0;
    int second = tiebreak.length > 1 ? tiebreak[1] : 0;
    return switch (category) {
      case STRAIGHT_FLUSH -> first == 12 ? "Флеш-рояль" : "Стрит-флеш до " + UPTO[first];
      case QUADS -> "Каре " + OF[first];
      case FULL_HOUSE -> "Фулл-хаус: " + MANY[first] + " и " + MANY[second];
      case FLUSH -> "Флеш до " + UPTO[first];
      case STRAIGHT -> "Стрит до " + UPTO[first];
      case TRIPS -> "Сет " + OF[first];
      case TWO_PAIR -> "Две пары: " + MANY[first] + " и " + MANY[second];
      case PAIR -> "Пара " + OF[first];
      case HIGH_CARD -> "Старшая карта — " + ONE[first];
    };
  }
}
