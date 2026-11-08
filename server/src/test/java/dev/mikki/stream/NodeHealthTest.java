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
  final MediaService.People four = people(Set.of("a", "b", "c", "d"), Set.of());

  static MediaService.People people(Set<String> connected, Set<String> recovering) {
    return new MediaService.People(connected, recovering);
  }

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
    when(media.onNode("hel")).thenReturn(MediaService.People.NONE);
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
    // UDP и 443 к узлу режут у провайдера: магистраль отвечает, люди без медиа и не возвращаются —
    // SDK троих из четырёх переподключается (RECOVERING).
    when(media.onNode("hel")).thenReturn(people(Set.of("d"), Set.of("a", "b", "c")));
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
    when(media.onNode("hel")).thenReturn(people(Set.of("d"), Set.of("a", "b", "c")));
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
    when(media.onNode("hel")).thenReturn(people(Set.of("a", "b", "d"), Set.of("c")));
    answer(22000);
    answer(40000);
    verify(media, never()).evacuate("hel");
    verify(nodes, never()).down("hel", true);
  }

  @Test
  void peopleWhoLeftTheRoomDoNotCountAsComplaints() {
    // Жаловались трое, но двое уже вышли: из оставшихся троих в беде один — не половина.
    when(media.onNode("hel")).thenReturn(people(Set.of("c", "d", "e"), Set.of()));
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

  // ——— Один жалобщик узел не двигает (§5.5) ———

  @Test
  void oneOfOne_theOnlyPersonLeftWithBrokenHomeInternetMovesNothing() {
    // Звонок вдвоём, собеседник ушёл; у оставшегося лёг домашний интернет — SDK переподключается.
    when(media.onNode("hel")).thenReturn(people(Set.of(), Set.of("a")));
    answer(0);
    losses.stall("hel", "a", 500);
    losses.lost("hel", "a", 4000);
    // Узел отвечает: правилу C нужны трое на узле.
    for (long at = 2000; at <= 60000; at += 2000) answer(at);
    verify(media, never()).evacuate("hel");
    // Магистраль заодно мигнула на два опроса — только «недоступен»: двоих жалобщиков нет.
    miss(63000);
    miss(65000);
    health.reassess(hel, 65100);
    verify(nodes).unreachable("hel", true);
    verify(nodes, never()).down("hel", true);
    verify(media, never()).evacuate("hel");
  }

  @Test
  void aLonePersonOnASilentNodeMovesOnlyWithFourMissesAndTheirOwnComplaint() {
    // Человек один на узле и на связи; магистраль молчит дольше, чем терпит правило B, — люди на
    // месте, их не трогают.
    when(media.onNode("hel")).thenReturn(people(Set.of("a"), Set.of()));
    answer(0);
    for (long at = 3000; at <= 31000; at += 2000) miss(at);
    verify(nodes, never()).down("hel", true);
    // Он и сам потерял медиа: судить по двоим нельзя, задеть, кроме него, некого — как пустой узел.
    losses.stall("hel", "a", 31500);
    health.reassess(hel, 31500);
    verify(nodes).down("hel", true);
    verify(media).evacuate("hel");
  }

  @Test
  void aLonePersonsComplaintNeedsTheFourMissesOfRuleB() {
    when(media.onNode("hel")).thenReturn(people(Set.of("a"), Set.of()));
    answer(0);
    miss(3000);
    miss(5000);
    losses.stall("hel", "a", 5500);
    health.reassess(hel, 5500);
    miss(7000);
    verify(media, never()).evacuate("hel");
    miss(9000);
    verify(nodes).down("hel", true);
    verify(media).evacuate("hel");
  }

  @Test
  void oneOfTwo_inACallForTwoOnePersonsTroubleMovesNothingWhileBothMoveTheRoom() {
    when(media.onNode("hel")).thenReturn(people(Set.of("b"), Set.of("a")));
    answer(0);
    miss(3000);
    miss(5000);
    losses.stall("hel", "a", 5200);
    health.reassess(hel, 5200);
    miss(7000);
    miss(9000);
    losses.lost("hel", "a", 9400);
    health.reassess(hel, 9400);
    miss(11000);
    miss(13000);
    verify(nodes, never()).down("hel", true);
    // Узел снова отвечает, а «a» так и не вернулся: вдвоём правила C нет.
    for (long at = 15000; at <= 30000; at += 2000) answer(at);
    verify(media, never()).evacuate("hel");
    // «a» вернулся; потом узел умер по-настоящему: промахи и жалобы обоих — переезд.
    losses.restored("a");
    when(media.onNode("hel")).thenReturn(people(Set.of("a", "b"), Set.of()));
    miss(63000);
    miss(65000);
    losses.stall("hel", "a", 65500);
    health.reassess(hel, 65500);
    verify(nodes, never()).down("hel", true);
    losses.stall("hel", "b", 66000);
    health.reassess(hel, 66000);
    verify(nodes).down("hel", true);
    verify(media).evacuate("hel");
  }

  @Test
  void twoOfThree_ruleAMovesTheRoomsWhenTwoOfThreeComplainDuringTheMisses() {
    when(media.onNode("hel")).thenReturn(people(Set.of("a", "b", "c"), Set.of()));
    answer(0);
    miss(3000);
    miss(5000);
    losses.stall("hel", "a", 5200);
    health.reassess(hel, 5200);
    verify(media, never()).evacuate("hel");
    losses.stall("hel", "b", 6100);
    health.reassess(hel, 6100);
    verify(nodes).down("hel", true);
    verify(media).evacuate("hel");
  }

  @Test
  void twoOfThree_ruleCMovesTheRoomsWhenTwoOfThreeAreStuckReconnecting() {
    when(media.onNode("hel")).thenReturn(people(Set.of("c"), Set.of("a", "b")));
    answer(0);
    losses.stall("hel", "a", 1000);
    losses.lost("hel", "a", 5000);
    losses.lost("hel", "b", 1500);
    for (long at = 2000; at <= 20000; at += 2000) answer(at);
    verify(media, never()).evacuate("hel");
    // «a» в беде с подсказки в 1 с (переподключение — тот же эпизод), «b» — с 1,5 с.
    answer(21500);
    verify(nodes).down("hel", true);
    verify(media).evacuate("hel");
  }

  @Test
  void ruleCCountsOnlyPeopleReconnectingNotMarksOfPeopleBackOnline() {
    // Трое вернулись на связь, а их media.restored потерялся (клиент шлёт его без повторов):
    // отметки висят, но люди CONNECTED — это не «в беде».
    when(media.onNode("hel")).thenReturn(people(Set.of("a", "b", "c"), Set.of()));
    answer(0);
    losses.lost("hel", "a", 1000);
    losses.lost("hel", "b", 1000);
    losses.lost("hel", "c", 1000);
    for (long at = 2000; at <= 60000; at += 2000) answer(at);
    verify(nodes, never()).down("hel", true);
    verify(media, never()).evacuate("hel");
  }

  @Test
  void aForgedStallIsForgottenAndNeverAddsUpToTwoComplainers() {
    // Участник шлёт media.stall и никогда — media.restored.
    when(media.onNode("hel")).thenReturn(four);
    answer(0);
    losses.stall("hel", "a", 1000);
    for (long at = 2000; at <= 30000; at += 2000) answer(at);
    // Магистраль замолчала надолго, а «a» шлёт подсказку снова и снова — это всё равно один
    // жалобщик.
    for (long at = 33000; at <= 61000; at += 2000) {
      miss(at);
      losses.stall("hel", "a", at + 100);
      health.reassess(hel, at + 100);
    }
    // Настоящая жалоба второго — когда последняя подсказка «a» уже отжила (10 с): снова один.
    for (long at = 63000; at <= 73000; at += 2000) miss(at);
    losses.stall("hel", "b", 72000);
    health.reassess(hel, 72000);
    verify(nodes, never()).down("hel", true);
    verify(media, never()).evacuate("hel");
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
