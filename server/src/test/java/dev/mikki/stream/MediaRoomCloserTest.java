package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

import dev.mikki.stream.media.MediaGateway;
import dev.mikki.stream.media.MediaRoomCloser;
import dev.mikki.stream.room.RoomState;
import dev.mikki.stream.shared.Problem;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Комната SFU распускается после фиксации транзакции и не под замком комнаты (R97). */
class MediaRoomCloserTest {
  final MediaGateway gateway = mock(MediaGateway.class);
  final List<Runnable> queued = new ArrayList<>();
  final Executor executor = queued::add;
  final RoomState room = new RoomState();

  @AfterEach
  void tearDown() {
    if (TransactionSynchronizationManager.isSynchronizationActive())
      TransactionSynchronizationManager.clearSynchronization();
  }

  private MediaRoomCloser closer() throws Exception {
    var ctor = MediaRoomCloser.class.getDeclaredConstructor(MediaGateway.class, Executor.class);
    ctor.setAccessible(true);
    return ctor.newInstance(gateway, executor);
  }

  @Test
  void waitsForCommitAndLeavesTheLockBeforeTouchingTheSfu() throws Exception {
    room.id = "r1";
    TransactionSynchronizationManager.initSynchronization();
    closer().closed(room, "host", 1L);
    // До фиксации — ничего: ни в исполнитель, ни в SFU.
    assertThat(queued).isEmpty();
    verifyNoInteractions(gateway);
    for (var sync : TransactionSynchronizationManager.getSynchronizations()) sync.afterCommit();
    // После фиксации — задача в своём потоке, SFU всё ещё не тронут (замок комнаты уже снят).
    assertThat(queued).hasSize(1);
    verifyNoInteractions(gateway);
    queued.get(0).run();
    verify(gateway).close("r1");
  }

  @Test
  void withoutATransactionClosesRightAwayThroughTheExecutor() throws Exception {
    room.id = "r2";
    closer().closed(room, "empty", 1L);
    assertThat(queued).hasSize(1);
    queued.get(0).run();
    verify(gateway).close("r2");
  }

  @Test
  void sfuFailureIsLoggedNotThrown() throws Exception {
    room.id = "r3";
    doThrow(new Problem(503, "MEDIA_UNAVAILABLE", "нет")).when(gateway).close("r3");
    closer().closed(room, "host", 1L);
    queued.get(0).run();
    verify(gateway).close("r3");
  }
}
