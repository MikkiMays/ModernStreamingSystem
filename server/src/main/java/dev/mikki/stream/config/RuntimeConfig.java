package dev.mikki.stream.config;

import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

@Configuration
public class RuntimeConfig {
  @Bean
  Clock clock() {
    return Clock.systemUTC();
  }

  /**
   * Потоков планировщика — не меньше, чем задач по расписанию ({@code @Scheduled}): у каждой свой.
   *
   * <p>Раньше потоков было четыре на полтора десятка задач, и долгий проход — сроки по всем
   * комнатам, сверка с медиаузлом, уборка вложений — задерживал остальные, в том числе часы игр,
   * которые идут пять раз в секунду: конец хода за столом читался как «подвисло» ({@code
   * docs/architecture/core-scale.md} §3.1). Задача сама с собой не пересекается, поэтому при потоке
   * на задачу ни одна не ждёт другую. Новая задача — число растёт вместе с ней: за этим следит
   * {@code SchedulerTest}.
   */
  public static final int SCHEDULER_THREADS = 20;

  @Bean
  public ThreadPoolTaskScheduler taskScheduler() {
    var scheduler = new ThreadPoolTaskScheduler();
    scheduler.setPoolSize(SCHEDULER_THREADS);
    scheduler.setThreadNamePrefix("maintenance-");
    scheduler.setRemoveOnCancelPolicy(true);
    return scheduler;
  }
}
