package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;

import dev.mikki.stream.nodes.LossReports;
import java.util.ArrayList;
import java.util.Set;
import org.junit.jupiter.api.Test;

class LossReportsTest {
  final LossReports losses = new LossReports();
  final Set<String> people = Set.of("a", "b", "c");

  int all(String node, long now) {
    return losses.since(node, people, Long.MIN_VALUE, now);
  }

  @Test
  void theFirstComplaintSetsTheStartAndRepeatsOnlyMoveTheLatestComplaint() {
    losses.lost("hel", "a", 1000);
    losses.lost("hel", "a", 9000);
    assertThat(all("hel", 9000)).isEqualTo(1);
    // Правило C — от начала беды.
    assertThat(losses.stuck("hel", people, 8000, 9000)).isEqualTo(1);
    assertThat(losses.stuck("hel", people, 8001, 9000)).isEqualTo(0);
    // Правило A — по последней жалобе.
    assertThat(losses.since("hel", people, 9000, 9000)).isEqualTo(1);
    assertThat(losses.since("hel", people, 9001, 9000)).isEqualTo(0);
  }

  @Test
  void aStallLivesTenSecondsUnlessTheSdkStartsReconnectingAndThenTheEpisodeKeepsItsStart() {
    // Подсказка без продолжения отживает за 10 с, повтор её не продлевает.
    losses.stall("hel", "a", 1000);
    losses.stall("hel", "a", 9000);
    assertThat(all("hel", 11_000)).isEqualTo(1);
    assertThat(all("hel", 11_001)).isEqualTo(0);
    // Переподключение SDK через 4 с после подсказки — тот же эпизод: беда с подсказки.
    losses.stall("hel", "b", 20_000);
    losses.lost("hel", "b", 24_000);
    assertThat(losses.stuck("hel", people, 20_000, 40_000)).isEqualTo(1);
    assertThat(all("hel", 100_000)).isEqualTo(1);
    // Подсказка отжила, потом потеря — новый эпизод с потери, а не с забытой подсказки.
    losses.stall("hel", "c", 30_000);
    losses.lost("hel", "c", 45_000);
    assertThat(losses.since("hel", Set.of("c"), 45_000, 46_000)).isEqualTo(1);
    assertThat(losses.stuck("hel", Set.of("c"), 1_001, 46_000)).isEqualTo(0);
  }

  @Test
  void restoredClearsTheMarkWhereverItWasAndANewNodeStartsAfresh() {
    losses.lost("hel", "a", 1000);
    losses.lost("hel", "b", 1000);
    losses.restored("a");
    assertThat(all("hel", 2000)).isEqualTo(1);
    // Комната переехала: жалоба на новом узле снимает старую.
    losses.lost("fra", "b", 3000);
    assertThat(losses.reported("hel")).isEqualTo(0);
    assertThat(all("fra", 3000)).isEqualTo(1);
    losses.clear("fra");
    assertThat(losses.reported("fra")).isEqualTo(0);
  }

  @Test
  void onlyPeopleStillOnTheNodeCountAndStaleMarksAreForgotten() {
    losses.lost("hel", "a", 1000);
    losses.lost("hel", "gone", 1000);
    assertThat(all("hel", 2000)).isEqualTo(1);
    assertThat(losses.since("hel", null, Long.MIN_VALUE, 2000)).isEqualTo(2);
    assertThat(losses.since("hel", Set.of(), Long.MIN_VALUE, 2000)).isEqualTo(0);
    assertThat(all("hel", 1000 + 121_000)).isEqualTo(0);
    assertThat(losses.since("hel", null, Long.MIN_VALUE, 1000 + 121_000)).isEqualTo(0);
    assertThat(losses.reported("hel")).isEqualTo(0);
  }

  @Test
  void listenersHearEveryComplaintWithItsNode() {
    var heard = new ArrayList<String>();
    losses.subscribe(heard::add);
    losses.lost("hel", "a", 1000);
    losses.stall("hel", "a", 1500);
    losses.lost("fra", "b", 2000);
    losses.lost(null, "x", 1);
    assertThat(heard).containsExactly("hel", "hel", "fra");
  }
}
