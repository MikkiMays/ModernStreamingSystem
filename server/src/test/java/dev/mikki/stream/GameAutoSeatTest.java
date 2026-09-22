package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;

import dev.mikki.stream.game.Durak;
import dev.mikki.stream.game.Table;
import dev.mikki.stream.shared.Problem;
import org.junit.jupiter.api.Test;

class GameAutoSeatTest {
  @Test
  void pokerAutoSeatsFillFreeSlotsAndPreserveExplicitSeatErrors() {
    var table = Table.open("host", "friendly", 1000L);
    table.sit("explicit", "Explicit", 3, 1000L);
    table.sit("first", "First", null, 1000L);
    table.sit("second", "Second", null, 1000L);
    assertThat(table.seats.get(0).memberId).isEqualTo("first");
    assertThat(table.seats.get(1).memberId).isEqualTo("second");
    assertThat(table.seats.get(3).memberId).isEqualTo("explicit");
    assertThatThrownBy(() -> table.sit("occupied", "Occupied", 3, 1000L))
        .isInstanceOfSatisfying(Problem.class, e -> assertThat(e.code()).isEqualTo("POKER_TAKEN"));
    for (int invalid : new int[] {-1, Table.SEATS})
      assertThatThrownBy(() -> table.sit("invalid", "Invalid", invalid, 1000L))
          .isInstanceOfSatisfying(Problem.class, e -> assertThat(e.code()).isEqualTo("POKER_SEAT"));
    for (int i = 3; i < Table.SEATS; i++) table.sit("fill" + i, "Fill", null, 1000L);
    assertThatThrownBy(() -> table.sit("full", "Full", null, 1000L))
        .isInstanceOfSatisfying(Problem.class, e -> assertThat(e.code()).isEqualTo("POKER_FULL"));
    assertThat(table.seats).allSatisfy(seat -> assertThat(seat.memberId).isNotNull());
  }

  @Test
  void durakAutoSeatsFillFreeSlotsAndPreserveExplicitSeatErrors() {
    var table = Durak.open("host", "podkidnoy", 1000L, 36);
    table.sit("explicit", "Explicit", 3, 1000L);
    table.sit("first", "First", null, 1000L);
    table.sit("second", "Second", null, 1000L);
    assertThat(table.seats.get(0).memberId).isEqualTo("first");
    assertThat(table.seats.get(1).memberId).isEqualTo("second");
    assertThat(table.seats.get(3).memberId).isEqualTo("explicit");
    assertThatThrownBy(() -> table.sit("occupied", "Occupied", 3, 1000L))
        .isInstanceOfSatisfying(Problem.class, e -> assertThat(e.code()).isEqualTo("DURAK_TAKEN"));
    for (int invalid : new int[] {-1, Durak.SEATS})
      assertThatThrownBy(() -> table.sit("invalid", "Invalid", invalid, 1000L))
          .isInstanceOfSatisfying(Problem.class, e -> assertThat(e.code()).isEqualTo("DURAK_SEAT"));
    for (int i = 3; i < Durak.SEATS; i++) table.sit("fill" + i, "Fill", null, 1000L);
    assertThatThrownBy(() -> table.sit("full", "Full", null, 1000L))
        .isInstanceOfSatisfying(Problem.class, e -> assertThat(e.code()).isEqualTo("DURAK_FULL"));
    assertThat(table.seats).allSatisfy(seat -> assertThat(seat.memberId).isNotNull());
  }
}
