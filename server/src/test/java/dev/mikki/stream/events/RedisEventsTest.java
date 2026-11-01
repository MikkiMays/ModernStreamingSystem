package dev.mikki.stream.events;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.connection.RedisConnectionFactory;

/**
 * Redis не ответил при запуске — ядро всё равно поднимается, а подписка догоняет (стенд,
 * 01.11.2026: срок 500 мс дважды подряд валил запуск, встречи три минуты не подключались).
 */
class RedisEventsTest {
  @Test
  void unreachableRedisNeitherThrowsNorStopsRetrying() throws Exception {
    var factory = mock(RedisConnectionFactory.class);
    when(factory.getConnection())
        .thenThrow(new RedisConnectionFailureException("Unable to connect to Redis"));
    var events = new RedisEvents(factory, mock(RoomSocket.class));
    var thread = Thread.ofVirtual().start(events::connect);

    // Первая попытка сразу, вторая — через секунду: узел не сдался после отказа.
    verify(factory, timeout(5_000).atLeast(2)).getConnection();
    assertFalse(events.subscribed());
    assertTrue(thread.isAlive());

    events.destroy();
    assertTrue(thread.join(Duration.ofSeconds(5)), "после destroy попытки кончаются");
    assertFalse(events.subscribed());
  }
}
