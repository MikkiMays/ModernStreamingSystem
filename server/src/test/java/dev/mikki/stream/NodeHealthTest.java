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
import dev.mikki.stream.nodes.LossReports;
import dev.mikki.stream.nodes.MediaNode;
import dev.mikki.stream.nodes.MediaNodes;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

/**
 * Отказ узла по двум признакам (R200 §5, Р-105): промахи опроса раз в 2 с и жалобы людей. Время в
 * тестах — явное; опрос «не ответил» = {@code null} через 1 с после начала опроса.
 */
class NodeHealthTest {
  final MediaNodes nodes = mock(MediaNodes.class);
  final MediaService media = mock(MediaService.class);
  final LossReports losses = new LossReports();
  final SimpleMeterRegistry registry = new SimpleMeterRegistry();
  final AtomicLong now = new AtomicLong();
  final Clock clock = mock(Clock.class);
  final NodeHealth health;
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

  NodeHealthTest() {
    when(clock.millis()).thenAnswer(_ -> now.get());
    health = new NodeHealth(nodes, mock(MediaGateway.class), media, losses, registry, clock);
  }

  final MediaGateway.NodeStats ok = new MediaGateway.NodeStats(1, 4);
  final Set<String> four = Set.of("a", "b", "c", "d");

  /** Промах опроса в момент {@code at}: начался за секунду до — таймаут вызова. */
  void miss(long at) {
    now.set(at);
    health.observe(hel, (MediaGateway.NodeStats) null, at);
  }

  void answer(long at) {
    now.set(at);
    health.observe(hel, ok, at);
  }

  double gauge(String name) {
    return registry.get(name).tag("node", "hel").gauge().value();
  }

  @Test
  void ruleA_twoMissesAndHalfThePeopleLosingMediaMoveTheRoomsWithinAboutFiveSeconds() {
    when(media.onNode("hel")).thenReturn(four);
    answer(0);
    // SFU остановился в t≈0,5. Опросы в 2 и 4 с не отвечают (промахи в 3 и 5 с).
    miss(3000);
    verify(nodes, never()).unreachable("hel", true);
    miss(5000);
    // Два промаха, жалоб нет — пока только «недоступен»: новых встреч нет, идущие не трогаются.
    verify(nodes).unreachable("hel", true);
    verify(media, never()).evacuate("hel");
    assertThat(gauge("cord.node.up")).isEqualTo(1);
    assertThat(gauge("cord.node.reachable")).isEqualTo(0);
    // Один из четырёх заметил молчание (media.stall ≈ 5 с) — четверть, не половина.
    losses.lost("hel", "a", 5200);
    health.reassess(hel, 5200);
    verify(media, never()).evacuate("hel");
    // Второй — половина: узел мёртв сразу по жалобе, а не по следующему опросу.
    losses.lost("hel", "b", 5600);
    health.reassess(hel, 5600);
    verify(nodes).down("hel", true);
    verify(media, times(1)).evacuate("hel");
    assertThat(gauge("cord.node.up")).isEqualTo(0);
    // Отметки узла забыты вместе с его комнатами; `sweep` доселяет опоздавших на каждом проходе.
    assertThat(losses.reported("hel")).isEqualTo(0);
    when(nodes.all()).thenReturn(List.of(hel));
    when(nodes.isDown("hel")).thenReturn(true);
    health.sweep();
    verify(media, times(2)).evacuate("hel");
    // Дальнейшие промахи и жалобы смерть не повторяют.
    miss(7000);
    losses.lost("hel", "c", 7100);
    health.reassess(hel, 7100);
    verify(nodes, times(1)).down("hel", true);
    // Ожил — снова в выборе; комнаты назад не ездят (sweep живой узел не трогает).
    answer(30000);
    verify(nodes).down("hel", false);
    verify(nodes).unreachable("hel", false);
    when(nodes.isDown("hel")).thenReturn(false);
    health.sweep();
    verify(media, times(2)).evacuate("hel");
    assertThat(gauge("cord.node.up")).isEqualTo(1);
    assertThat(gauge("cord.node.reachable")).isEqualTo(1);
  }

  @Test
  void missesWithoutComplaintsAreTheBackboneNotTheNode_noRoomMoves() {
    // Магистраль через фильтр A легла на полминуты, SFU узла и его люди в порядке.
    when(media.onNode("hel")).thenReturn(four);
    answer(0);
    for (long at = 3000; at <= 31000; at += 2000) miss(at);
    verify(nodes).unreachable("hel", true);
    verify(nodes, never()).down("hel", true);
    verify(media, never()).evacuate("hel");
    assertThat(gauge("cord.node.up")).isEqualTo(1);
    assertThat(gauge("cord.node.reachable")).isEqualTo(0);
    // Магистраль вернулась — узел снова принимает встречи.
    answer(33000);
    verify(nodes).unreachable("hel", false);
    verify(nodes, never()).down("hel", false);
    assertThat(gauge("cord.node.reachable")).isEqualTo(1);
  }

  @Test
  void aHostStallOfTwoToFourSecondsIsNotAnOutageEvenWithOneComplaint() {
    // Хост B замер на 3 с: один промах (следующий опрос уже ответил), один человек успел
    // пожаловаться.
    when(media.onNode("hel")).thenReturn(four);
    answer(0);
    miss(3000);
    losses.lost("hel", "a", 3500);
    health.reassess(hel, 3500);
    answer(5000);
    verify(nodes, never()).unreachable("hel", true);
    verify(nodes, never()).down("hel", true);
    verify(media, never()).evacuate("hel");
  }

  @Test
  void ruleB_fourMissesWithNobodyConnectedRetireTheNode() {
    when(media.onNode("hel")).thenReturn(Set.of());
    answer(0);
    miss(3000);
    miss(5000);
    miss(7000);
    verify(media, never()).evacuate("hel");
    verify(nodes).unreachable("hel", true);
    miss(9000);
    verify(nodes).down("hel", true);
    verify(media).evacuate("hel");
  }

  @Test
  void ruleC_peopleStuckWithoutMediaForTwentySecondsWhileTheNodeAnswersMoveAway() {
    // UDP и 443 к узлу режут у провайдера: магистраль отвечает, люди без медиа и не возвращаются.
    when(media.onNode("hel")).thenReturn(four);
    answer(0);
    losses.lost("hel", "a", 1000);
    losses.lost("hel", "b", 1500);
    losses.lost("hel", "c", 2000);
    for (long at = 2000; at <= 20000; at += 2000) answer(at);
    verify(media, never()).evacuate("hel");
    answer(21500);
    verify(nodes).down("hel", true);
    verify(media).evacuate("hel");
    verify(nodes, never()).unreachable("hel", true);
  }

  @Test
  void complaintsAloneAreSomeonesWifiNotTheNode() {
    when(media.onNode("hel")).thenReturn(four);
    answer(0);
    losses.lost("hel", "a", 1000);
    losses.lost("hel", "b", 1200);
    losses.lost("hel", "c", 1400);
    health.reassess(hel, 1400);
    for (long at = 2000; at <= 18000; at += 2000) answer(at);
    verify(media, never()).evacuate("hel");
    // Вернулись раньше 20 с — никакого правила C.
    losses.restored("a");
    losses.restored("b");
    answer(22000);
    answer(40000);
    verify(media, never()).evacuate("hel");
    verify(nodes, never()).down("hel", true);
  }

  @Test
  void peopleWhoLeftTheRoomDoNotCountAsComplaints() {
    // Жаловались трое, но двое уже вышли: из оставшихся троих в беде один — не половина.
    when(media.onNode("hel")).thenReturn(Set.of("c", "d", "e"));
    answer(0);
    losses.lost("hel", "a", 500);
    losses.lost("hel", "b", 600);
    losses.lost("hel", "c", 700);
    miss(3000);
    miss(5000);
    verify(media, never()).evacuate("hel");
    losses.lost("hel", "d", 5100);
    health.reassess(hel, 5100);
    verify(media).evacuate("hel");
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
    answer(1000);
    miss(3000);
    answer(5000);
    miss(7000);
    miss(9000);
    verify(nodes, never()).down("hel", true);
    verify(media, never()).evacuate("hel");
  }
}
