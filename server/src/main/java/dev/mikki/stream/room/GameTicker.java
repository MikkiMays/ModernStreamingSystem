package dev.mikki.stream.room;

import java.time.Clock;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Пять раз в секунду спрашивает {@link GameClock}, не пора ли двинуть чей-нибудь стол.
 *
 * <p>Отдельный класс, а не метод в {@link Lifecycle}, по одной причине: вызов собственного метода с
 * {@code @Transactional} идёт мимо прокси Spring, то есть без транзакции. Такую ошибку не видно ни
 * в тестах, ни в логах — она проявляется расхождением данных под нагрузкой.
 */
@Component
@ConditionalOnProperty(
    name = "stream.scheduling-enabled",
    havingValue = "true",
    matchIfMissing = true)
public class GameTicker {
  private final GameClock clock;
  private final Lifecycle lifecycle;
  private final Clock time;

  public GameTicker(GameClock clock, Lifecycle lifecycle, Clock time) {
    this.clock = clock;
    this.lifecycle = lifecycle;
    this.time = time;
  }

  @Scheduled(fixedDelay = 200)
  public void tick() {
    for (var roomId : clock.ripe(time.millis())) lifecycle.advanceGame(roomId);
  }
}
