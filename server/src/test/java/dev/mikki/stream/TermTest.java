package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.mikki.stream.config.Term;
import java.time.Duration;
import org.junit.jupiter.api.Test;

/**
 * Срок словами читается одинаково, как его ни напиши, — и не читается вовсе, если написан не так.
 *
 * <p>ЗАЧЕМ ТЕСТ. Это единственное место, где чужая строка превращается в необратимое удаление.
 * Молчаливое «не понял, возьму значение по умолчанию» здесь хуже отказа: сервер поднимется и будет
 * удалять встречи не тогда, когда попросили, а узнают об этом по пропавшей переписке.
 */
class TermTest {
  @Test
  void readsTheSameSpanHoweverItIsWritten() {
    assertThat(Term.parse("7 days")).isEqualTo(Duration.ofDays(7));
    assertThat(Term.parse("7 day")).isEqualTo(Duration.ofDays(7));
    assertThat(Term.parse("7d")).isEqualTo(Duration.ofDays(7));
    assertThat(Term.parse("  7   DAYS ")).isEqualTo(Duration.ofDays(7));
    assertThat(Term.parse("week")).isEqualTo(Duration.ofDays(7));
    assertThat(Term.parse("3 months")).isEqualTo(Duration.ofDays(90));
    assertThat(Term.parse("month")).isEqualTo(Duration.ofDays(30));
    assertThat(Term.parse("year")).isEqualTo(Duration.ofDays(365));
    assertThat(Term.parse("90m")).isEqualTo(Duration.ofMinutes(90));
    assertThat(Term.parse("1 day 12 hours")).isEqualTo(Duration.ofHours(36));
    assertThat(Term.parse("30s")).isEqualTo(Duration.ofSeconds(30));
  }

  /** Месяц — только словом: {@code m} рядом с {@code mo} означает минуты, и ничего больше. */
  @Test
  void aSingleMIsMinutesAndNeverMonths() {
    assertThat(Term.parse("3m")).isEqualTo(Duration.ofMinutes(3));
    assertThat(Term.parse("3mo")).isEqualTo(Duration.ofDays(90));
  }

  @Test
  void knowsNeverAndImmediately() {
    assertThat(Term.parse("never")).isEqualTo(Term.FOREVER);
    assertThat(Term.parse("forever")).isEqualTo(Term.FOREVER);
    // Срок длиннее «никогда» — это то же «никогда»: арифметика времени не должна
    // переполняться от опечатки в нулях.
    assertThat(Term.parse("1000 years")).isEqualTo(Term.FOREVER);
    assertThat(Term.parse("immediately")).isEqualTo(Duration.ZERO);
    assertThat(Term.parse("0")).isEqualTo(Duration.ZERO);
  }

  @Test
  void refusesWhatItCannotRead() {
    for (var wrong : new String[] {"", "  ", "soon", "7 dayz", "7 days or so", "-1d", "dogs"})
      assertThatThrownBy(() -> Term.parse(wrong)).isInstanceOf(IllegalArgumentException.class);
  }
}
