package dev.mikki.stream.config;

import java.time.Duration;
import java.util.Locale;
import java.util.regex.Pattern;
import org.springframework.util.unit.DataSize;

/**
 * Объём за срок, записанный словами: {@code 2GB per 1 day}, {@code 500MB per hour}, {@code off}.
 *
 * <p>ЗАЧЕМ ОТДЕЛЬНО ОТ {@link Rate}. Предел частоты считает штуки — входы, сообщения, промахи.
 * Квота загрузок на адрес (A10 модели угроз) считает байты, а «два миллиарда в сутки» в {@code
 * application.yml} читалось бы хуже, чем «2GB per 1 day». Размер разбирает {@link DataSize} Spring
 * (как {@code 100GB} у потолков кинозала), срок — {@link Term}, «без предела» — {@code off}.
 */
public record Allowance(long bytes, Duration period) {
  public static final Allowance OFF = new Allowance(Long.MAX_VALUE, Duration.ofDays(1));

  private static final Pattern FORM =
      Pattern.compile("(\\d{1,12})\\s*([a-z]{0,2})\\s*(?:per|/|в)\\s*(.+)");

  public Allowance {
    if (bytes < 1 || period == null || period.isZero() || period.isNegative())
      throw problem(bytes + " per " + period);
    if (period.equals(Term.FOREVER)) throw problem(bytes + " per " + period);
  }

  public boolean unlimited() {
    return bytes == Long.MAX_VALUE;
  }

  public static Allowance parse(String text) {
    if (text == null || text.isBlank()) throw problem(text);
    var clean = text.trim().toLowerCase(Locale.ROOT);
    if (clean.equals("off") || clean.equals("unlimited") || clean.equals("нет")) return OFF;
    var matcher = FORM.matcher(clean);
    if (!matcher.matches()) throw problem(text);
    try {
      return new Allowance(
          DataSize.parse(matcher.group(1) + matcher.group(2).toUpperCase(Locale.ROOT)).toBytes(),
          Term.parse(matcher.group(3)));
    } catch (IllegalArgumentException e) {
      throw problem(text);
    }
  }

  private static IllegalArgumentException problem(String text) {
    return new IllegalArgumentException(
        "Не понимаю квоту «" + text + "». Ожидается «2GB per 1 day», «500MB per hour» или «off»");
  }
}
