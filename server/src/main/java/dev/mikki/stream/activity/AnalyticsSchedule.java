package dev.mikki.stream.activity;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Буфер аналитики — в базу раз в 10 с ({@link Analytics#flush}): присутствие на связи в отчёте
 * отстаёт от жизни не больше чем на это, а встреча и вход не пишут в базу ничего лишнего.
 */
@Component
@ConditionalOnProperty(
    name = "stream.scheduling-enabled",
    havingValue = "true",
    matchIfMissing = true)
public class AnalyticsSchedule {
  private final Analytics analytics;

  public AnalyticsSchedule(Analytics analytics) {
    this.analytics = analytics;
  }

  @Scheduled(initialDelay = 10_000, fixedDelay = 10_000)
  public void flush() {
    analytics.flush();
  }
}
