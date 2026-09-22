package dev.mikki.stream.access;

import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Problem;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

@Component
public class RateLimits {
  private final StringRedisTemplate redis;
  private final StreamProperties config;
  private final Map<String, long[]> local = new ConcurrentHashMap<>();
  private static final DefaultRedisScript<Long> SCRIPT =
      new DefaultRedisScript<>(
          "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
          Long.class);

  public RateLimits(StringRedisTemplate redis, StreamProperties config) {
    this.redis = redis;
    this.config = config;
  }

  public void check(String key, int limit) {
    long count;
    if (config.redisEnabled()) {
      try {
        count = Objects.requireNonNull(redis.execute(SCRIPT, List.of("rate:" + Secrets.hash(key))));
      } catch (Exception e) {
        throw new Problem(503, "RATE_SERVICE_UNAVAILABLE", "Сервис входа временно недоступен");
      }
    } else {
      long now = System.currentTimeMillis();
      if (local.size() > 10000) local.entrySet().removeIf(e -> e.getValue()[0] < now);
      var value =
          local.compute(
              key,
              (k, v) ->
                  v == null || v[0] < now
                      ? new long[] {now + 60000, 1}
                      : new long[] {v[0], v[1] + 1});
      count = value[1];
    }
    if (count > limit)
      throw new Problem(429, "RATE_LIMITED", "Слишком много запросов. Подождите минуту");
  }

  /** Drawing cannot consume the quota needed to chat, leave or operate the meeting. */
  public void command(String credential, String type) {
    boolean drawing = "gartic.draw".equals(type);
    check(
        (drawing ? "drawing:" : "command:") + Secrets.hash(credential.replaceFirst("^Bearer ", "")),
        drawing ? 300 : 120);
  }
}
