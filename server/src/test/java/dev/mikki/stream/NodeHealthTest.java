package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import dev.mikki.stream.media.MediaGateway;
import dev.mikki.stream.media.MediaService;
import dev.mikki.stream.media.NodeHealth;
import dev.mikki.stream.nodes.MediaNode;
import dev.mikki.stream.nodes.MediaNodes;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Clock;
import java.util.List;
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
    health.observe(hel, new MediaGateway.NodeStats(1, 0), 1000);
    verify(nodes).load("hel", 1, 0, Double.NaN, Double.NaN, Double.NaN);
    health.observe(hel, (MediaGateway.NodeStats) null, 6000);
    health.observe(hel, (MediaGateway.NodeStats) null, 11000);
    verify(media, never()).evacuate("hel");
    assertThat(registry.get("cord.node.up").tag("node", "hel").gauge().value()).isEqualTo(1);
    health.observe(hel, (MediaGateway.NodeStats) null, 16000);
    verify(nodes).down("hel", true);
    assertThat(registry.get("cord.node.up").tag("node", "hel").gauge().value()).isEqualTo(0);
    // Переселяет проход `sweep` — и на каждом проходе, пока узел мёртв: опоздавшие комнаты не
    // застрянут.
    when(nodes.all()).thenReturn(List.of(hel));
    when(nodes.isDown("hel")).thenReturn(true);
    health.sweep();
    verify(media, times(1)).evacuate("hel");
    health.observe(hel, (MediaGateway.NodeStats) null, 21000);
    health.sweep();
    verify(media, times(2)).evacuate("hel");
    // Ожил — снова в выборе, комнаты назад не ездят: `sweep` живой узел не трогает.
    health.observe(hel, new MediaGateway.NodeStats(0, 0), 26000);
    verify(nodes).down("hel", false);
    when(nodes.isDown("hel")).thenReturn(false);
    health.sweep();
    assertThat(registry.get("cord.node.up").tag("node", "hel").gauge().value()).isEqualTo(1);
    assertThat(registry.get("cord.node.rooms").tag("node", "hel").gauge().value()).isEqualTo(0);
    verify(media, times(2)).evacuate("hel");
  }

  @Test
  void peopleAndNodeExporterSharesReachTheRegistryWithTheRooms() {
    health.observe(hel, new MediaGateway.NodeStats(1, 5), 1000);
    verify(nodes).load("hel", 1, 5, Double.NaN, Double.NaN, Double.NaN);
    assertThat(registry.get("cord.node.participants").tag("node", "hel").gauge().value())
        .isEqualTo(5);
    // Первый снимок node-exporter долей не даёт; второй через 5 с — даёт: 50 % ЦП, 10 % steal,
    // 8 Мбит/с.
    health.measure(hel, exporter(100, 50, 0, 0), 1000);
    health.observe(hel, new MediaGateway.NodeStats(1, 5), 1000);
    verify(nodes, times(2)).load("hel", 1, 5, Double.NaN, Double.NaN, Double.NaN);
    health.measure(hel, exporter(200, 100, 10, 5_000_000), 6000);
    health.observe(hel, new MediaGateway.NodeStats(1, 6), 6000);
    verify(nodes).load("hel", 1, 6, 0.5, 0.1, 8.0);
    // node-exporter замолчал — доли остаются сглаженными, пока молчание короткое…
    health.measure(hel, null, 11000);
    health.observe(hel, new MediaGateway.NodeStats(1, 6), 11000);
    verify(nodes, times(2)).load("hel", 1, 6, 0.5, 0.1, 8.0);
    // …и забываются, когда молчит дольше трёх опросов: ступень считается без ЦП и канала.
    health.measure(hel, null, 26000);
    health.observe(hel, new MediaGateway.NodeStats(1, 6), 26000);
    verify(nodes).load("hel", 1, 6, Double.NaN, Double.NaN, Double.NaN);
    // Чужой текст (не node-exporter) — как молчание.
    health.measure(hel, "<html>busy</html>", 27000);
    verify(nodes, never()).down("hel", true);
  }

  static String exporter(double total, double idle, double steal, long tx) {
    var busy = total - idle - steal;
    return """
        # HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.
        node_cpu_seconds_total{cpu="0",mode="idle"} %s
        node_cpu_seconds_total{cpu="0",mode="steal"} %s
        node_cpu_seconds_total{cpu="0",mode="user"} %s
        node_network_transmit_bytes_total{device="lo"} 99999999
        node_network_transmit_bytes_total{device="docker0"} 5555555
        node_network_transmit_bytes_total{device="eth0"} %d
        """
        .formatted(idle, steal, busy, tx);
  }

  @Test
  void aSingleMissIsNotAnOutage() {
    health.observe(hel, new MediaGateway.NodeStats(2, 0), 1000);
    health.observe(hel, (MediaGateway.NodeStats) null, 6000);
    health.observe(hel, new MediaGateway.NodeStats(2, 0), 11000);
    health.observe(hel, (MediaGateway.NodeStats) null, 16000);
    health.observe(hel, (MediaGateway.NodeStats) null, 21000);
    verify(nodes, never()).down("hel", true);
    verify(media, never()).evacuate("hel");
  }
}
