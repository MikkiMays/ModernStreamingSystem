package dev.mikki.stream.config;

import java.time.Duration;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Предел частоты, записанный словами: {@code 10 per hour}, {@code 20 per minute}, {@code 2 per 10
 * minutes}, {@code off}.
 *
 * <p>ЗАЧЕМ. Пределы антибота ({@code stream.abuse.*}, E11) правит тот, кто ставит сервер, — как и
 * сроки хранения. «Десять встреч в час» в {@code application.yml} должно читаться как десять в час,
 * а не как пара чисел, одно из которых — секунды. Окно разбирает {@link Term}, поэтому единицы те
 * же: {@code hour}, {@code 10 minutes}, {@code 1 day}.
 *
 * <p>{@code off} — предела нет. Это не ноль: ноль запретил бы действие совсем, а такая опечатка в
 * пределе закрыла бы сервер. Поэтому {@code 0 per hour} не читается вовсе.
 */
public record Rate(int count, Duration period) {
  /** «Без предела» на языке арифметики. */
  public static final Rate OFF = new Rate(Integer.MAX_VALUE, Duration.ofMinutes(1));

  private static final Pattern FORM = Pattern.compile("(\\d{1,9})\\s*(?:per|/|в)\\s*(.+)");

  public Rate {
    if (count < 1) throw problem(count + " per " + period);
    if (period == null || period.isZero() || period.isNegative() || period.equals(Term.FOREVER))
      throw problem(count + " per " + period);
  }

  public static Rate perMinute(int count) {
    return new Rate(count, Duration.ofMinutes(1));
  }

  public boolean unlimited() {
    return count == Integer.MAX_VALUE;
  }

  public static Rate parse(String text) {
    if (text == null || text.isBlank()) throw problem(text);
    var clean = text.trim().toLowerCase(Locale.ROOT);
    if (clean.equals("off") || clean.equals("unlimited") || clean.equals("нет")) return OFF;
    var matcher = FORM.matcher(clean);
    if (!matcher.matches()) throw problem(text);
    Duration period;
    try {
      period = Term.parse(matcher.group(2));
    } catch (IllegalArgumentException e) {
      throw problem(text);
    }
    try {
      return new Rate(Integer.parseInt(matcher.group(1)), period);
    } catch (IllegalArgumentException e) {
      throw problem(text);
    }
  }

  private static IllegalArgumentException problem(String text) {
    return new IllegalArgumentException(
        "Не понимаю предел «"
            + text
            + "». Ожидается «10 per hour», «20 per minute», «2 per 10 minutes» или «off»");
  }
}
