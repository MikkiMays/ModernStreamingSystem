package dev.mikki.stream.events;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import com.fasterxml.jackson.databind.JsonNode;
import dev.mikki.stream.attachment.TusGateway;
import dev.mikki.stream.media.MediaGateway;
import dev.mikki.stream.room.*;
import dev.mikki.stream.room.Contracts.*;
import dev.mikki.stream.shared.Json;
import java.net.InetSocketAddress;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

/**
 * Событие встречи доходит до всех её сокетов сразу после фиксации — откуда бы ни пришла правка.
 * Проходы сокетов ({@code catchUp}, {@code sweep}) здесь выключены: что пришло, пришло рассылкой.
 */
@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:delivery;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.files-root=./.local/test-uploads",
      "stream.abuse.per-ip.sockets=1000",
      "stream.abuse.per-ip.socket-opens=off"
    })
@ActiveProfiles("local")
class RoomSocketDeliveryTest {
  @Autowired RoomService rooms;
  @Autowired RoomSocket socket;
  @Autowired JdbcClient jdbc;
  @MockitoBean MediaGateway gateway;
  @MockitoBean TusGateway tus;
  @MockitoBean Clock clock;
  final AtomicLong now = new AtomicLong(System.currentTimeMillis());
  static final AtomicInteger sessions = new AtomicInteger();

  @BeforeEach
  void setUp() {
    jdbc.sql("DELETE FROM command_receipts").update();
    jdbc.sql("DELETE FROM rooms").update();
    when(clock.millis()).thenAnswer(_ -> now.get());
  }

  /** Сокет участника: что ему пришло. */
  final class Client {
    final WebSocketSession session = mock(WebSocketSession.class);
    final List<JsonNode> received = new CopyOnWriteArrayList<>();

    Client(Admission who) throws Exception {
      var id = "d" + sessions.incrementAndGet();
      when(session.getId()).thenReturn(id);
      when(session.isOpen()).thenReturn(true);
      when(session.getHandshakeHeaders()).thenReturn(new HttpHeaders());
      when(session.getRemoteAddress()).thenReturn(new InetSocketAddress("198.51.100.9", 4000));
      doAnswer(
              call -> {
                received.add(Json.tree(((TextMessage) call.getArgument(0)).getPayload()));
                return null;
              })
          .when(session)
          .sendMessage(any());
      socket.afterConnectionEstablished(session);
      socket.handleMessage(
          session,
          new TextMessage(
              Json.write(
                  Map.of(
                      "type",
                      "auth",
                      "roomId",
                      who.roomId(),
                      "credential",
                      who.credential(),
                      "after",
                      -1))));
    }

    JsonNode awaitEvent(String type) {
      long until = System.currentTimeMillis() + 5000;
      while (System.currentTimeMillis() < until) {
        for (var message : received)
          if (message.path("type").asText().equals("event")
              && message.path("event").path("type").asText().equals(type)) return message;
        Thread.onSpinWait();
      }
      throw new AssertionError("Не пришло событие " + type + ": " + received);
    }
  }

  @Test
  void commandOverHttpReachesTheOtherSocketsWithoutTheirPolling() throws Exception {
    var host = rooms.create(new Create(UUID.randomUUID(), "Встреча", "Ведущий", false));
    var guest =
        rooms.join(
            host.roomId(),
            new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"));
    var anna = new Client(host);
    var boris = new Client(guest);
    // Команда мимо сокетов — как POST /rooms/{id}/commands: раньше другие узнавали о ней проходом.
    rooms.command(
        host.roomId(),
        host.credential(),
        new Command(UUID.randomUUID(), "message.send", "Привет", null, 0));
    assertThat(boris.awaitEvent("message.created").path("event").toString()).contains("Привет");
    assertThat(anna.awaitEvent("message.created")).isNotNull();
  }

  @Test
  void ownRedisEchoIsSkippedAndOthersAndOldFormatAreRead() {
    assertThat(RoomSocket.roomOf("node-a room-1", "node-a")).isNull();
    assertThat(RoomSocket.roomOf("node-b room-1", "node-a")).isEqualTo("room-1");
    assertThat(RoomSocket.roomOf("room-1", "node-a")).isEqualTo("room-1");
  }
}
