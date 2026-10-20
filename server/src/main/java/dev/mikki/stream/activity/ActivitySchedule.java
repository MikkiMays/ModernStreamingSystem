package dev.mikki.stream.activity;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Итоги дня и сроки хранения статистики, журнала и блоков — раз в пять минут.
 *
 * <p>Не в секундном проходе {@code Lifecycle}: там каждая лишняя строка умножается на число комнат,
 * а журналу и статистике срок в минуты не важен.
 *
 * <p>ИТОГИ ДНЯ ({@code activity_daily}) пересчитываются целиком за сегодня и вчера (UTC): вчерашние
 * встречи могли закончиться после полуночи. Старше — не меняются и живут своим сроком ({@code
 * activity-daily: never} — всегда), когда строки встреч ({@code meeting-stats}) уже ушли.
 */
@Component
@ConditionalOnProperty(
    name = "stream.scheduling-enabled",
    havingValue = "true",
    matchIfMissing = true)
public class ActivitySchedule {
  private final ActivityRollup rollup;

  public ActivitySchedule(ActivityRollup rollup) {
    this.rollup = rollup;
  }

  @Scheduled(initialDelay = 60_000, fixedDelay = 300_000)
  public void run() {
    rollup.run();
  }
}
