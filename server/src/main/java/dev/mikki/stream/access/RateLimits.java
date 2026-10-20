package dev.mikki.stream.access;

import dev.mikki.stream.config.Rate;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Problem;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Autowired;
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
 */
@Component
public class RateLimits {
  private final StringRedisTemplate redis;
  private final boolean redisEnabled;
  private final Map<String, long[]> local = new ConcurrentHashMap<>();
  private static final DefaultRedisScript<Long> STEP =
      new DefaultRedisScript<>(
          "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return n",
          Long.class);

  @Autowired
  public RateLimits(StringRedisTemplate redis, StreamProperties config) {
    this(redis, config.redisEnabled());
  }

  private RateLimits(StringRedisTemplate redis, boolean redisEnabled) {
    this.redis = redis;
    this.redisEnabled = redisEnabled;
  }

  /** Счётчики в памяти — для тестов, которым не нужен контекст Spring. */
  public static RateLimits inMemory() {
    return new RateLimits(null, false);
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
    return step(key, rate, 1);
  }

  /** Сколько уже набрано в текущем окне — без шага. */
  public long count(String key, Rate rate) {
    return step(key, rate, 0);
  }

  /** Превышен ли предел уже сейчас — без шага. Нужен там, где считаются только промахи. */
  public boolean exhausted(String key, Rate rate) {
    return !rate.unlimited() && count(key, rate) >= rate.count();
  }

  /** Обнулить счётчик до конца окна — рычаг владельца сервера («снять щит», «снять блок»). */
  public void reset(String key, Rate rate) {
    long period = rate.period().toMillis();
    if (redisEnabled) {
      try {
        redis.delete("rate:" + period + ":" + Secrets.hash(key));
      } catch (Exception e) {
        throw new Problem(503, "RATE_SERVICE_UNAVAILABLE", "Сервис входа временно недоступен");
      }
    } else local.remove(period + ":" + key);
  }

  private long step(String key, Rate rate, int by) {
    long period = rate.period().toMillis();
    if (redisEnabled) {
      var name = "rate:" + period + ":" + Secrets.hash(key);
      try {
        if (by == 0) {
          var value = redis.opsForValue().get(name);
          return value == null ? 0 : Long.parseLong(value);
        }
        return Objects.requireNonNull(redis.execute(STEP, List.of(name), Long.toString(period)));
      } catch (Exception e) {
        throw new Problem(503, "RATE_SERVICE_UNAVAILABLE", "Сервис входа временно недоступен");
      }
    }
    long now = System.currentTimeMillis();
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

  /** Drawing cannot consume the quota needed to chat, leave or operate the meeting. */
  public void command(String credential, String type) {
    boolean drawing = "gartic.draw".equals(type);
    check(
        (drawing ? "drawing:" : "command:") + Secrets.hash(credential.replaceFirst("^Bearer ", "")),
        drawing ? 300 : 120);
  }
}
