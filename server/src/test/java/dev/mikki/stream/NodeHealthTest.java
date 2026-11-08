package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

import dev.mikki.stream.media.MediaGateway;
import dev.mikki.stream.media.MediaService;
import dev.mikki.stream.media.NodeHealth;
import dev.mikki.stream.nodes.MediaNode;
import dev.mikki.stream.nodes.MediaNodes;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Clock;
import java.util.Map;
import org.junit.jupiter.api.Test;

class NodeHealthTest {
  final MediaNodes nodes = mock(MediaNodes.class);
  final MediaService media = mock(MediaService.class);
  final SimpleMeterRegistry registry = new SimpleMeterRegistry();
  final NodeHealth health =
      new NodeHealth(nodes, mock(MediaGateway.class), media, registry, mock(Clock.class));
  final MediaNode hel =
      new MediaNode(
          "hel",
          false,
          Map.of(),
          "wss://rtc-hel",
          "https://hel",
          null,
          "http://127.0.0.1:21000",
          2,
          true);

  @Test
  void threeMissesInARowMarkTheNodeDeadOnceAndMoveItsRooms() {
    health.observe(hel, 1, 1000);
    verify(nodes).rooms("hel", 1);
    health.observe(hel, null, 6000);
    health.observe(hel, null, 11000);
    verify(media, never()).evacuate("hel");
    assertThat(registry.get("cord.node.up").tag("node", "hel").gauge().value()).isEqualTo(1);
    health.observe(hel, null, 16000);
    verify(nodes).down("hel", true);
    verify(media).evacuate("hel");
    assertThat(registry.get("cord.node.up").tag("node", "hel").gauge().value()).isEqualTo(0);
    // Четвёртый промах — узел уже мёртв, переселять второй раз нечего.
    health.observe(hel, null, 21000);
    verify(media, times(1)).evacuate("hel");
    // Ожил — снова в выборе, комнаты назад не ездят (evacuate не зовётся).
    health.observe(hel, 0, 26000);
    verify(nodes).down("hel", false);
    assertThat(registry.get("cord.node.up").tag("node", "hel").gauge().value()).isEqualTo(1);
    assertThat(registry.get("cord.node.rooms").tag("node", "hel").gauge().value()).isEqualTo(0);
    verify(media, times(1)).evacuate("hel");
  }

  @Test
  void aSingleMissIsNotAnOutage() {
    health.observe(hel, 2, 1000);
    health.observe(hel, null, 6000);
    health.observe(hel, 2, 11000);
    health.observe(hel, null, 16000);
    health.observe(hel, null, 21000);
    verify(nodes, never()).down("hel", true);
    verify(media, never()).evacuate("hel");
  }
}
