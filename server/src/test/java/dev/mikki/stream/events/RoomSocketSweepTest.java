package dev.mikki.stream.events;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import dev.mikki.stream.attachment.TusGateway;
import dev.mikki.stream.media.MediaGateway;
import dev.mikki.stream.room.*;
import dev.mikki.stream.room.Contracts.*;
import dev.mikki.stream.shared.Json;
import java.net.InetSocketAddress;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

/**
 * Редкий проход сокетов ({@code RoomSocket.sweep}, {@code docs/architecture/core-scale.md} §3.1):
 * один запрос последних номеров событий на все комнаты с сокетами вместо чтения базы на каждый
 * сокет. Сокет, который не отстал, базы не касается; событие, о котором память процесса не знает,
 * находится и доносится.
 *
 * <p>Контекст тот же, что у {@link RoomSocketDeliveryTest}, — Spring поднимает его один раз.
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
class RoomSocketSweepTest {
  @Autowired RoomService rooms;
  @Autowired RoomSocket socket;
  @Autowired JdbcClient jdbc;
  @MockitoBean MediaGateway gateway;
  @MockitoBean TusGateway tus;
  @MockitoBean Clock clock;
  final AtomicLong now = new AtomicLong(System.currentTimeMillis());
  static final AtomicInteger sessions = new AtomicInteger();
  final List<WebSocketSession> opened = new ArrayList<>();

  @BeforeEach
  void setUp() {
    jdbc.sql("DELETE FROM command_receipts").update();
    jdbc.sql("DELETE FROM rooms").update();
    when(clock.millis()).thenAnswer(_ -> now.get());
  }

  @AfterEach
  void closeSockets() {
    for (var session : opened) socket.afterConnectionClosed(session, CloseStatus.NORMAL);
  }

  WebSocketSession open(Admission who) throws Exception {
    var session = mock(WebSocketSession.class);
    when(session.getId()).thenReturn("s" + sessions.incrementAndGet());
    when(session.isOpen()).thenReturn(true);
    when(session.getHandshakeHeaders()).thenReturn(new HttpHeaders());
    when(session.getRemoteAddress()).thenReturn(new InetSocketAddress("198.51.100.10", 4000));
    opened.add(session);
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
    return session;
  }

  /** Всё зафиксированное разослано: рассылок нет ни в очереди, ни в работе. */
  void settled() {
    long until = System.currentTimeMillis() + 10_000;
    while (!socket.quiet()) {
      if (System.currentTimeMillis() > until) throw new AssertionError("Рассылка не кончилась");
      Thread.onSpinWait();
    }
  }

  /**
   * Сокет, который не отстал, редкий проход не трогает. Доказательство то же, что у секундного
   * прохода: комната удалена из базы прямо из-под сокета — проход, читающий её для каждого сокета,
   * закрыл бы его.
   */
  @Test
  void theSafetySweepLeavesSocketsThatAreUpToDateAlone() throws Exception {
    var host = rooms.create(new Create(UUID.randomUUID(), "Встреча", "Ведущий", false));
    var session = open(host);
    settled();
    jdbc.sql("DELETE FROM rooms WHERE id=?").param(host.roomId()).update();
    for (int i = 0; i < 3; i++) socket.sweep();
    verify(session, never()).close();
    verify(session, never()).close(any(CloseStatus.class));
  }

  /**
   * Событие, о котором память этого процесса не знает (его записал другой экземпляр ядра, а
   * сообщение Redis потерялось), редкий проход находит по журналу в базе и доносит.
   */
  @Test
  void theSafetySweepDeliversAnEventThisProcessNeverHeardOf() throws Exception {
    var host = rooms.create(new Create(UUID.randomUUID(), "Встреча", "Ведущий", false));
    var session = open(host);
    settled();
    var room = rooms.read(host.roomId());
    room.sequence++;
    var foreign =
        new Event(
            1,
            UUID.randomUUID().toString(),
            room.sequence,
            "room.changed",
            EventPayload.changed(),
            now.get());
    jdbc.sql("UPDATE rooms SET state=? WHERE id=?").params(Json.write(room), room.id).update();
    jdbc.sql("INSERT INTO room_events(room_id,sequence,body,expires_at) VALUES(?,?,?,?)")
        .params(room.id, foreign.sequence(), Json.write(foreign), now.get() + 3_600_000L)
        .update();
    assertThat(rooms.latest(room.id)).isLessThan(foreign.sequence());
    verify(session, never())
        .sendMessage(argThat(m -> m.getPayload().toString().contains(foreign.eventId())));
    socket.sweep();
    verify(session)
        .sendMessage(argThat(m -> m.getPayload().toString().contains(foreign.eventId())));
  }
}
