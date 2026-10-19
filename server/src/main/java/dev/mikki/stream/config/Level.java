package dev.mikki.stream.config;

import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Уровень качества видео, записанный так, как его пишут в плеере: {@code 720p30}, {@code 1080p60}.
 *
 * <p>ЗАЧЕМ. Умолчание и потолок качества задаёт тот, кто ставит сервер (П2 в {@code DECISIONS.md}),
 * и правит он их в {@code application.yml}. Два отдельных числа («высота» и «частота») в двух
 * ключах друг от друга отрываются; {@code 1080p60} — одно слово, которое читается без справочника.
 *
 * <p>Множества зашиты намеренно: таблица битрейтов в вебе ({@code media/profiles.ts}) знает ровно
 * 720/1080/1440 и 15/30/60, и уровень, которого там нет, стал бы не «чуть иным качеством», а
 * отсутствием публикации. Неизвестное значение — отказ при старте, а не молчаливое «возьму 720p30»:
 * владелец должен знать, что раздаёт, а не верить, что раздаёт.
 */
public record Level(int resolution, int fps) {
  public static final List<Integer> RESOLUTIONS = List.of(720, 1080, 1440);
  public static final List<Integer> FRAME_RATES = List.of(15, 30, 60);
  private static final Pattern FORM = Pattern.compile("(\\d{3,4})p(\\d{2})");

  public Level {
    if (!RESOLUTIONS.contains(resolution) || !FRAME_RATES.contains(fps))
      throw problem(resolution + "p" + fps);
  }

  public static Level parse(String text) {
    if (text == null) throw problem(text);
    var matcher = FORM.matcher(text.trim().toLowerCase(Locale.ROOT));
    if (!matcher.matches()) throw problem(text);
    return new Level(Integer.parseInt(matcher.group(1)), Integer.parseInt(matcher.group(2)));
  }

  /** Не выше другого уровня ни по кадру, ни по частоте — потолок считается по обоим измерениям. */
  public boolean within(Level ceiling) {
    return resolution <= ceiling.resolution && fps <= ceiling.fps;
  }

  @Override
  public String toString() {
    return resolution + "p" + fps;
  }

  private static IllegalArgumentException problem(String text) {
    return new IllegalArgumentException(
        "stream.media.quality: не понимаю уровень «"
            + text
            + "». Пишется как в плеере — 720p30, 1080p60; высота 720, 1080 или 1440, частота 15, 30"
            + " или 60");
  }
}
