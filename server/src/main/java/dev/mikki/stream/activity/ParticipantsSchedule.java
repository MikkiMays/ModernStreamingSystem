package dev.mikki.stream.activity;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Буфер журнала участников — в базу раз в 10 с ({@link Participants#flush}, Р-134): вход и выход
 * человека не пишут в базу ничего сами и не ждут её.
 */
@Component
@ConditionalOnProperty(
    name = "stream.scheduling-enabled",
    havingValue = "true",
    matchIfMissing = true)
public class ParticipantsSchedule {
  private final Participants participants;

  public ParticipantsSchedule(Participants participants) {
    this.participants = participants;
  }

  @Scheduled(initialDelay = 10_000, fixedDelay = 10_000)
  public void flush() {
    participants.flush();
  }
}
