package dev.mikki.stream.support;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Раз в час забывает обращения старше {@code stream.support.retention}: в них может быть контакт
 * человека, и держать его дольше нужного незачем (П8).
 */
@Component
@ConditionalOnProperty(
    name = "stream.scheduling-enabled",
    havingValue = "true",
    matchIfMissing = true)
public class SupportJanitor {
  private final SupportService support;

  public SupportJanitor(SupportService support) {
    this.support = support;
  }

  @Scheduled(initialDelay = 60_000, fixedDelay = 3_600_000)
  public void tidy() {
    support.forgetOld();
  }
}
