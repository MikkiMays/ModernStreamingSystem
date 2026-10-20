package dev.mikki.stream.room;

import dev.mikki.stream.shared.Problem;
import java.text.Normalizer;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Имена, которые видят другие: участника, встречи, файла (A5, A7 модели угроз).
 *
 * <p>ПОДМЕНА НАПРАВЛЕНИЯ. Символ U+202E переворачивает текст после себя: {@code счёт‮fdp.exe} в
 * списке выглядит как {@code счётexe.pdf}. Такие символы (U+202A–U+202E, U+2066–U+2069, метки
 * U+200E/U+200F), невидимые нулевой ширины (U+200B–U+200D, U+2060, U+FEFF) и управляющие из имени
 * уходят. Человеку они не нужны ни в одном языке, который Cord показывает.
 *
 * <p>ЧУЖОЕ ИМЯ. «Поддержка Cord», «Администратор» — фишинг именем участника: человек видит в списке
 * того, кому доверяет. Слова под Cord, администратора, модератора и поддержку именем быть не могут,
 * в том числе латиница вперемешку с похожей кириллицей ({@code Сord}). Сравнивается слово целиком:
 * «Корделия» и «Админка Пети» — обычные имена.
 */
public final class Names {
  private Names() {}

  private static final Pattern HIDDEN =
      Pattern.compile("[\\p{Cntrl}\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2069\\uFEFF\\u00AD]");
  private static final Pattern SPACES = Pattern.compile("\\s+");
  private static final Pattern WORDS = Pattern.compile("[^\\p{L}\\p{N}]+");

  /** Кириллица, которую не отличить от латиницы глазами, — к одному виду. */
  private static final String LOOKALIKE_FROM = "аеорсухкмтнвіј";

  private static final String LOOKALIKE_TO = "aeopcyxkmthbij";

  private static final Set<String> RESERVED =
      Set.of(
          "cord",
          "корд",
          "admin",
          "administrator",
          "админ",
          "администратор",
          "администрация",
          "moderator",
          "модератор",
          "support",
          "поддержка",
          "техподдержка");

  private static final Set<String> RESERVED_SKELETONS =
      RESERVED.stream().map(Names::skeleton).collect(java.util.stream.Collectors.toSet());

  /** Без невидимых и переворачивающих символов, пробелы — по одному. */
  public static String clean(String value) {
    if (value == null) return "";
    var text = HIDDEN.matcher(Normalizer.normalize(value, Normalizer.Form.NFC)).replaceAll("");
    return SPACES.matcher(text).replaceAll(" ").strip();
  }

  /** Имя участника: очищенное, не пустое и не чужое. */
  public static String person(String value) {
    var name = clean(value);
    if (name.isEmpty()) throw new Problem(400, "NAME_INVALID", "Введите имя");
    for (var word : WORDS.split(name.toLowerCase(Locale.ROOT)))
      if (!word.isEmpty() && RESERVED_SKELETONS.contains(skeleton(word)))
        throw new Problem(
            400, "NAME_RESERVED", "Такое имя занято: так нельзя называть участника встречи");
    return name;
  }

  /** Название встречи: очищенное и не пустое. */
  public static String title(String value) {
    var title = clean(value);
    if (title.isEmpty()) throw new Problem(400, "TITLE_INVALID", "Введите название встречи");
    return title;
  }

  private static String skeleton(String word) {
    var out = new StringBuilder(word.length());
    for (char c : word.toLowerCase(Locale.ROOT).toCharArray()) {
      int i = LOOKALIKE_FROM.indexOf(c);
      out.append(i >= 0 ? LOOKALIKE_TO.charAt(i) : c);
    }
    return out.toString();
  }
}
