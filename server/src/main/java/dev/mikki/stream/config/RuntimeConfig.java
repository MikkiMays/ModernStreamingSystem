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

  @Bean
  ThreadPoolTaskScheduler taskScheduler() {
    var scheduler = new ThreadPoolTaskScheduler();
    scheduler.setPoolSize(4);
    scheduler.setThreadNamePrefix("maintenance-");
    scheduler.setRemoveOnCancelPolicy(true);
    return scheduler;
  }
}
