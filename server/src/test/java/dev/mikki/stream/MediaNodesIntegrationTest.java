package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

import dev.mikki.stream.api.ApiController;
import dev.mikki.stream.attachment.TusGateway;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.media.MediaGateway;
import dev.mikki.stream.media.MediaService;
import dev.mikki.stream.nodes.MediaNodes;
import dev.mikki.stream.room.Contracts.Create;
import dev.mikki.stream.room.Contracts.Join;
import dev.mikki.stream.room.Contracts.NodeMeasure;
import dev.mikki.stream.room.RoomRepository;
import dev.mikki.stream.room.RoomService;
import dev.mikki.stream.room.RoomState;
import dev.mikki.stream.shared.Problem;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/**
 * Встреча живёт на одном узле медиа (R195): узел выбирается при создании по замеру создателя,
 * токены ведут на него, сигналинг другого узла её не пускает, а смерть узла переселяет её на живой.
 */
@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:nodes;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.files-root=./.local/test-uploads",
      "stream.node-id=fra",
      "stream.max-rooms=200"
    })
@ActiveProfiles("local")
class MediaNodesIntegrationTest {
  static final Path REGISTRY;

  static {
    try {
      REGISTRY = Files.createTempFile("cord-nodes", ".json");
      Files.writeString(
          REGISTRY,
          """
          {"format":"cord.nodes/1","nodes":[
            {"id":"fra","control":true,"title":{"ru":"Франкфурт"},"rtcUrl":"wss://rtc-fra.test",
             "probeUrl":"https://fra.test","stun":"stun:turn-fra.test:3478","internalUrl":"http://127.0.0.1:7880","maxRooms":8,"enabled":true},
            {"id":"hel","index":1,"title":{"ru":"Хельсинки","en":"Helsinki"},"rtcUrl":"wss://rtc-hel.test",
             "probeUrl":"https://hel.test","stun":"stun:turn-hel.test:3478","internalUrl":"http://127.0.0.1:21000","maxRooms":2,"enabled":true}
          ]}
          """);
    } catch (IOException e) {
      throw new IllegalStateException(e);
    }
  }

  @DynamicPropertySource
  static void registry(DynamicPropertyRegistry registry) {
    registry.add("stream.nodes-file", () -> REGISTRY.toString());
  }

  @Autowired RoomService rooms;
  @Autowired RoomRepository repository;
  @Autowired MediaService media;
  @Autowired MediaNodes nodes;
  @Autowired ApiController api;
  @Autowired StreamProperties config;
  @Autowired JdbcClient jdbc;
  @MockitoBean MediaGateway gateway;
  @MockitoBean TusGateway tus;
  @MockitoBean Clock clock;
  final AtomicLong now = new AtomicLong(System.currentTimeMillis());

  @BeforeEach
  void setUp() {
    jdbc.sql("DELETE FROM command_receipts").update();
    jdbc.sql("DELETE FROM rooms").update();
    when(clock.millis()).thenAnswer(_ -> now.get());
    when(tus.terminate(anyString())).thenReturn(true);
    nodes.down("hel", false);
    nodes.down("fra", false);
  }

  Create create(String preferred) {
    return new Create(
        UUID.randomUUID(),
        "Встреча",
        "Организатор",
        false,
        null,
        preferred,
        preferred == null ? null : List.of(new NodeMeasure(preferred, 12, 11, true)));
  }

  @Test
  void theCreatorsMeasurementPicksTheNodeAndEveryTokenLeadsThere() {
    var host = rooms.create(create("hel"));
    var room = rooms.read(host.roomId());
    assertThat(room.mediaNode).isEqualTo("hel");
    assertThat(host.snapshot().mediaNode()).isEqualTo("hel");
    var token =
        new MediaGateway(config, nodes, repository)
            .token(room, room.members.get(host.participantId()));
    assertThat(token.url()).isEqualTo("wss://rtc-hel.test");

    // Гость идёт туда же — узел задан комнатой, не его замером.
    var guest =
        rooms.join(
            host.roomId(),
            new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"));
    assertThat(guest.snapshot().mediaNode()).isEqualTo("hel");

    // Сигналинг узла hel пускает, узла fra — нет; старый шлюз без заголовка считается узлом
    // управления.
    media.authorizeSignaling(token.token(), "hel");
    assertThatThrownBy(() -> media.authorizeSignaling(token.token(), "fra"))
        .isInstanceOf(Problem.class);
    assertThatThrownBy(() -> media.authorizeSignaling(token.token())).isInstanceOf(Problem.class);

    // Без предпочтения и у комнат без узла — узел управления.
    var plain = rooms.create(create(null));
    assertThat(rooms.read(plain.roomId()).mediaNode).isEqualTo("fra");
    var legacy = rooms.read(plain.roomId());
    legacy.mediaNode = null;
    repository.save(legacy, now.get());
    assertThat(rooms.snapshot(plain.roomId(), plain.credential()).mediaNode()).isEqualTo("fra");
    var legacyToken =
        new MediaGateway(config, nodes, repository)
            .token(legacy, legacy.members.get(plain.participantId()));
    assertThat(legacyToken.url()).isEqualTo("wss://rtc-fra.test");
    media.authorizeSignaling(legacyToken.token());
    media.authorizeSignaling(legacyToken.token(), "fra");
  }

  @Test
  void aDeadNodeSendsItsMeetingsToAnotherAndPeopleIntoRecovery() {
    var host = rooms.create(create("hel"));
    var guest =
        rooms.join(
            host.roomId(),
            new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"));
    media.observe(
        host.roomId(),
        Map.of(host.participantId(), "PA_1", guest.participantId(), "PA_2"),
        now.incrementAndGet());
    var untouched = rooms.create(create(null));
    assertThat(rooms.read(host.roomId()).members.get(guest.participantId()).status)
        .isEqualTo(RoomState.Status.CONNECTED);

    nodes.down("hel", true);
    media.evacuate("hel");

    var moved = rooms.read(host.roomId());
    assertThat(moved.mediaNode).isEqualTo("fra");
    assertThat(moved.mediaMoves).isEqualTo(1);
    assertThat(rooms.snapshot(host.roomId(), host.credential()).mediaMoves()).isEqualTo(1);
    assertThat(rooms.snapshot(untouched.roomId(), untouched.credential()).mediaMoves())
        .isEqualTo(0);
    assertThat(moved.members.values()).allMatch(m -> m.status == RoomState.Status.RECOVERING);
    assertThat(moved.members.get(guest.participantId()).recoveryDeadline)
        .isEqualTo(now.get() + config.recoverySeconds() * 1000L);
    assertThat(rooms.read(untouched.roomId()).mediaNode).isEqualTo("fra");
    // Новый токен ведёт на живой узел, тот же пропуск и та же ссылка.
    assertThat(
            new MediaGateway(config, nodes, repository)
                .token(moved, moved.members.get(guest.participantId()))
                .url())
        .isEqualTo("wss://rtc-fra.test");
    // Пока узел мёртв, новые встречи на него не ставятся даже по предпочтению.
    assertThat(rooms.read(rooms.create(create("hel")).roomId()).mediaNode).isEqualTo("fra");
  }

  @Test
  void capabilitiesListTheNodesPeopleCanMeasureControlFirst() {
    var caps = api.capabilities();
    assertThat(caps.nodes())
        .extracting(ApiController.MediaNodeInfo::id)
        .containsExactly("fra", "hel");
    assertThat(caps.nodes().get(1))
        .extracting(
            n -> n.title().get("ru"),
            ApiController.MediaNodeInfo::rtcUrl,
            ApiController.MediaNodeInfo::probeUrl,
            ApiController.MediaNodeInfo::stun,
            ApiController.MediaNodeInfo::control)
        .containsExactly(
            "Хельсинки",
            "wss://rtc-hel.test",
            "https://hel.test",
            "stun:turn-hel.test:3478",
            false);
    nodes.down("hel", true);
    assertThat(api.capabilities().nodes())
        .extracting(ApiController.MediaNodeInfo::id)
        .containsExactly("fra");
  }
}
