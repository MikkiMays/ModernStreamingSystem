package dev.mikki.stream.activity;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Расписание фактов аналитики (R239): буфер — службе раз в две секунды ({@link
 * InsightFacts#flush}); раз в минуту — тик присутствия на каждую встречу с людьми на связи ({@link
 * InsightRooms#tick}) и итог отказов защиты ({@link InsightFacts#refusals}).
 *
 * <p>У каждой задачи свой поток планировщика ({@code RuntimeConfig}): отправка ждёт службу до
 * нескольких секунд и никого при этом не задерживает. Служба не задана — оба прохода выходят первой
 * строкой.
 */
@Component
@ConditionalOnProperty(
    name = "stream.scheduling-enabled",
    havingValue = "true",
    matchIfMissing = true)
public class InsightSchedule {
  private final InsightFacts facts;
  private final InsightRooms rooms;

  public InsightSchedule(InsightFacts facts, InsightRooms rooms) {
    this.facts = facts;
    this.rooms = rooms;
  }

  @Scheduled(initialDelay = InsightFacts.FLUSH_MS, fixedDelay = InsightFacts.FLUSH_MS)
  public void flush() {
    facts.flush();
  }

  @Scheduled(initialDelay = InsightRooms.TICK_MS, fixedDelay = InsightRooms.TICK_MS)
  public void minute() {
    if (!facts.enabled()) return;
    rooms.tick();
    facts.refusals();
  }
}
