package dev.mikki.stream.events;

import dev.mikki.stream.config.StreamProperties;
import java.nio.charset.StandardCharsets;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.*;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.*;
import org.springframework.web.socket.config.annotation.*;

@Configuration
@EnableWebSocket
public class EventConfig implements WebSocketConfigurer {
  private final RoomSocket socket;
  private final StreamProperties config;

  public EventConfig(RoomSocket socket, StreamProperties config) {
    this.socket = socket;
    this.config = config;
  }

  @Override
  public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
    registry.addHandler(socket, "/api/v1/events").setAllowedOrigins(config.publicUrl());
  }

  @Bean
  @ConditionalOnProperty(name = "stream.redis-enabled", havingValue = "true")
  RedisMessageListenerContainer redisEvents(RedisConnectionFactory factory) {
    var container = new RedisMessageListenerContainer();
    container.setConnectionFactory(factory);
    container.addMessageListener(
        (message, pattern) ->
            socket.flushRoom(new String(message.getBody(), StandardCharsets.UTF_8)),
        new ChannelTopic("room-events"));
    return container;
  }
}
