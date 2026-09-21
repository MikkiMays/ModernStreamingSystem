package dev.mikki.stream.events;

import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.application.CommandDispatcher;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.room.*;
import dev.mikki.stream.shared.*;
import jakarta.validation.Validator;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Component
public class RoomSocket extends TextWebSocketHandler {
  private static final class Connection {
    final WebSocketSession socket;
    final long openedAt = System.currentTimeMillis();
    String roomId, credential, participantId;
    long sequence = -1;

    Connection(WebSocketSession session) {
      socket = new ConcurrentWebSocketSessionDecorator(session, 5000, 262144);
    }
  }

  private final Map<String, Connection> sockets = new ConcurrentHashMap<>();
  private final RoomService rooms;
  private final RateLimits limits;
  private final Validator validator;
  private final StringRedisTemplate redis;
  private final StreamProperties config;
  private final CommandDispatcher commands;

  public RoomSocket(
      RoomService rooms,
      RateLimits limits,
      Validator validator,
      StringRedisTemplate redis,
      StreamProperties config,
      CommandDispatcher commands) {
    this.rooms = rooms;
    this.limits = limits;
    this.validator = validator;
    this.redis = redis;
    this.config = config;
    this.commands = commands;
  }

  @Override
  public void afterConnectionEstablished(WebSocketSession socket) {
    socket.setTextMessageSizeLimit(8192);
    sockets.put(socket.getId(), new Connection(socket));
  }

  @Override
  protected void handleTextMessage(WebSocketSession socket, TextMessage message) throws Exception {
    var c = sockets.get(socket.getId());
    if (c == null) return;
    synchronized (c) {
      try {
        var body = Json.tree(message.getPayload());
        var type = body.path("type").asText();
        if (c.credential == null) {
          if (!type.equals("auth")) throw Problem.forbidden();
          String id = UUID.fromString(body.path("roomId").asText()).toString();
          String credential = body.path("credential").asText();
          var room = rooms.read(id);
          var member = rooms.authenticate(room, credential);
          c.roomId = id;
          c.credential = credential;
          c.participantId = member.id;
          c.sequence = body.path("after").asLong(-1);
          limits.check("ws:" + member.id, 60);
          send(
              c,
              Map.of(
                  "type", "authenticated", "participantId", member.id, "liveAfter", room.sequence));
          flush(c);
        } else if (type.equals("ping")) {
          limits.check("ws-ping:" + c.participantId, 60);
          var requestId = body.path("requestId").asText("");
          if (requestId.length() > 64) throw new Problem(400, "INVALID_PING", "Некорректный PING");
          send(c, Map.of("type", "pong", "serverTime", rooms.now(), "requestId", requestId));
        } else if (type.equals("command")) {
          limits.check("command:" + Secrets.hash(c.credential.replaceFirst("^Bearer ", "")), 120);
          var command = Json.read(body.path("command").toString(), Contracts.Command.class);
          if (!validator.validate(command).isEmpty())
            throw new Problem(400, "INVALID_COMMAND", "Некорректная команда");
          var ack = commands.execute(c.roomId, c.credential, command);
          send(c, Map.of("type", "ack", "ack", ack));
          if (config.redisEnabled()) redis.convertAndSend("room-events", c.roomId);
          flush(c);
        } else throw new Problem(400, "UNKNOWN_COMMAND", "Неизвестная команда");
      } catch (Problem e) {
        send(c, Map.of("type", "error", "code", e.code(), "message", e.getMessage()));
        if (e.status() == 403 || e.status() == 410) c.socket.close(CloseStatus.POLICY_VIOLATION);
      } catch (IllegalArgumentException e) {
        c.socket.close(CloseStatus.BAD_DATA);
      }
    }
  }

  /**
   * Комната изменилась сама, без команды: вышел срок хода за столом, истекло восстановление.
   *
   * <p>Раньше такое доезжало до людей секундным проходом {@link #catchUp()} — для встречи это
   * незаметно, для карточного стола это «подвисло». Слушаем <b>после фиксации</b> транзакции:
   * снимок, разосланный до записи, был бы предыдущим.
   */
  @org.springframework.transaction.event.TransactionalEventListener(fallbackExecution = true)
  public void roomChanged(dev.mikki.stream.room.RoomChanged event) {
    if (config.redisEnabled()) redis.convertAndSend("room-events", event.roomId());
    else flushRoom(event.roomId());
  }

  public void flushRoom(String id) {
    for (var c : sockets.values())
      if (id.equals(c.roomId))
        synchronized (c) {
          try {
            flush(c);
          } catch (Exception e) {
            close(c);
          }
        }
  }

  private void flush(Connection c) throws Exception {
    var replay = rooms.replay(c.roomId, c.credential, c.sequence);
    if (replay.reset()) {
      send(c, Map.of("type", "snapshot", "snapshot", replay.snapshot()));
      c.sequence = replay.snapshot().sequence();
    } else
      for (var event : replay.events()) {
        send(c, Map.of("type", "event", "event", event));
        c.sequence = event.sequence();
      }
  }

  private void send(Connection c, Object value) throws Exception {
    if (c.socket.isOpen()) c.socket.sendMessage(new TextMessage(Json.write(value)));
  }

  private void close(Connection c) {
    try {
      c.socket.close();
    } catch (Exception ignored) {
    }
  }

  @Scheduled(fixedDelay = 1000)
  public void catchUp() {
    for (var c : sockets.values())
      synchronized (c) {
        try {
          if (c.credential != null) flush(c);
          else if (System.currentTimeMillis() - c.openedAt > 5000) close(c);
        } catch (Exception e) {
          close(c);
        }
      }
  }

  @Scheduled(fixedDelay = 10000)
  public void presence() {
    if (config.redisEnabled())
      for (var c : sockets.values())
        if (c.participantId != null) {
          try {
            redis
                .opsForValue()
                .set("control:" + c.participantId, c.socket.getId(), Duration.ofSeconds(30));
          } catch (Exception ignored) {
          }
        }
  }

  @Override
  public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
    sockets.remove(socket.getId());
  }
}
