package dev.mikki.stream.events;

import java.nio.charset.StandardCharsets;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.stereotype.Component;

/**
 * События встречи с других узлов (канал Redis {@code room-events}) — подписка в фоне, с повторами.
 *
 * <p>Раньше подписка была бином-контейнером, который запускался вместе с ядром, и Redis, не
 * ответивший за срок команды (500 мс, {@code spring.data.redis.timeout}), валил запуск целиком: на
 * стенде под нагрузкой ядро дважды подряд не поднялось, и три минуты встречи не подключались
 * (01.11.2026). Свои события узел доставляет своим сокетам сам ({@code RoomEventsPublished}), так
 * что пока подписки нет, теряется только эхо с других узлов — а на одном узле не теряется ничего.
 * Поэтому ядро запускается без Redis, а подписка догоняет: 1 с, 2 с, … до 30 с между попытками.
 * Каждая попытка — новый контейнер: состояние упавшего не переиспользуется.
 */
@Component
@ConditionalOnProperty(name = "stream.redis-enabled", havingValue = "true")
public class RedisEvents implements DisposableBean {
  private static final Logger log = LoggerFactory.getLogger(RedisEvents.class);
  static final String CHANNEL = "room-events";
  private static final long FIRST_DELAY_MS = 1_000;
  private static final long MAX_DELAY_MS = 30_000;

  private final RedisConnectionFactory factory;
  private final RoomSocket socket;
  private volatile RedisMessageListenerContainer container;
  private volatile boolean closed;

  public RedisEvents(RedisConnectionFactory factory, RoomSocket socket) {
    this.factory = factory;
    this.socket = socket;
  }

  @EventListener(ApplicationReadyEvent.class)
  public void subscribe() {
    Thread.ofVirtual().name("redis-events").start(this::connect);
  }

  /** Подписан ли узел сейчас: для проверок и тестов. */
  public boolean subscribed() {
    var current = container;
    return current != null && current.isRunning();
  }

  void connect() {
    for (long delay = FIRST_DELAY_MS; !closed; delay = Math.min(delay * 2, MAX_DELAY_MS)) {
      var next = new RedisMessageListenerContainer();
      next.setConnectionFactory(factory);
      next.addMessageListener(
          (message, pattern) ->
              socket.remote(new String(message.getBody(), StandardCharsets.UTF_8)),
          new ChannelTopic(CHANNEL));
      try {
        next.afterPropertiesSet();
        next.start();
        container = next;
        if (closed) close(next);
        else if (delay > FIRST_DELAY_MS) log.info("Redis room events subscribed");
        return;
      } catch (Exception error) {
        close(next);
        log.warn(
            "Redis room events are not subscribed yet, next attempt in {} ms: {}",
            delay,
            error.getMessage());
      }
      try {
        Thread.sleep(delay);
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        return;
      }
    }
  }

  @Override
  public void destroy() {
    closed = true;
    var current = container;
    if (current != null) close(current);
  }

  private static void close(RedisMessageListenerContainer container) {
    try {
      container.destroy();
    } catch (Exception ignored) {
      // Узел и так закрывается или попытка не удалась: держать нечего.
    }
  }
}
