package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import dev.mikki.stream.attachment.TusGateway;
import dev.mikki.stream.media.*;
import dev.mikki.stream.room.*;
import dev.mikki.stream.room.Contracts.*;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/**
 * Ядро в простое не работает впустую ({@code docs/architecture/core-scale.md} §3.1): сверка с
 * медиаузлом не переписывает комнату, в которой ничего не изменилось; память о встрече уходит с её
 * концом. Редкий проход сокетов — {@code RoomSocketSweepTest}.
 *
 * <p>Контекст тот же, что у {@link AbuseLimitsTest}, — Spring поднимает его один раз на оба класса.
 */
@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:rooms;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.event-history-limit=10",
      "stream.files-root=./.local/test-uploads",
      "stream.abuse.per-ip.open-rooms=3"
    })
@ActiveProfiles("local")
class IdleCoreTest {
  @Autowired RoomService rooms;
  @Autowired MediaService media;
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
  }

  Admission create() {
    return rooms.create(new Create(UUID.randomUUID(), "Встреча", "Хозяин", false));
  }

  /** Что лежит в строке комнаты: снимок и когда он записан. */
  record Row(String state, long updatedAt) {}

  Row row(String roomId) {
    return jdbc.sql("SELECT state, updated_at FROM rooms WHERE id=?")
        .param(roomId)
        .query((rs, n) -> new Row(rs.getString(1), rs.getLong(2)))
        .single();
  }

  // Сверка с медиаузлом ----------------------------------------------------------------------

  /**
   * Проход сверки, который ничего не нашёл, комнату не пишет: строка та же байт в байт и с той же
   * отметкой записи. Раньше каждая открытая комната переписывалась раз в две секунды.
   */
  @Test
  void aReconcilePassThatFindsNothingNewDoesNotRewriteTheRoom() {
    var host = create();
    media.observe(host.roomId(), Map.of(host.participantId(), "PA_first"), now.addAndGet(2000));
    assertThat(rooms.read(host.roomId()).members.get(host.participantId()).status)
        .isEqualTo(RoomState.Status.CONNECTED);
    var settled = row(host.roomId());
    for (int pass = 0; pass < 5; pass++)
      media.observe(host.roomId(), Map.of(host.participantId(), "PA_first"), now.addAndGet(2000));
    assertThat(row(host.roomId())).isEqualTo(settled);
  }

  /** Изменилось то, что комната хранит, — пишет: новый номер сессии SFU и потеря связи. */
  @Test
  void aReconcilePassStillWritesWhatChanged() {
    var host = create();
    media.observe(host.roomId(), Map.of(host.participantId(), "PA_first"), now.addAndGet(2000));
    long sequence = rooms.read(host.roomId()).sequence;
    // Тот же человек с новой сессией SFU: участникам не новость, но запомнить надо.
    media.observe(host.roomId(), Map.of(host.participantId(), "PA_second"), now.addAndGet(2000));
    var renewed = rooms.read(host.roomId());
    assertThat(renewed.members.get(host.participantId()).mediaSid).isEqualTo("PA_second");
    assertThat(renewed.sequence).isEqualTo(sequence);
    // Узел его больше не видит — восстановление связи, и об этом узнают все.
    media.observe(host.roomId(), Map.of(), now.addAndGet(2000));
    var lost = rooms.read(host.roomId());
    assertThat(lost.members.get(host.participantId()).status)
        .isEqualTo(RoomState.Status.RECOVERING);
    assertThat(lost.sequence).isGreaterThan(sequence);
  }

  /** Медиа завершённой встречи разошлось — отметка ставится один раз, дальше комната не пишется. */
  @Test
  void aClosedRoomIsMarkedDrainedOnce() {
    var host = create();
    rooms.command(
        host.roomId(), host.credential(), new Command(UUID.randomUUID(), "close", null, null, 0));
    media.observe(host.roomId(), Map.of(), now.addAndGet(2000));
    assertThat(rooms.read(host.roomId()).mediaDrained).isTrue();
    var settled = row(host.roomId());
    media.observe(host.roomId(), Map.of(), now.addAndGet(2000));
    assertThat(row(host.roomId())).isEqualTo(settled);
  }

  // Память о встрече -------------------------------------------------------------------------

  /** С концом встречи ядро забывает её номер события и отметки кадров превью. */
  @Test
  void whatTheCoreRemembersAboutAMeetingGoesWithIt() {
    int before = rooms.remembered();
    var host = create();
    media.observe(host.roomId(), Map.of(host.participantId(), "PA_first"), now.addAndGet(2000));
    media.screen(host.roomId(), host.credential(), UUID.randomUUID(), true);
    rooms.command(
        host.roomId(),
        host.credential(),
        new Command(
            UUID.randomUUID(),
            "screen.preview",
            null,
            null,
            0,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            "AAAA"));
    assertThat(rooms.remembered()).isEqualTo(before + 2);
    assertThat(rooms.latest(host.roomId())).isPositive();
    rooms.command(
        host.roomId(), host.credential(), new Command(UUID.randomUUID(), "close", null, null, 0));
    assertThat(rooms.remembered()).isEqualTo(before);
    assertThat(rooms.latest(host.roomId())).isEqualTo(-1);
  }
}
