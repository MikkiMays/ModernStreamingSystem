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
      "stream.node-id=fra"
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

  /**
   * Была ли открыта транзакция, когда переезд разослал {@code room.changed}: замок строки комнаты
   * держится, только пока транзакция открыта.
   */
  static final List<Boolean> MOVE_IN_TRANSACTION =
      new java.util.concurrent.CopyOnWriteArrayList<>();

  static volatile boolean watchMoves;

  @org.springframework.boot.test.context.TestConfiguration
  static class MoveWatch {
    @org.springframework.context.annotation.Bean
    dev.mikki.stream.room.RoomObserver moveWatch() {
      return new dev.mikki.stream.room.RoomObserver() {
        @Override
        public void changed(RoomState room, String event, long now) {
          if (watchMoves && "room.changed".equals(event))
            MOVE_IN_TRANSACTION.add(
                org.springframework.transaction.support.TransactionSynchronizationManager
                    .isActualTransactionActive());
        }
      };
    }
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

  /**
   * Время — одно на все тесты класса и только вперёд: резерв недавно поставленных встреч и
   * остывание узлов (Р-135) считаются от него, а бин узлов общий.
   */
  static final AtomicLong now = new AtomicLong(System.currentTimeMillis());

  @BeforeEach
  void setUp() {
    jdbc.sql("DELETE FROM command_receipts").update();
    jdbc.sql("DELETE FROM rooms").update();
    when(clock.millis()).thenAnswer(_ -> now.get());
    when(tus.terminate(anyString())).thenReturn(true);
    nodes.down("hel", false);
    nodes.down("fra", false);
    calm();
  }

  /**
   * Узлы — один бин на все тесты класса: горячий узел и резерв прошлого теста остывают здесь —
   * несколько опросов в спокойствии с запасом времени на гистерезис, резерв и ступень.
   */
  void calm() {
    for (int i = 0; i < 3; i++) {
      for (var id : List.of("fra", "hel")) nodes.load(id, MediaNodes.Sample.rooms(0, 0));
      now.addAndGet(120_000);
    }
  }

  static MediaNodes.Sample cpu(double share) {
    return new MediaNodes.Sample(3, 12, share, 0, 100, 0.4, 0.3, 300);
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
    MOVE_IN_TRANSACTION.clear();
    watchMoves = true;
    try {
      media.evacuate("hel");
    } finally {
      watchMoves = false;
    }
    // Переезд — под замком строки комнаты: в транзакции, а не мимо прокси (вход или выход во время
    // переезда иначе затирается).
    assertThat(MOVE_IN_TRANSACTION).isNotEmpty().containsOnly(true);

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

  /** Ручной выбор при создании (Р-101): узел уважается; занятый — замена со словами, не отказ. */
  @Test
  void aManualNodeIsHonouredAndAFallbackIsNamedWhenItCannotBe() {
    var host = rooms.create(manual("hel"));
    assertThat(rooms.read(host.roomId()).mediaNode).isEqualTo("hel");
    assertThat(host.nodeFallback()).isNull();

    nodes.down("hel", true);
    var fallen = rooms.create(manual("hel"));
    assertThat(rooms.read(fallen.roomId()).mediaNode).isEqualTo("fra");
    assertThat(fallen.nodeFallback())
        .isEqualTo(new dev.mikki.stream.room.Contracts.NodeFallback("hel", "fra"));
    // Авто с тем же исходом — без плашки: человек ничего не просил.
    assertThat(rooms.create(create("hel")).nodeFallback()).isNull();
  }

  /** Своя команда на каждый вызов: одинаковый commandId вернул бы квитанцию прошлого входа. */
  Create manual(String node) {
    return new Create(UUID.randomUUID(), "Встреча", "Организатор", false, null, node, null, true);
  }

  /**
   * Ручной перевод идущей встречи (Р-104): создатель — да, гость — нет; те же проверки, что у
   * узлов.
   */
  @Test
  void theCreatorMovesTheMeetingAndEveryoneReconnectsThere() {
    var host = rooms.create(create("fra"));
    var guest =
        rooms.join(
            host.roomId(),
            new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"));
    media.observe(
        host.roomId(),
        Map.of(host.participantId(), "PA_1", guest.participantId(), "PA_2"),
        now.incrementAndGet());
    assertThat(host.snapshot().you().can()).contains("media.move");
    assertThat(rooms.snapshot(guest.roomId(), guest.credential()).you().can())
        .doesNotContain("media.move");

    assertThatThrownBy(
            () -> media.move(guest.roomId(), guest.credential(), UUID.randomUUID(), "hel"))
        .isInstanceOf(Problem.class)
        .satisfies(e -> assertThat(((Problem) e).status()).isEqualTo(403));
    assertThatThrownBy(() -> media.move(host.roomId(), host.credential(), UUID.randomUUID(), "msk"))
        .isInstanceOf(Problem.class)
        .satisfies(e -> assertThat(((Problem) e).code()).isEqualTo("NODE_UNAVAILABLE"));
    // Тот же узел — успех без переезда.
    assertThat(media.move(host.roomId(), host.credential(), UUID.randomUUID(), "fra").ok())
        .isTrue();
    assertThat(rooms.read(host.roomId()).mediaMoves).isNull();

    var ack = media.move(host.roomId(), host.credential(), UUID.randomUUID(), "hel");
    assertThat(ack.ok()).isTrue();
    var moved = rooms.read(host.roomId());
    assertThat(moved.mediaNode).isEqualTo("hel");
    assertThat(moved.mediaMoves).isEqualTo(1);
    assertThat(moved.members.values()).allMatch(m -> m.status == RoomState.Status.RECOVERING);
    assertThat(
            new MediaGateway(config, nodes, repository)
                .token(moved, moved.members.get(guest.participantId()))
                .url())
        .isEqualTo("wss://rtc-hel.test");

    // Пока люди восстанавливаются — второй перевод не принимается; после — не чаще раза в минуту.
    assertThatThrownBy(() -> media.move(host.roomId(), host.credential(), UUID.randomUUID(), "fra"))
        .isInstanceOf(Problem.class)
        .satisfies(e -> assertThat(((Problem) e).code()).isEqualTo("MEDIA_MOVE_BUSY"));
    media.observe(
        host.roomId(),
        Map.of(host.participantId(), "PB_1", guest.participantId(), "PB_2"),
        now.incrementAndGet());
    assertThatThrownBy(() -> media.move(host.roomId(), host.credential(), UUID.randomUUID(), "fra"))
        .isInstanceOf(Problem.class)
        .satisfies(e -> assertThat(((Problem) e).code()).isEqualTo("MEDIA_MOVE_RATE"));
    now.addAndGet(MediaService.MOVE_INTERVAL_MS);
    assertThat(media.move(host.roomId(), host.credential(), UUID.randomUUID(), "fra").ok())
        .isTrue();
    assertThat(rooms.read(host.roomId()).mediaMoves).isEqualTo(2);
    // Мёртвый или дренируемый узел — отказ словами, а не переезд в никуда. Люди сначала
    // возвращаются на связь (иначе окно восстановления истекло бы вместе с минутой ожидания).
    media.observe(
        host.roomId(),
        Map.of(host.participantId(), "PC_1", guest.participantId(), "PC_2"),
        now.incrementAndGet());
    now.addAndGet(MediaService.MOVE_INTERVAL_MS);
    nodes.down("hel", true);
    assertThatThrownBy(() -> media.move(host.roomId(), host.credential(), UUID.randomUUID(), "hel"))
        .isInstanceOf(Problem.class)
        .satisfies(e -> assertThat(((Problem) e).code()).isEqualTo("NODE_UNAVAILABLE"));
  }

  /**
   * Общего предела встреч нет (Р-135): сорок встреч разом создаются, в каждую входят, и дверь
   * пустой встречи не закрывается тем, что сорок других идут. Пределы антибота (10 в час с адреса,
   * 6 с профиля) — про создателя, а не про сервер; здесь создатель — служба без адреса.
   */
  @Test
  void fortyMeetingsAtOnceAreAllAdmittedWithoutAnyCountLimit() throws Exception {
    var created =
        new java.util.concurrent.CopyOnWriteArrayList<dev.mikki.stream.room.Contracts.Admission>();
    try (var pool = java.util.concurrent.Executors.newFixedThreadPool(8)) {
      var futures = new java.util.ArrayList<java.util.concurrent.Future<?>>();
      for (int i = 0; i < 40; i++)
        futures.add(pool.submit(() -> created.add(rooms.create(create(null)))));
      for (var future : futures) future.get();
    }
    assertThat(created).hasSize(40);
    assertThat(created.stream().map(dev.mikki.stream.room.Contracts.Admission::roomId).distinct())
        .hasSize(40);
    // Пачка расходится по узлам: каждая поставленная встреча резервирует свою долю, пока её нет в
    // метриках (Р-135), — и ни одной не отказано.
    assertThat(
            created.stream()
                .map(a -> rooms.read(a.roomId()).mediaNode)
                .collect(java.util.stream.Collectors.toSet()))
        .containsExactlyInAnyOrder("fra", "hel");
    // Каждая — с человеком на связи, то есть по-настоящему идёт.
    for (var host : created)
      media.observe(
          host.roomId(),
          Map.of(host.participantId(), "PA_" + host.roomId()),
          now.incrementAndGet());
    now.addAndGet(RoomState.FRESH_MS + 1);
    assertThat(repository.all().stream().filter(r -> r.busy(now.get()))).hasSize(40);
    // Сорок первая: создаётся, стоит пустой дольше 30 с — и всё равно пускает гостя.
    var late = rooms.create(create(null));
    now.addAndGet(RoomState.FRESH_MS + 1);
    assertThat(rooms.read(late.roomId()).busy(now.get())).isFalse();
    var guest =
        rooms.join(
            late.roomId(),
            new Join(UUID.randomUUID(), late.inviteUrl().split("invite=")[1], "Гость"));
    assertThat(guest.participantId()).isNotBlank();
    for (var host : created)
      assertThat(
              rooms.join(
                  host.roomId(),
                  new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость")))
          .isNotNull();
  }

  /**
   * Перегруженный узел новых встреч не берёт, пока у другого есть запас: встреча идёт на следующий
   * ближайший; ручной выбор — замена со словами (Р-101). Запаса нет нигде — встреча всё равно
   * создаётся, на наименее загруженном узле, а не отказ (Р-135).
   */
  @Test
  void aHotNodeSpillsNewMeetingsOverAndASaturatedFleetStillAdmits() {
    nodes.load("hel", cpu(0.85));
    assertThat(nodes.levelOf(nodes.resolve("hel")).state()).isEqualTo("full");
    var spilled = rooms.create(create("hel"));
    assertThat(rooms.read(spilled.roomId()).mediaNode).isEqualTo("fra");
    assertThat(spilled.nodeFallback()).isNull();
    var manual = rooms.create(manual("hel"));
    assertThat(rooms.read(manual.roomId()).mediaNode).isEqualTo("fra");
    assertThat(manual.nodeFallback())
        .isEqualTo(new dev.mikki.stream.room.Contracts.NodeFallback("hel", "fra"));

    nodes.load("fra", cpu(0.95));
    assertThat(nodes.saturated()).isTrue();
    for (int i = 0; i < 5; i++) {
      var admitted = rooms.create(create("hel"));
      // hel (85 %) свободнее fra (95 %) — туда, хоть и горячий.
      assertThat(rooms.read(admitted.roomId()).mediaNode).isEqualTo("hel");
      assertThat(
              rooms.join(
                  admitted.roomId(),
                  new Join(UUID.randomUUID(), admitted.inviteUrl().split("invite=")[1], "Гость")))
          .isNotNull();
    }
  }

  /**
   * Идущая встреча ради нагрузки не переезжает (Р-102): узел стал горячим — люди остаются, новые
   * входят туда же; переезжает она только со смертью узла.
   */
  @Test
  void aRunningMeetingStaysOnItsHotNodeAndMovesOnlyWhenTheNodeDies() {
    var host = rooms.create(create("hel"));
    media.observe(host.roomId(), Map.of(host.participantId(), "PA_1"), now.incrementAndGet());
    nodes.load("hel", cpu(0.99));
    nodes.load("hel", cpu(0.99));
    var guest =
        rooms.join(
            host.roomId(),
            new Join(UUID.randomUUID(), host.inviteUrl().split("invite=")[1], "Гость"));
    assertThat(guest.snapshot().mediaNode()).isEqualTo("hel");
    var room = rooms.read(host.roomId());
    assertThat(room.mediaNode).isEqualTo("hel");
    assertThat(room.mediaMoves).isNull();
    assertThat(
            new MediaGateway(config, nodes, repository)
                .token(room, room.members.get(guest.participantId()))
                .url())
        .isEqualTo("wss://rtc-hel.test");

    nodes.down("hel", true);
    media.evacuate("hel");
    var moved = rooms.read(host.roomId());
    assertThat(moved.mediaNode).isEqualTo("fra");
    assertThat(moved.mediaMoves).isEqualTo(1);
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
