package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.config.Allowance;
import java.time.Duration;
import org.junit.jupiter.api.Test;

/**
 * Объём за срок словами ({@code 2GB per 1 day}) — квота загрузок на адрес (A10 модели угроз).
 *
 * <p>Предел частоты ({@code Rate}) считает штуки; квота считает байты, поэтому у неё своя запись,
 * но тот же срок ({@code Term}) и то же «off».
 */
class AllowanceTest {
  @Test
  void readsVolumeAndWindowInWords() {
    assertThat(Allowance.parse("2GB per 1 day"))
        .isEqualTo(new Allowance(2L * 1024 * 1024 * 1024, Duration.ofDays(1)));
    assertThat(Allowance.parse(" 500MB per hour "))
        .isEqualTo(new Allowance(500L * 1024 * 1024, Duration.ofHours(1)));
    assertThat(Allowance.parse("off").unlimited()).isTrue();
  }

  @Test
  void refusesWhatItCannotRead() {
    for (var wrong :
        new String[] {"", "2GB", "per day", "two GB per day", "0GB per day", "2GB per never"})
      assertThatThrownBy(() -> Allowance.parse(wrong)).isInstanceOf(IllegalArgumentException.class);
  }

  /** Байты складываются в одно окно: третий гигабайт за сутки в квоту в два уже не входит. */
  @Test
  void bytesAddUpWithinTheWindow() {
    var limits = RateLimits.inMemory();
    var quota = Allowance.parse("2GB per 1 day");
    var key = "uploads:test:" + AllowanceTest.class;
    long gigabyte = 1024L * 1024 * 1024;
    assertThat(limits.fits(key, quota, gigabyte)).isTrue();
    limits.add(key, quota, gigabyte);
    assertThat(limits.fits(key, quota, gigabyte)).isTrue();
    limits.add(key, quota, gigabyte);
    assertThat(limits.fits(key, quota, 1)).isFalse();
    assertThat(limits.used(key, quota)).isEqualTo(2 * gigabyte);
  }
}
