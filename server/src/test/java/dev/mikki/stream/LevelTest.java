package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.mikki.stream.config.Level;
import dev.mikki.stream.config.StreamProperties;
import java.time.Duration;
import org.junit.jupiter.api.Test;

/**
 * Уровень качества читается так, как его пишут в плеере, — и не читается вовсе, если написан не
 * так.
 *
 * <p>ЗАЧЕМ ТЕСТ. Это умолчание и потолок для всех, кто входит на сервер: молчаливое «не понял,
 * возьму 720p30» здесь хуже отказа — сервер поднимется, а владелец будет уверен, что раздаёт
 * 1080p60.
 */
class LevelTest {
  @Test
  void readsALevelHoweverItIsWritten() {
    assertThat(Level.parse("720p30")).isEqualTo(new Level(720, 30));
    assertThat(Level.parse(" 1080P60 ")).isEqualTo(new Level(1080, 60));
    assertThat(Level.parse("1440p15")).isEqualTo(new Level(1440, 15));
    assertThat(new Level(1080, 60).toString()).isEqualTo("1080p60");
  }

  @Test
  void refusesWhatNeitherTheEncoderNorTheClientKnows() {
    for (var text : new String[] {"", "720", "720p", "p30", "600p30", "720p25", "4k", "1080x60"})
      assertThatThrownBy(() -> Level.parse(text))
          .as(text)
          .isInstanceOf(IllegalArgumentException.class)
          .hasMessageContaining("stream.media.quality");
  }

  /**
   * Потолок считается по кадру и частоте отдельно: 1440p30 не ниже 1080p60, хотя стоит столько же.
   */
  @Test
  void aCeilingBindsBothDimensions() {
    var ceiling = new Level(1080, 60);
    assertThat(new Level(720, 30).within(ceiling)).isTrue();
    assertThat(new Level(1080, 60).within(ceiling)).isTrue();
    assertThat(new Level(1440, 30).within(ceiling)).isFalse();
    assertThat(new Level(720, 60).within(new Level(1080, 30))).isFalse();
  }

  @Test
  void theDefaultMustFitUnderTheCeilingAndSettleMustBeShort() {
    assertThat(quality("720p30", "1080p60", Duration.ofSeconds(4)).isDefaultWithinCeiling())
        .isTrue();
    assertThat(quality("1080p60", "720p30", Duration.ofSeconds(4)).isDefaultWithinCeiling())
        .isFalse();
    assertThat(quality("720p30", "1080p60", Duration.ofSeconds(4)).isSettleSane()).isTrue();
    assertThat(quality("720p30", "1080p60", Duration.ZERO).isSettleSane()).isTrue();
    assertThat(quality("720p30", "1080p60", Duration.ofMinutes(2)).isSettleSane()).isFalse();
  }

  private static StreamProperties.Media.Quality quality(
      String initial, String ceiling, Duration settle) {
    return new StreamProperties.Media.Quality(
        Level.parse(initial), Level.parse(ceiling), settle, false);
  }
}
