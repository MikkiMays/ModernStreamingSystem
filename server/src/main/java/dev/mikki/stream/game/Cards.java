package dev.mikki.stream.game;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

/**
 * Колода и честная тасовка.
 *
 * <p>Карта — число от 0 до 51: {@code номинал = карта / 4} (0 — двойка, 12 — туз), {@code масть =
 * карта % 4} (s, h, d, c). Так карта помещается в одно число в снимке комнаты, а сравнение
 * номиналов не требует разбора строк.
 *
 * <p>ПОЧЕМУ ТАСОВКА ДЕТЕРМИНИРОВАННАЯ, А НЕ ПРОСТО СЛУЧАЙНАЯ. Играют не с казино, а друг с другом,
 * и сервер здесь — чужая машина, которой приходится верить на слово. Поэтому перед раздачей
 * объявляется <b>обязательство</b>: SHA-256 от случайного зерна. Само зерно раскрывается, когда
 * раздача кончилась. Кто угодно может повторить тасовку по зерну и убедиться, что карты легли ровно
 * так, как легли, — и что хеш, объявленный до раздачи, соответствует этому зерну. Подменить карту
 * посреди раздачи нельзя: хеш уже у всех на руках.
 *
 * <p>Алгоритм намеренно простой, чтобы его можно было повторить в браузере за десять строк: поток
 * случайных байт — это {@code SHA-256(зерно + ":" + счётчик)}, склеенные подряд; тасовка —
 * Фишер-Йетс с конца, где очередное число берётся четырьмя байтами с отбрасыванием остатка
 * (rejection sampling), чтобы распределение оставалось равномерным.
 */
public final class Cards {
  public static final int DECK = 52;
  private static final char[] RANKS = "23456789TJQKA".toCharArray();
  private static final char[] SUITS = {'s', 'h', 'd', 'c'};
  private static final SecureRandom RANDOM = new SecureRandom();

  private Cards() {}

  public static int rank(int card) {
    return card / 4;
  }

  public static int suit(int card) {
    return card % 4;
  }

  /** Как карта называется в проводе: {@code As}, {@code Td}, {@code 7h}. */
  public static String text(int card) {
    return String.valueOf(RANKS[rank(card)]) + SUITS[suit(card)];
  }

  public static List<String> texts(List<Integer> cards) {
    return cards.stream().map(card -> text(card)).toList();
  }

  /** Тридцать два случайных байта в шестнадцатеричном виде. */
  public static String seed() {
    var bytes = new byte[32];
    RANDOM.nextBytes(bytes);
    return hex(bytes);
  }

  /** Обязательство: то, что объявляется до раздачи и проверяется после. */
  public static String commitment(String seed) {
    return hex(sha256(seed.getBytes(StandardCharsets.UTF_8)));
  }

  /**
   * Колода, разложенная зерном. Первая карта списка — верхняя.
   *
   * <p>Тот же порядок получит любой, кто повторит эти двадцать строк у себя.
   */
  public static List<Integer> shuffle(String seed) {
    return shuffle(seed, deck(DECK));
  }

  /**
   * Колода на {@code size} карт: 52 — полная, 36 — от шестёрки и выше.
   *
   * <p>ТРИДЦАТЬ ШЕСТЬ — ЭТО ПОДМНОЖЕСТВО ПЯТИДЕСЯТИ ДВУХ, А НЕ ДРУГАЯ НУМЕРАЦИЯ. Младшие номиналы
   * просто не кладутся в колоду, а карта остаётся тем же числом, {@code rank} — тем же сравнением,
   * {@code text} — той же строкой. Иначе у дурака завелась бы собственная арифметика карт, и
   * «семёрка» означала бы в двух играх разные числа.
   */
  public static List<Integer> deck(int size) {
    int skip = (DECK - size) / 4;
    var cards = new ArrayList<Integer>(size);
    for (int card = skip * 4; card < DECK; card++) cards.add(card);
    return cards;
  }

  /**
   * Та же тасовка для колоды любой длины.
   *
   * <p>Фишер-Йетс и поток байт здесь общие с полной колодой: у колоды на 36 карт меняется только
   * длина, а не алгоритм, — и повторить её в браузере по-прежнему можно теми же десятью строками.
   */
  public static List<Integer> shuffle(String seed, List<Integer> deck) {
    var cards = new ArrayList<>(deck);
    var stream = new ByteStream(seed);
    for (int i = cards.size() - 1; i > 0; i--) {
      int j = stream.below(i + 1);
      var swap = cards.get(i);
      cards.set(i, cards.get(j));
      cards.set(j, swap);
    }
    return cards;
  }

  /** Бесконечный поток байт из зерна: {@code SHA-256(зерно:0)}, {@code SHA-256(зерно:1)}, … */
  private static final class ByteStream {
    private final String seed;
    private byte[] block = new byte[0];
    private int offset;
    private int counter;

    ByteStream(String seed) {
      this.seed = seed;
    }

    private int next() {
      if (offset >= block.length) {
        block = sha256((seed + ":" + counter++).getBytes(StandardCharsets.UTF_8));
        offset = 0;
      }
      return block[offset++] & 0xff;
    }

    /**
     * Равномерное число меньше {@code bound}.
     *
     * <p>Просто «остаток от деления» дал бы перекос в сторону младших значений: 2^32 не делится на
     * 52 нацело. Поэтому верхний хвост, который делится неровно, отбрасывается целиком.
     */
    int below(int bound) {
      long limit = (1L << 32) - ((1L << 32) % bound);
      while (true) {
        long value = ((long) next() << 24) | (next() << 16) | (next() << 8) | next();
        if (value < limit) return (int) (value % bound);
      }
    }
  }

  private static byte[] sha256(byte[] value) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(value);
    } catch (Exception e) {
      throw new IllegalStateException("SHA-256 недоступен", e);
    }
  }

  private static String hex(byte[] bytes) {
    var text = new StringBuilder(bytes.length * 2);
    for (byte b : bytes)
      text.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
    return text.toString();
  }
}
