package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;

import dev.mikki.stream.media.ScreenGrace;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Запасной путь открытия показа ждёт окно разгона.
 *
 * <p>ЗАЧЕМ. Отправитель теперь шлёт {@code screen.started}, когда верхний слой пошёл в целевом
 * размере (T48). Реконсайлер при этом видел дорожку у SFU через две секунды и открывал показ сам —
 * то есть раньше отправителя, и вся выдержка пропадала. Он остаётся запасным путём для старых
 * клиентов, но не раньше, чем кончится окно.
 */
class ScreenGraceTest {
  @Test
  void opensOnlyAfterTheTrackHasBeenSeenForTheWholeWindow() {
    var grace = new ScreenGrace(4000);
    assertThat(grace.due("room:a:sid", 1000)).isFalse();
    assertThat(grace.due("room:a:sid", 3000)).isFalse();
    assertThat(grace.due("room:a:sid", 4999)).isFalse();
    assertThat(grace.due("room:a:sid", 5000)).isTrue();
  }

  /** Новая дорожка — новое окно: прежний показ того же человека к ней отношения не имеет. */
  @Test
  void forgetsWhatIsNoLongerPublishedAndStartsOverForANewTrack() {
    var grace = new ScreenGrace(4000);
    grace.due("room:a:first", 0);
    grace.keepOnly(Set.of());
    assertThat(grace.due("room:a:first", 4000)).isFalse();
    assertThat(grace.due("room:a:first", 8000)).isTrue();
  }

  @Test
  void aZeroWindowOpensAtOnce() {
    assertThat(new ScreenGrace(0).due("k", 10)).isTrue();
  }
}
