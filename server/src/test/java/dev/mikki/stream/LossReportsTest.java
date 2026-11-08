package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;

import dev.mikki.stream.nodes.LossReports;
import java.util.ArrayList;
import java.util.Set;
import org.junit.jupiter.api.Test;

class LossReportsTest {
  final LossReports losses = new LossReports();
  final Set<String> people = Set.of("a", "b", "c");

  @Test
  void theFirstComplaintSetsTheClockAndRepeatsDoNotMoveIt() {
    losses.lost("hel", "a", 1000);
    losses.lost("hel", "a", 9000);
    assertThat(losses.lostAmong("hel", people, 9000, 0)).isEqualTo(1);
    assertThat(losses.lostAmong("hel", people, 9000, 8000)).isEqualTo(1);
    assertThat(losses.lostAmong("hel", people, 9000, 8001)).isEqualTo(0);
  }

  @Test
  void restoredClearsTheMarkWhereverItWasAndANewNodeStartsAfresh() {
    losses.lost("hel", "a", 1000);
    losses.lost("hel", "b", 1000);
    losses.restored("a");
    assertThat(losses.lostAmong("hel", people, 2000, 0)).isEqualTo(1);
    // Комната переехала: жалоба на новом узле снимает старую.
    losses.lost("fra", "b", 3000);
    assertThat(losses.reported("hel")).isEqualTo(0);
    assertThat(losses.lostAmong("fra", people, 3000, 0)).isEqualTo(1);
    losses.clear("fra");
    assertThat(losses.reported("fra")).isEqualTo(0);
  }

  @Test
  void onlyPeopleStillOnTheNodeCountAndStaleMarksAreForgotten() {
    losses.lost("hel", "a", 1000);
    losses.lost("hel", "gone", 1000);
    assertThat(losses.lostAmong("hel", people, 2000, 0)).isEqualTo(1);
    assertThat(losses.lostAmong("hel", Set.of(), 2000, 0)).isEqualTo(0);
    assertThat(losses.lostAmong("hel", people, 1000 + 121_000, 0)).isEqualTo(0);
    assertThat(losses.reported("hel")).isEqualTo(0);
  }

  @Test
  void listenersHearEveryComplaintWithItsNode() {
    var heard = new ArrayList<String>();
    losses.subscribe(heard::add);
    losses.lost("hel", "a", 1000);
    losses.lost("hel", "a", 1500);
    losses.lost("fra", "b", 2000);
    losses.lost(null, "x", 1);
    assertThat(heard).containsExactly("hel", "hel", "fra");
  }
}
