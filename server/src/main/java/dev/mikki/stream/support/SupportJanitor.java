package dev.mikki.stream.support;

import dev.mikki.stream.room.RetentionMeter;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Раз в час убирает в архив давно решённое ({@code stream.support.auto-archive}), стирает текст
 * решённого больше суток назад (Р-134 (в): остаются тема, статус, время, контакт и узел) и забывает
 * обращения старше {@code stream.support.retention} (срок метаданных — год).
 */
@Component
@ConditionalOnProperty(
    name = "stream.scheduling-enabled",
    havingValue = "true",
    matchIfMissing = true)
public class SupportJanitor {
  private final SupportService support;
  private final RetentionMeter retention;

  public SupportJanitor(SupportService support, RetentionMeter retention) {
    this.support = support;
    this.retention = retention;
  }

  @Scheduled(initialDelay = 60_000, fixedDelay = 3_600_000)
  public void tidy() {
    support.archiveResolved();
    retention.deleted("support_text", support.forgetResolvedText());
    retention.deleted("support_ticket", support.forgetOld());
  }
}
