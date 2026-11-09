package dev.mikki.stream.activity;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Буфер аналитики — в базу раз в 10 с ({@link Analytics#flush}): присутствие на связи в отчёте
 * отстаёт от жизни не больше чем на это, а встреча и вход не пишут в базу ничего лишнего. Тем же
 * проходом — буфер журнала участников ({@link Participants#flush}, Р-134).
 */
@Component
@ConditionalOnProperty(
    name = "stream.scheduling-enabled",
    havingValue = "true",
    matchIfMissing = true)
public class AnalyticsSchedule {
  private final Analytics analytics;
  private final Participants participants;

  public AnalyticsSchedule(Analytics analytics, Participants participants) {
    this.analytics = analytics;
    this.participants = participants;
  }

  @Scheduled(initialDelay = 10_000, fixedDelay = 10_000)
  public void flush() {
    analytics.flush();
    participants.flush();
  }
}
