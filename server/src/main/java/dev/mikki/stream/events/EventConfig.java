package dev.mikki.stream.events;

import dev.mikki.stream.config.StreamProperties;
import org.springframework.context.annotation.*;
import org.springframework.web.socket.config.annotation.*;

@Configuration
@EnableWebSocket
public class EventConfig implements WebSocketConfigurer {
  private final RoomSocket socket;
  private final BoardSocket board;
  private final StreamProperties config;

  public EventConfig(RoomSocket socket, BoardSocket board, StreamProperties config) {
    this.socket = socket;
    this.board = board;
    this.config = config;
  }

  /**
   * Два сокета: события встречи и доска (R159). Доска — отдельно, чтобы горячий путь штрихов не
   * делил с командами встречи ни замок, ни очередь, ни предел входа.
   */
  @Override
  public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
    registry.addHandler(socket, "/api/v1/events").setAllowedOrigins(config.publicUrl());
    registry.addHandler(board, "/api/v1/board").setAllowedOrigins(config.publicUrl());
  }

  // Подписка на события других узлов — `RedisEvents`: в фоне, запуск ядра Redis не ждёт.
}
