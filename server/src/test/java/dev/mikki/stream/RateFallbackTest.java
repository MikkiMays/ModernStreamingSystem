package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.config.Rate;
import dev.mikki.stream.shared.Problem;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.data.redis.core.script.RedisScript;

/**
 * Сбой счётчика не закрывает вход (R106, решение Р-28).
 *
 * <p>Под нагрузкой машины {@code POST /api/v1/rooms} ответил 503 {@code RATE_SERVICE_UNAVAILABLE}:
 * команда Redis не уложилась в таймаут, {@code RateLimits.step} превратил это в отказ, а в журнал
 * не попало ничего. Человек не может войти во встречу из-за того, что счётчик частоты на секунду
 * задумался. Теперь на время сбоя счёт идёт в памяти ядра с теми же пределами (злоупотребление
 * по-прежнему упирается в 429), причина — в журнале не чаще раза в 10 с, сбой виден метрикой.
 */
class RateFallbackTest {
  private final StringRedisTemplate redis = mock(StringRedisTemplate.class);

  @SuppressWarnings("unchecked")
  private final ValueOperations<String, String> values = mock(ValueOperations.class);

  private final SimpleMeterRegistry registry = new SimpleMeterRegistry();
  private final AtomicLong now = new AtomicLong(1_000_000);
  private final ListAppender<ILoggingEvent> journal = new ListAppender<>();
  private final Logger logger = (Logger) LoggerFactory.getLogger(RateLimits.class);
  private RateLimits limits;

  @BeforeEach
  void setUp() {
    when(redis.opsForValue()).thenReturn(values);
    journal.start();
    logger.addAppender(journal);
    limits = new RateLimits(redis, registry, now::get);
  }

  @AfterEach
  void tearDown() {
    logger.detachAppender(journal);
  }

  @SuppressWarnings("unchecked")
  private void redisDown(RuntimeException failure) {
    when(redis.execute(any(RedisScript.class), anyList(), any(), any())).thenThrow(failure);
    when(values.get(anyString())).thenThrow(failure);
  }

  private List<ILoggingEvent> warnings() {
    return journal.list.stream().filter(e -> e.getLevel() == Level.WARN).toList();
  }

  private double fallbacks() {
    return registry.find("cord.rate_limiter.fallback").counters().stream()
        .mapToDouble(Counter::count)
        .sum();
  }

  @Test
  void aRedisTimeoutDoesNotCloseTheDoor() {
    redisDown(new QueryTimeoutException("Redis command timed out"));
    var rate = Rate.parse("3 per hour");

    for (int i = 0; i < 3; i++)
      assertThatCode(() -> limits.check("rooms:ip:203.0.113.7", rate)).doesNotThrowAnyException();
    assertThat(fallbacks()).isGreaterThan(0);
  }

  @Test
  void theSameLimitsHoldInMemoryWhileRedisIsDown() {
    redisDown(new RedisConnectionFailureException("Unable to connect to Redis"));
    var rate = Rate.parse("3 per hour");

    for (int i = 0; i < 3; i++) limits.check("rooms:ip:203.0.113.7", rate);
    assertThatThrownBy(() -> limits.check("rooms:ip:203.0.113.7", rate))
        .isInstanceOfSatisfying(Problem.class, p -> assertThat(p.code()).isEqualTo("RATE_LIMITED"));
    // Без шага видно то же, что видит проверка, — и тоже без Redis.
    assertThat(limits.count("rooms:ip:203.0.113.7", rate)).isEqualTo(4);
    // У другого адреса свой счётчик.
    assertThatCode(() -> limits.check("rooms:ip:198.51.100.1", rate)).doesNotThrowAnyException();
  }

  @Test
  void theReasonIsLoggedOnceInTenSecondsWithoutKeys() {
    redisDown(new QueryTimeoutException("Redis command timed out after 500 millisecond(s)"));
    var rate = Rate.parse("100 per minute");

    for (int i = 0; i < 20; i++) limits.hit("join:profile:secret-person", rate);
    assertThat(warnings()).hasSize(1);
    var line = warnings().getFirst().getFormattedMessage();
    assertThat(line).contains("QueryTimeoutException");
    // Ни ключа, ни того, чей он: в ключах — адреса и профили людей.
    assertThat(line).doesNotContain("secret-person").doesNotContain("join:profile");

    now.addAndGet(10_001);
    limits.hit("join:profile:secret-person", rate);
    assertThat(warnings()).hasSize(2);
  }

  @Test
  @SuppressWarnings("unchecked")
  void redisIsNotAskedOnEveryRequestWhileItIsDownAndIsAskedAgainLater() {
    redisDown(new QueryTimeoutException("Redis command timed out"));
    var rate = Rate.parse("100 per minute");

    for (int i = 0; i < 10; i++) limits.hit("chat:abc", rate);
    // Таймаут стоит полсекунды каждому, кто входит: после сбоя Redis отдыхает, а не опрашивается.
    verify(redis, times(1)).execute(any(RedisScript.class), anyList(), any(), any());

    reset(redis);
    when(redis.opsForValue()).thenReturn(values);
    when(redis.execute(any(RedisScript.class), anyList(), any(), any())).thenReturn(1L);
    now.addAndGet(RateLimits.REDIS_PAUSE.toMillis() + 1);
    assertThat(limits.hit("chat:abc", rate)).isEqualTo(1);
    verify(redis, times(1)).execute(any(RedisScript.class), anyList(), any(), any());
  }

  @Test
  void theOwnersLeverSaysWhenItCouldNotReachRedis() {
    redisDown(new RedisConnectionFailureException("Unable to connect to Redis"));
    when(redis.delete(anyString())).thenThrow(new RedisConnectionFailureException("down"));
    var rate = Rate.parse("3 per hour");
    for (int i = 0; i < 4; i++) limits.hit("rooms:ip:203.0.113.7", rate);

    // Счётчик в памяти снят, но тот, что в Redis, останется — владельцу говорят правду.
    assertThatThrownBy(() -> limits.reset("rooms:ip:203.0.113.7", rate))
        .isInstanceOfSatisfying(
            Problem.class, p -> assertThat(p.code()).isEqualTo("RATE_SERVICE_UNAVAILABLE"));
    assertThat(limits.count("rooms:ip:203.0.113.7", rate)).isZero();
  }
}
