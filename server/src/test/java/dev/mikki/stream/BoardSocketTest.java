package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.fasterxml.jackson.databind.JsonNode;
import dev.mikki.stream.attachment.TusGateway;
import dev.mikki.stream.board.BoardRooms;
import dev.mikki.stream.board.BoardStore;
import dev.mikki.stream.events.BoardSocket;
import dev.mikki.stream.media.MediaGateway;
import dev.mikki.stream.room.*;
import dev.mikki.stream.room.Contracts.*;
import dev.mikki.stream.shared.Json;
import io.micrometer.core.instrument.MeterRegistry;
import java.net.InetSocketAddress;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

/**
 * Сокет доски (R159) глазами браузеров: вход по пропуску участника, правки одного — у другого,
 * смотрящий не рисует, вернувшийся получает пропущенное, очистка — новым поколением, сцена
 * переживает выгрузку из памяти, а картинки проверяются по содержимому.
 */
@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:boards;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.files-root=./.local/test-uploads",
      "stream.max-rooms=200",
      "stream.abuse.per-ip.sockets=1000",
      "stream.abuse.per-ip.socket-opens=off"
    })
@ActiveProfiles("local")
class BoardSocketTest {
  @Autowired RoomService rooms;
  @Autowired BoardSocket socket;
  @Autowired BoardRooms boards;
  @Autowired BoardStore store;
  @Autowired JdbcClient jdbc;
  @Autowired WebApplicationContext web;
  @Autowired MeterRegistry registry;
  @MockitoBean MediaGateway gateway;
  @MockitoBean TusGateway tus;
  @MockitoBean Clock clock;
  AtomicLong now = new AtomicLong(System.currentTimeMillis());
  static final AtomicInteger sessions = new AtomicInteger();

  @BeforeEach
  void setUp() {
    jdbc.sql("DELETE FROM command_receipts").update();
    jdbc.sql("DELETE FROM rooms").update();
    when(clock.millis()).thenAnswer(_ -> now.get());
  }

  /** Браузер у доски: что ему пришло и чем закрыли его сокет. */
  final class Client {
    final WebSocketSession session = mock(WebSocketSession.class);
    final List<JsonNode> received = new CopyOnWriteArrayList<>();
    final AtomicReference<CloseStatus> closed = new AtomicReference<>();
    final AtomicBoolean open = new AtomicBoolean(true);

    Client() throws Exception {
      var id = "s" + sessions.incrementAndGet();
      when(session.getId()).thenReturn(id);
      when(session.isOpen()).thenAnswer(_ -> open.get());
      when(session.getHandshakeHeaders()).thenReturn(new HttpHeaders());
      when(session.getRemoteAddress()).thenReturn(new InetSocketAddress("198.51.100.7", 4000));
      doAnswer(
              call -> {
                received.add(Json.tree(((TextMessage) call.getArgument(0)).getPayload()));
                return null;
              })
          .when(session)
          .sendMessage(any());
      doAnswer(
              call -> {
                if (open.getAndSet(false)) {
                  closed.set(call.getArgument(0));
                  socket.afterConnectionClosed(session, call.getArgument(0));
                }
                return null;
              })
          .when(session)
          .close(any(CloseStatus.class));
      socket.afterConnectionEstablished(session);
    }

    void send(Object message) throws Exception {
      socket.handleMessage(session, new TextMessage(Json.write(message)));
    }

    void auth(Admission admission, long epoch, long since) throws Exception {
      send(
          Map.of(
              "type",
              "auth",
              "roomId",
              admission.roomId(),
              "credential",
              admission.credential(),
              "epoch",
              epoch,
              "since",
              since));
    }

    JsonNode await(String type) {
      return await(type, _ -> true);
    }

    JsonNode await(String type, Predicate<JsonNode> test) {
      long until = System.currentTimeMillis() + 5000;
      while (System.currentTimeMillis() < until) {
        for (var message : received)
          if (message.path("type").asText().equals(type) && test.test(message)) return message;
        Thread.onSpinWait();
      }
      throw new AssertionError("Не пришло " + type + ": " + received);
    }

    List<JsonNode> all(String type) {
      return received.stream().filter(m -> m.path("type").asText().equals(type)).toList();
    }

    void awaitClosed() {
      long until = System.currentTimeMillis() + 5000;
      while (closed.get() == null && System.currentTimeMillis() < until) Thread.onSpinWait();
      assertThat(closed.get()).as("сокет закрыт").isNotNull();
    }
  }

  Admission host() {
    return rooms.create(new Create(UUID.randomUUID(), "Доска", "Ведущий", false));
  }

  Admission guest(Admission host) {
    return rooms.join(
        host.roomId(), new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"));
  }

  Ack command(Admission who, String type, String option) {
    return rooms.command(
        who.roomId(),
        who.credential(),
        new Command(
            UUID.randomUUID(), type, null, null, 0, null, null, null, null, option, null, null));
  }

  static Map<String, Object> rect(String id, long version, long nonce) {
    var el = new LinkedHashMap<String, Object>();
    el.put("id", id);
    el.put("type", "rectangle");
    el.put("version", version);
    el.put("versionNonce", nonce);
    el.put("isDeleted", false);
    el.put("x", 1);
    el.put("y", 2);
    el.put("width", 30);
    el.put("height", 40);
    el.put("index", "a0");
    return el;
  }

  static Map<String, Object> ops(Object... elements) {
    return Map.of("type", "ops", "els", List.of(elements), "t", 123);
  }

  @Test
  void strokeOfOneReachesTheOtherAndTheAuthorGetsAnAck() throws Exception {
    var host = host();
    var guest = guest(host);
    command(host, "board.open", null);
    var anna = new Client();
    anna.auth(host, -1, -1);
    var hello = anna.await("hello");
    assertThat(hello.path("canDraw").asBoolean()).isTrue();
    assertThat(hello.path("mode").asText()).isEqualTo("scene");
    assertThat(anna.await("scene").path("els")).isEmpty();
    var boris = new Client();
    boris.auth(guest, -1, -1);
    boris.await("scene");
    assertThat(anna.await("joined").path("from").asText()).isEqualTo(guest.participantId());

    var accepted = registry.find("cord.board.elements").tag("result", "accepted").functionCounter();
    double before = accepted.count();
    anna.send(ops(rect("a", 1, 7)));
    var ack = anna.await("ack");
    assertThat(ack.path("n").asInt()).isEqualTo(1);
    // Видно и в «Cord — встречи»: правка учтена, оба сокета — на доске.
    assertThat(accepted.count()).isEqualTo(before + 1);
    assertThat(registry.get("cord.board.peers").gauge().value()).isGreaterThanOrEqualTo(2);
    assertThat(registry.get("cord.board.open").gauge().value()).isGreaterThanOrEqualTo(1);
    var ops = boris.await("ops");
    assertThat(ops.path("seq").asLong()).isEqualTo(ack.path("seq").asLong());
    assertThat(ops.path("from").asText()).isEqualTo(host.participantId());
    assertThat(ops.path("t").asLong()).isEqualTo(123);
    assertThat(ops.path("st").asLong()).isPositive();
    assertThat(ops.path("els").get(0).path("id").asText()).isEqualTo("a");
    // Своя правка автору не возвращается — только ответ.
    assertThat(anna.all("ops")).isEmpty();

    // Курсор и лазер — всем, кроме самого автора; штрих «в процессе» — тоже.
    boris.send(Map.of("type", "presence", "x", 10.5, "y", -3, "tool", "laser", "button", "down"));
    var cursor = anna.await("presence");
    assertThat(cursor.path("from").asText()).isEqualTo(guest.participantId());
    assertThat(cursor.path("tool").asText()).isEqualTo("laser");
    anna.send(
        Map.of(
            "type",
            "ink",
            "id",
            "stroke1",
            "start",
            0,
            "pts",
            List.of(List.of(0, 0, 0.5), List.of(3, 4, 0.5)),
            "el",
            Map.of("x", 5, "y", 6, "strokeColor", "#1e1e1e", "script", "<b>")));
    var ink = boris.await("ink");
    assertThat(ink.path("pts")).hasSize(2);
    assertThat(ink.path("el").path("strokeColor").asText()).isEqualTo("#1e1e1e");
    assertThat(ink.path("el").has("script")).isFalse();
  }

  @Test
  void whenTheHostDrawsTheOthersWatchAndGetThePenBackAtOnce() throws Exception {
    var host = host();
    var guest = guest(host);
    command(host, "board.open", "host");
    var boris = new Client();
    boris.auth(guest, -1, -1);
    assertThat(boris.await("hello").path("canDraw").asBoolean()).isFalse();
    boris.send(ops(rect("x", 1, 1)));
    assertThat(boris.await("error").path("code").asText()).isEqualTo("VIEW_ONLY");
    assertThat(boards.hub(host.roomId()).room().live()).isZero();
    // Участник не вернёт себе перо командой: «рисует ведущий» меняет только создатель.
    assertThatThrownBy(() -> command(guest, "board.settings", "all"))
        .isInstanceOf(dev.mikki.stream.shared.Problem.class);
    command(host, "board.settings", "all");
    assertThat(boris.await("access").path("canDraw").asBoolean()).isTrue();
    boris.send(ops(rect("x", 1, 1)));
    assertThat(boris.await("ack").path("n").asInt()).isEqualTo(1);
  }

  @Test
  void returningSocketGetsOnlyWhatItMissedOrTheWholeScene() throws Exception {
    var host = host();
    var guest = guest(host);
    command(host, "board.open", null);
    var anna = new Client();
    anna.auth(host, -1, -1);
    anna.await("scene");
    anna.send(ops(rect("a", 1, 1)));
    var first = anna.await("ack");
    anna.send(ops(rect("b", 1, 1)));
    anna.send(ops(rect("c", 1, 1)));
    anna.await("ack", m -> m.path("seq").asLong() == first.path("seq").asLong() + 2);
    long epoch = boards.hub(host.roomId()).room().epoch();

    var boris = new Client();
    boris.auth(guest, epoch, first.path("seq").asLong());
    assertThat(boris.await("hello").path("mode").asText()).isEqualTo("replay");
    boris.await("synced");
    assertThat(boris.all("ops"))
        .extracting(m -> m.path("els").get(0).path("id").asText())
        .containsExactly("b", "c");
    assertThat(boris.all("ops")).allMatch(m -> m.path("replay").asBoolean());
    assertThat(boris.all("scene")).isEmpty();

    var late = new Client();
    late.auth(guest, epoch + 5, 1);
    assertThat(late.await("hello").path("mode").asText()).isEqualTo("scene");
    assertThat(late.await("scene").path("els")).hasSize(3);

    // «Я что-то пропустил» по тому же сокету — пропущенное ещё раз.
    late.send(Map.of("type", "sync", "epoch", epoch, "since", first.path("seq").asLong()));
    late.await("synced");
  }

  @Test
  void clearGivesEveryoneAnEmptyBoardOfANewGeneration() throws Exception {
    var host = host();
    var guest = guest(host);
    command(host, "board.open", null);
    var anna = new Client();
    anna.auth(host, -1, -1);
    var boris = new Client();
    boris.auth(guest, -1, -1);
    long epoch = anna.await("hello").path("epoch").asLong();
    anna.send(ops(rect("a", 1, 1)));
    boris.await("ops");
    // Очистить при «рисуют все» может и участник, если встреча разрешает интеграции.
    command(guest, "board.clear", null);
    var cleared = anna.await("cleared");
    assertThat(cleared.path("epoch").asLong()).isEqualTo(epoch + 1);
    assertThat(cleared.path("by").asText()).isEqualTo(guest.participantId());
    assertThat(boris.await("cleared").path("epoch").asLong()).isEqualTo(epoch + 1);
    assertThat(boards.hub(host.roomId()).room().live()).isZero();
    assertThat(store.load(host.roomId()).orElseThrow().epoch()).isEqualTo(epoch + 1);
  }

  @Test
  void sceneSurvivesLeavingMemoryAndComesBackFromTheDatabase() throws Exception {
    var host = host();
    command(host, "board.open", null);
    var anna = new Client();
    anna.auth(host, -1, -1);
    anna.await("scene");
    anna.send(ops(rect("kept", 2, 5)));
    anna.await("ack");
    // Последний ушёл — сцена записана сразу; час спустя доски нет в памяти, но есть в базе.
    anna.session.close(CloseStatus.NORMAL);
    assertThat(store.load(host.roomId()).orElseThrow().elements()).contains("\"kept\"");
    now.addAndGet(3_600_000);
    boards.flushDue();
    assertThat(boards.existing(host.roomId())).isEmpty();
    var again = new Client();
    again.auth(host, -1, -1);
    var scene = again.await("scene");
    assertThat(scene.path("els").get(0).path("id").asText()).isEqualTo("kept");
  }

  @Test
  void closedBoardBadPassAndRemovedParticipantLoseTheSocket() throws Exception {
    var host = host();
    var guest = guest(host);
    var early = new Client();
    early.auth(host, -1, -1);
    early.awaitClosed();
    assertThat(early.closed.get().getCode()).isEqualTo(4001);

    command(host, "board.open", null);
    var stranger = new Client();
    stranger.send(
        Map.of("type", "auth", "roomId", host.roomId(), "credential", host.participantId() + ".x"));
    stranger.awaitClosed();
    assertThat(stranger.closed.get().getCode()).isEqualTo(4003);

    var boris = new Client();
    boris.auth(guest, -1, -1);
    boris.await("scene");
    rooms.command(
        host.roomId(),
        host.credential(),
        new Command(UUID.randomUUID(), "participant.remove", null, guest.participantId(), 0));
    socket.recheck();
    boris.awaitClosed();
    assertThat(boris.closed.get().getCode()).isEqualTo(4003);

    var anna = new Client();
    anna.auth(host, -1, -1);
    anna.await("scene");
    command(host, "board.close", null);
    anna.awaitClosed();
    assertThat(anna.closed.get().getCode()).isEqualTo(4001);
  }

  @Test
  void picturesAreCheckedByTheirBytesAndOnlyDrawersPutThem() throws Exception {
    var mvc = MockMvcBuilders.webAppContextSetup(web).build();
    var host = host();
    var guest = guest(host);
    command(host, "board.open", "host");
    var png = new byte[] {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 13};
    var path = "/api/v1/rooms/" + host.roomId() + "/board/files/";
    mvc.perform(
            put(path + "pic1")
                .header("Authorization", "Bearer " + host.credential())
                .contentType("image/png")
                .content(png))
        .andExpect(status().isNoContent());
    // SVG под видом PNG и просто SVG — нет: на доску идут только растровые картинки.
    mvc.perform(
            put(path + "pic2")
                .header("Authorization", "Bearer " + host.credential())
                .contentType("image/png")
                .content("<svg onload=alert(1)>".getBytes()))
        .andExpect(status().isUnsupportedMediaType());
    mvc.perform(
            put(path + "pic3")
                .header("Authorization", "Bearer " + host.credential())
                .contentType("image/svg+xml")
                .content("<svg/>".getBytes()))
        .andExpect(status().isUnsupportedMediaType());
    // Кто не рисует — не кладёт, но смотрит.
    mvc.perform(
            put(path + "pic4")
                .header("Authorization", "Bearer " + guest.credential())
                .contentType("image/png")
                .content(png))
        .andExpect(status().isForbidden());
    var body =
        mvc.perform(get(path + "pic1").header("Authorization", "Bearer " + guest.credential()))
            .andExpect(status().isOk())
            .andExpect(header().string("Content-Type", "image/png"))
            .andReturn()
            .getResponse()
            .getContentAsByteArray();
    assertThat(body).isEqualTo(png);
    mvc.perform(get(path + "nope").header("Authorization", "Bearer " + guest.credential()))
        .andExpect(status().isNotFound());
    assertThat(boards.hub(host.roomId()).room().hasFile("pic1")).isTrue();
  }

  /** Медленный сокет не держит доску: его очередь переполняется, и он закрывается сам. */
  @Test
  void slowSocketIsClosedNotWaitedFor() throws Exception {
    var gate = new java.util.concurrent.CountDownLatch(1);
    var closed = new AtomicBoolean();
    var outbox =
        new dev.mikki.stream.board.Outbox(
            new dev.mikki.stream.board.Outbox.Sink() {
              @Override
              public void send(String text) throws Exception {
                gate.await();
              }

              @Override
              public void close() {
                closed.set(true);
                gate.countDown();
              }
            },
            java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor(),
            1000);
    assertThat(outbox.reliable("x".repeat(600))).isTrue(); // уходит и виснет в сети
    long until = System.currentTimeMillis() + 2000;
    while (outbox.pending() > 0 && System.currentTimeMillis() < until) Thread.onSpinWait();
    assertThat(outbox.reliable("y".repeat(600))).isTrue(); // ждёт
    for (int i = 0; i < 20; i++)
      outbox.ephemeral(new dev.mikki.stream.board.Ephemeral.Presence("p:a", "{\"x\":" + i + "}"));
    assertThat(outbox.reliable("z".repeat(600))).isFalse(); // не помещается — сокет закрыт
    assertThat(closed).isTrue();
    assertThat(outbox.closed()).isTrue();
    assertThat(outbox.stuck(System.currentTimeMillis(), 1000)).isFalse();
  }
}
