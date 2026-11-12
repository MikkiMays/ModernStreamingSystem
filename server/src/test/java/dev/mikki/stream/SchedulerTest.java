package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;

import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import dev.mikki.stream.config.RuntimeConfig;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.scheduling.annotation.Scheduled;

/**
 * Планировщик ядра ({@code docs/architecture/core-scale.md} §3.1): долгие проходы не задерживают
 * часы игр, которые идут пять раз в секунду.
 */
class SchedulerTest {
  /** Задач по расписанию не больше, чем потоков: у каждой свой, и ни одна не ждёт другую. */
  @Test
  void everyScheduledTaskHasAThreadOfItsOwn() {
    long tasks =
        new ClassFileImporter()
                .withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
                .importPackages("dev.mikki.stream")
                .stream()
                .flatMap(type -> type.getMethods().stream())
                .filter(method -> method.isAnnotatedWith(Scheduled.class))
                .count();
    assertThat(tasks).isPositive().isLessThanOrEqualTo(RuntimeConfig.SCHEDULER_THREADS);
  }

  /**
   * Четыре прохода встали надолго — столько потоков было у планировщика раньше, — а часы с шагом 50
   * мс идут как шли.
   */
  @Test
  void longPassesDoNotHoldTheGameClock() throws Exception {
    var scheduler = new RuntimeConfig().taskScheduler();
    scheduler.initialize();
    var release = new CountDownLatch(1);
    var stuck = new CountDownLatch(4);
    var ticks = new AtomicInteger();
    try {
      for (int pass = 0; pass < 4; pass++)
        scheduler.scheduleWithFixedDelay(
            () -> {
              stuck.countDown();
              try {
                release.await();
              } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
              }
            },
            Duration.ofSeconds(1));
      assertThat(stuck.await(5, TimeUnit.SECONDS)).isTrue();
      scheduler.scheduleWithFixedDelay(ticks::incrementAndGet, Duration.ofMillis(50));
      long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
      while (ticks.get() < 5 && System.nanoTime() < until) Thread.sleep(20);
      assertThat(ticks.get()).isGreaterThanOrEqualTo(5);
    } finally {
      release.countDown();
      scheduler.shutdown();
    }
  }
}
