package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.config.Rate;
import dev.mikki.stream.shared.Problem;
import java.time.Duration;
import org.junit.jupiter.api.Test;

/**
 * Предел словами ({@code 10 per hour}) читается однозначно, а окно у него — любой длины (WP1-9).
 *
 * <p>Раньше окно было зашито в шестьдесят секунд, и «десять встреч в час» выразить было нечем.
 */
class RateTest {
  @Test
  void readsCountAndWindowInWords() {
    assertThat(Rate.parse("10 per hour")).isEqualTo(new Rate(10, Duration.ofHours(1)));
    assertThat(Rate.parse("20 per minute")).isEqualTo(new Rate(20, Duration.ofMinutes(1)));
    assertThat(Rate.parse("300 per 1 minute")).isEqualTo(new Rate(300, Duration.ofMinutes(1)));
    assertThat(Rate.parse(" 10 PER 10 minutes ")).isEqualTo(new Rate(10, Duration.ofMinutes(10)));
    assertThat(Rate.parse("5/minute")).isEqualTo(new Rate(5, Duration.ofMinutes(1)));
    assertThat(Rate.parse("off").unlimited()).isTrue();
  }

  @Test
  void refusesWhatItCannotRead() {
    for (var wrong :
        new String[] {"", "10", "per hour", "ten per hour", "10 per never", "-1 per h"})
      assertThatThrownBy(() -> Rate.parse(wrong)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> Rate.parse("0 per hour")).isInstanceOf(IllegalArgumentException.class);
  }

  /** Окно в час: одиннадцатый в течение часа — отказ, хотя минута давно прошла бы. */
  @Test
  void aWindowLongerThanAMinuteHolds() {
    var limits = RateLimits.inMemory();
    var rate = Rate.parse("3 per hour");
    for (int i = 0; i < 3; i++) limits.check("test-hour:" + RateTest.class, rate, "X", "x");
    assertThatThrownBy(() -> limits.check("test-hour:" + RateTest.class, rate, "X", "Отказ"))
        .isInstanceOfSatisfying(Problem.class, p -> assertThat(p.code()).isEqualTo("X"));
    // Счётчик без шага — тот же, что видит проверка.
    assertThat(limits.count("test-hour:" + RateTest.class, rate)).isEqualTo(4);
  }
}
