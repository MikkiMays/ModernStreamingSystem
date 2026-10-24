package dev.mikki.stream.access;

import dev.mikki.stream.config.Allowance;
import dev.mikki.stream.config.Rate;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Problem;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

/**
 * Пределы частоты — один механизм на всё ядро (решение 1 целевой архитектуры, WP1-9).
 *
 * <p>ОКНО — ЛЮБОЙ ДЛИНЫ. Раньше счётчик жил ровно шестьдесят секунд, и «десять встреч в час» или
 * «двадцать промахов кода в час» выразить было нечем. Теперь окно приходит вместе с пределом
 * ({@link Rate}), и в ключ Redis входит его длина: один и тот же ключ с минутным и часовым окном —
 * два разных счётчика. Окно фиксированное (от первого шага), а не скользящее: этого хватает, чтобы
 * массовость стала дорогой, и стоит одного {@code INCR}.
 *
 * <p>Без Redis (локальный профиль, тесты) счётчики живут в памяти процесса.
 *
 * <p>СБОЙ СЧЁТЧИКА НЕ ЗАКРЫВАЕТ ВХОД (R106, решение Р-28). Раньше любая ошибка Redis — в том числе
 * таймаут команды на занятой машине — становилась отказом 503 {@code RATE_SERVICE_UNAVAILABLE}, и
 * человек не мог создать встречу или войти в неё, а в журнале не оставалось ничего. Теперь на время
 * сбоя счёт идёт в памяти ядра с теми же пределами: злоупотребление по-прежнему упирается в 429, а
 * вход — нет. Redis после сбоя отдыхает {@link #REDIS_PAUSE}: иначе каждый запрос ждал бы таймаут.
 * Причина — в журнал не чаще раза в {@link #LOG_EVERY} (тип ошибки, без ключей: в них адреса и
 * профили), число шагов в памяти — метрика {@code cord_rate_limiter_fallback_total{reason}}.
 */
@Component
public class RateLimits {
  /** Сколько Redis не спрашивают после сбоя: таймаут стоит каждому запросу полсекунды. */
  public static final Duration REDIS_PAUSE = Duration.ofSeconds(5);

  /** Не чаще одной строки в журнале на столько: сбой длится, а запросы идут сотнями. */
  public static final Duration LOG_EVERY = Duration.ofSeconds(10);

  private static final Logger log = LoggerFactory.getLogger(RateLimits.class);
  private final StringRedisTemplate redis;
  private final boolean redisEnabled;
  private final MeterRegistry registry;
  private final LongSupplier clock;
  private final Map<String, long[]> local = new ConcurrentHashMap<>();
  private volatile long redisPausedUntil = Long.MIN_VALUE;
  private final AtomicLong loggedAt = new AtomicLong(Long.MIN_VALUE);
  private static final DefaultRedisScript<Long> STEP =
      new DefaultRedisScript<>(
          "local n=redis.call('INCRBY',KEYS[1],ARGV[2]); if n==tonumber(ARGV[2]) then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return n",
          Long.class);

  @Autowired
  public RateLimits(
      StringRedisTemplate redis, StreamProperties config, ObjectProvider<MeterRegistry> registry) {
    this(redis, config.redisEnabled(), registry.getIfAvailable(), System::currentTimeMillis);
  }

  /** С Redis, своими метрами и часами — для тестов сбоя Redis. */
  public RateLimits(StringRedisTemplate redis, MeterRegistry registry, LongSupplier clock) {
    this(redis, true, registry, clock);
  }

  private RateLimits(
      StringRedisTemplate redis, boolean redisEnabled, MeterRegistry registry, LongSupplier clock) {
    this.redis = redis;
    this.redisEnabled = redisEnabled;
    this.registry = registry;
    this.clock = clock;
  }

  /** Счётчики в памяти — для тестов, которым не нужен контекст Spring. */
  public static RateLimits inMemory() {
    return new RateLimits(null, false, null, System::currentTimeMillis);
  }

  /** Прежняя форма: столько в минуту, отказ общими словами. */
  public void check(String key, int limit) {
    check(key, Rate.perMinute(limit));
  }

  /** Шаг счётчика и отказ {@code 429 RATE_LIMITED}, если шаг вышел за предел. */
  public void check(String key, Rate rate) {
    if (exceeded(key, rate))
      throw new Problem(429, "RATE_LIMITED", "Слишком много запросов. Подождите минуту");
  }

  /**
   * Шаг счётчика: вышел ли он за предел. Для отказов со своим кодом ({@code CHAT_RATE}) — код
   * пишется у вызова словами, чтобы реестр ошибок ({@code contracts/errors.json}) его видел.
   */
  public boolean exceeded(String key, Rate rate) {
    return !rate.unlimited() && hit(key, rate) > rate.count();
  }

  /** Шаг счётчика: сколько стало в текущем окне. */
  public long hit(String key, Rate rate) {
    return step(key, rate.period(), 1);
  }

  /** Сколько уже набрано в текущем окне — без шага. */
  public long count(String key, Rate rate) {
    return step(key, rate.period(), 0);
  }

  /** Превышен ли предел уже сейчас — без шага. Нужен там, где считаются только промахи. */
  public boolean exhausted(String key, Rate rate) {
    return !rate.unlimited() && count(key, rate) >= rate.count();
  }

  /**
   * Войдёт ли ещё {@code amount} в квоту объёма ({@link Allowance}) — без шага. Квота загрузок на
   * адрес (A10): сверка до резерва, засчитывание — после удачи ({@link #add}).
   */
  public boolean fits(String key, Allowance quota, long amount) {
    return quota.unlimited() || used(key, quota) + amount <= quota.bytes();
  }

  /** Засчитать объём в квоту. */
  public void add(String key, Allowance quota, long amount) {
    if (!quota.unlimited() && amount > 0) step(key, quota.period(), amount);
  }

  /** Сколько уже засчитано в текущем окне квоты. */
  public long used(String key, Allowance quota) {
    return step(key, quota.period(), 0);
  }

  /** Обнулить счётчик до конца окна — рычаг владельца сервера («снять щит», «снять блок»). */
  public void reset(String key, Rate rate) {
    long period = rate.period().toMillis();
    local.remove(period + ":" + key);
    if (!redisEnabled) return;
    try {
      redis.delete("rate:" + period + ":" + Secrets.hash(key));
    } catch (RuntimeException e) {
      // Счётчик в памяти снят, но в Redis он останется и вернётся вместе с Redis: владелец должен
      // знать, что рычаг сработал не до конца. Человека у входа это не касается — только рычаг.
      failed(e);
      throw new Problem(503, "RATE_SERVICE_UNAVAILABLE", "Сервис входа временно недоступен");
    }
  }

  private long step(String key, Duration window, long by) {
    long period = window.toMillis();
    if (redisEnabled) {
      if (clock.getAsLong() < redisPausedUntil) fallback("paused");
      else {
        var name = "rate:" + period + ":" + Secrets.hash(key);
        try {
          if (by == 0) {
            var value = redis.opsForValue().get(name);
            return value == null ? 0 : Long.parseLong(value);
          }
          return Objects.requireNonNull(
              redis.execute(STEP, List.of(name), Long.toString(period), Long.toString(by)));
        } catch (RuntimeException e) {
          fallback(failed(e));
        }
      }
    }
    long now = clock.getAsLong();
    if (local.size() > 10000) local.entrySet().removeIf(e -> e.getValue()[0] < now);
    var value =
        local.compute(
            period + ":" + key,
            (k, v) ->
                v == null || v[0] < now
                    ? new long[] {now + period, by}
                    : new long[] {v[0], v[1] + by});
    return value[1];
  }

  /** Redis не ответил: пауза, строка в журнал (не чаще раза в 10 с) и вид причины для метрики. */
  private String failed(RuntimeException e) {
    long now = clock.getAsLong();
    redisPausedUntil = now + REDIS_PAUSE.toMillis();
    var reason = reasonOf(e);
    long last = loggedAt.get();
    if ((last == Long.MIN_VALUE || now - last >= LOG_EVERY.toMillis())
        && loggedAt.compareAndSet(last, now)) {
      var root = e;
      Throwable cause = e;
      while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
      // Только типы ошибок: сообщения Lettuce несут адреса, а ключи — адреса и профили людей.
      log.warn(
          "Пределы частоты: Redis не ответил ({}{}), счёт в памяти ядра {} с, вход не закрыт",
          root.getClass().getSimpleName(),
          cause == root ? "" : " ← " + cause.getClass().getSimpleName(),
          REDIS_PAUSE.toSeconds());
    }
    return reason;
  }

  private static String reasonOf(RuntimeException e) {
    for (Throwable t = e; t != null; t = t.getCause() == t ? null : t.getCause()) {
      if (t instanceof QueryTimeoutException || t.getClass().getSimpleName().contains("Timeout"))
        return "timeout";
      if (t instanceof RedisConnectionFailureException
          || t.getClass().getSimpleName().contains("Connection")) return "connection";
    }
    return "other";
  }

  private void fallback(String reason) {
    if (registry == null) return;
    Counter.builder("cord.rate_limiter.fallback")
        .description("Шаги пределов частоты, сосчитанные в памяти ядра из-за сбоя Redis")
        .tag("reason", reason)
        .register(registry)
        .increment();
  }

  /** Drawing cannot consume the quota needed to chat, leave or operate the meeting. */
  public void command(String credential, String type) {
    boolean drawing = "gartic.draw".equals(type);
    check(
        (drawing ? "drawing:" : "command:") + Secrets.hash(credential.replaceFirst("^Bearer ", "")),
        drawing ? 300 : 120);
  }
}
