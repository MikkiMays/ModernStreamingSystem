package dev.mikki.stream.media;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/**
 * Сколько запасной путь открытия показа ждёт отправителя.
 *
 * <p>ЗАЧЕМ. Показ виден зрителям после кадра целевого качества (T48), и фиксирует этот кадр
 * отправитель — командой {@code screen.started}. {@link MediaReconciler} же открывал показ сам, как
 * только видел дорожку экрана у SFU: это запасной путь для клиентов старее самой команды, но он
 * срабатывал через две секунды — раньше любого отправителя, и выдержка пропадала. Теперь запасной
 * путь ждёт окно разгона ({@code stream.media.quality.settle}) с момента, когда дорожку впервые
 * увидели; тот, кто шлёт команду сам, успевает первым.
 *
 * <p>Память — в самом реконсайлере, а не в {@code RoomState}: это не состояние встречи, а отсчёт
 * одного наблюдателя, и после перезапуска ядра он честно начинается заново.
 */
public final class ScreenGrace {
  private final Map<String, Long> firstSeen = new HashMap<>();
  private final long windowMs;

  public ScreenGrace(long windowMs) {
    this.windowMs = windowMs;
  }

  /**
   * Пора ли открывать показ по этой дорожке.
   *
   * @param key комната, участник и сессия SFU: новая сессия — новая дорожка и новое окно
   * @param now часы ядра, миллисекунды
   */
  public boolean due(String key, long now) {
    var since = firstSeen.putIfAbsent(key, now);
    return now - (since == null ? now : since) >= windowMs;
  }

  /** Забыть всё, чего в этом проходе у SFU не видели: исчезнувшая дорожка окна не наследует. */
  public void keepOnly(Set<String> present) {
    firstSeen.keySet().retainAll(present);
  }
}
