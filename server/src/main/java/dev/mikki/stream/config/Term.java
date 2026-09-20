package dev.mikki.stream.config;

import java.time.Duration;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Срок, записанный словами: {@code 7 days}, {@code 3 months}, {@code month}, {@code 90m}, {@code
 * never}, {@code immediately}.
 *
 * <p>ЗАЧЕМ. Сроки хранения задаются тем, кто ставит сервер, и правит он их в {@code
 * application.yml} — раз в жизни установки и обычно в спешке. {@code 7776000} в этом месте ничего
 * не сообщает: чтобы понять, три это месяца или три недели, надо делить в уме. Spring умеет читать
 * {@code 7d} и {@code PT2H}, но не знает ни месяцев, ни «никогда», а ровно этих двух ответов здесь
 * и ждут.
 *
 * <p>ЕДИНИЦЫ. Как у планировщиков: число и слово, с окончанием {@code s} или без — {@code 1 day} и
 * {@code 2 days} одинаково законны, число можно опустить ({@code month} — это {@code 1 month}).
 * Короткие формы тоже: {@code s}, {@code m}, {@code h}, {@code d}, {@code w}, {@code mo}, {@code
 * y}. <b>{@code m} — это минуты, а месяц — только {@code mo} или {@code month}</b>: перепутать их в
 * сроке удаления стоило бы чужой переписки, поэтому сокращения до одной буквы у месяца нет.
 *
 * <p>МЕСЯЦ И ГОД — это 30 и 365 дней. Календарных месяцев здесь быть не может: срок считается от
 * последнего входа, а не от даты в календаре, и «три месяца» означает длину, а не число в следующем
 * месяце.
 *
 * <p>«Никогда» — это {@link #FOREVER}, сто лет, а не бесконечность: сравнения со временем остаются
 * обычной арифметикой, и ни одно из них не переполняется. Отдельного значения для «никогда» в коде
 * нет намеренно — иначе каждая проверка срока обзавелась бы веткой про {@code null}.
 */
public final class Term {
  /** «Никогда» на языке арифметики. Сто лет переживут и установку, и диск под ней. */
  public static final Duration FOREVER = Duration.ofDays(36500);

  private static final Pattern PART = Pattern.compile("(\\d+)?\\s*([a-zа-я]+)");
  private static final Map<String, Duration> UNITS =
      Map.ofEntries(
          Map.entry("s", Duration.ofSeconds(1)),
          Map.entry("sec", Duration.ofSeconds(1)),
          Map.entry("second", Duration.ofSeconds(1)),
          Map.entry("m", Duration.ofMinutes(1)),
          Map.entry("min", Duration.ofMinutes(1)),
          Map.entry("minute", Duration.ofMinutes(1)),
          Map.entry("h", Duration.ofHours(1)),
          Map.entry("hour", Duration.ofHours(1)),
          Map.entry("d", Duration.ofDays(1)),
          Map.entry("day", Duration.ofDays(1)),
          Map.entry("w", Duration.ofDays(7)),
          Map.entry("week", Duration.ofDays(7)),
          Map.entry("mo", Duration.ofDays(30)),
          Map.entry("month", Duration.ofDays(30)),
          Map.entry("y", Duration.ofDays(365)),
          Map.entry("year", Duration.ofDays(365)));
  // Разбор одной и той же строки повторяется на каждый проход уборки по каждой комнате.
  // Строк этих три, и меняются они только при перезапуске.
  private static final Map<String, Duration> PARSED = new ConcurrentHashMap<>();

  private Term() {}

  public static Duration parse(String text) {
    if (text == null || text.isBlank()) throw problem(text);
    return PARSED.computeIfAbsent(text.trim().toLowerCase(Locale.ROOT), Term::read);
  }

  private static Duration read(String text) {
    if (text.equals("never") || text.equals("forever") || text.equals("никогда")) return FOREVER;
    if (text.equals("immediately") || text.equals("now") || text.equals("сразу"))
      return Duration.ZERO;
    if (text.equals("0")) return Duration.ZERO;
    var matcher = PART.matcher(text);
    var total = Duration.ZERO;
    int end = 0;
    boolean found = false;
    while (matcher.find()) {
      found = true;
      // Куски идут подряд через пробел: «1 day 12 hours» законно, «-1d» и «1 day, ещё чуть» — нет.
      if (!text.substring(end, matcher.start()).isBlank()) throw problem(text);
      end = matcher.end();
      long count = matcher.group(1) == null ? 1 : Long.parseLong(matcher.group(1));
      var unit = UNITS.get(singular(matcher.group(2)));
      if (unit == null) throw problem(text);
      total = total.plus(unit.multipliedBy(count));
    }
    if (end != text.length() || !found) throw problem(text);
    return total.compareTo(FOREVER) >= 0 ? FOREVER : total;
  }

  /** {@code days} и {@code day} — одно и то же слово: планировщики понимают обе формы. */
  private static String singular(String unit) {
    return unit.length() > 2 && unit.endsWith("s") ? unit.substring(0, unit.length() - 1) : unit;
  }

  private static IllegalArgumentException problem(String text) {
    return new IllegalArgumentException(
        "Не понимаю срок «"
            + text
            + "». Ожидается «7 days», «3 months», «month», «90m», «never» или «immediately»"
            + " (m — минуты, месяц — mo или month)");
  }
}
