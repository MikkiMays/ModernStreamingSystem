package dev.mikki.stream.activity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.room.Maintenance;
import java.time.Clock;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Ступень загрузки (R143, Р-37): четверти, steal, «мест нет», гистерезис вниз. */
class LoadMeterTest {
  final AtomicLong now = new AtomicLong(1_000_000);
  final AtomicReference<String> stat = new AtomicReference<>();
  final AtomicReference<String> net = new AtomicReference<>();
  final ActivityReport report = mock(ActivityReport.class);
  final StreamProperties config = mock(StreamProperties.class);
  final Maintenance maintenance = mock(Maintenance.class);
  long user, idle, steal, sent;
  int rooms, connected;
  LoadMeter meter;

  @BeforeEach
  void setUp() {
    var clock = mock(Clock.class);
    when(clock.millis()).thenAnswer(_ -> now.get());
    when(config.maxRooms()).thenReturn(8);
    when(config.admissionOpen()).thenReturn(true);
    when(report.now())
        .thenAnswer(
            _ -> new ActivityReport.Now(now.get(), rooms, 0, connected, connected, 0, 0, rooms()));
    meter =
        new LoadMeter(
            report,
            config,
            maintenance,
            clock,
            new LoadMeter.Proc() {
              @Override
              public String stat() {
                return "cpu  %d 0 0 %d 0 0 0 %d 0 0\ncpu0 1 2 3 4\n".formatted(user, idle, steal);
              }

              @Override
              public String netDev() {
                return "Inter-|\n face |\n    lo: 999 0 0 0 0 0 0 0 999 0\n  eth0: 10 0 0 0 0 0 0 0 %d 0\n"
                    .formatted(sent);
              }
            },
            1000);
  }

  /**
   * Пять секунд: процессор занят на долю {@code busy}, steal — {@code stolen}, отдано {@code mbps}.
   */
  LoadMeter.Load after(double busy, double stolen, double mbps) {
    now.addAndGet(5_000);
    user += Math.round(1000 * (busy - stolen));
    steal += Math.round(1000 * stolen);
    idle += Math.round(1000 * (1 - busy));
    sent += Math.round(mbps * 1_000_000 / 8 * 5);
    return meter.sample();
  }

  /** Занятые встречи (с человеком на связи) и одна пустая сохранённая — она сервер не занимает. */
  List<ActivityReport.LiveRoom> rooms() {
    var list = new java.util.ArrayList<ActivityReport.LiveRoom>();
    for (int i = 0; i < rooms; i++)
      list.add(
          new ActivityReport.LiveRoom(
              "r" + i, "000000000", 0, null, null, 1, 1, 0, 0, 0, List.of(), false, false));
    list.add(
        new ActivityReport.LiveRoom(
            "idle", "000000001", 0, null, null, 0, 0, 0, 0, 0, List.of(), false, false));
    return list;
  }

  @Test
  void quarterStepsTakeTheBusiestShare() {
    after(0.1, 0, 10);
    assertThat(after(0.1, 0, 10))
        .extracting(LoadMeter.Load::level, LoadMeter.Load::state)
        .containsExactly(1, "ok");
    assertThat(LoadMeter.step(0.24)).isEqualTo(1);
    assertThat(LoadMeter.step(0.25)).isEqualTo(2);
    assertThat(LoadMeter.step(0.6)).isEqualTo(3);
    assertThat(LoadMeter.step(0.9)).isEqualTo(4);
    rooms = 4;
    assertThat(after(0.1, 0, 10).level()).isEqualTo(3);
  }

  @Test
  void stealAboveAQuarterIsAtLeastThreeAndUplinkCounts() {
    after(0.3, 0.3, 10);
    assertThat(after(0.3, 0.3, 10).level()).isGreaterThanOrEqualTo(3);
    var fresh = new LoadMeterTest();
    fresh.setUp();
    fresh.after(0.05, 0, 800);
    assertThat(fresh.after(0.05, 0, 800).level()).isEqualTo(4);
  }

  @Test
  void fullMaintenanceAndClosedAreStates() {
    rooms = 8;
    assertThat(after(0, 0, 0))
        .extracting(LoadMeter.Load::level, LoadMeter.Load::state)
        .containsExactly(4, "full");
    rooms = 0;
    when(maintenance.on()).thenReturn(true);
    assertThat(after(0, 0, 0).state()).isEqualTo("maintenance");
    when(maintenance.on()).thenReturn(false);
    when(config.admissionOpen()).thenReturn(false);
    assertThat(after(0, 0, 0).state()).isEqualTo("closed");
  }

  @Test
  void goesUpAtOnceAndDownOnlyAfterThirtySeconds() {
    rooms = 7;
    assertThat(after(0, 0, 0).level()).isEqualTo(4);
    rooms = 0;
    for (int i = 0; i < 6; i++) assertThat(after(0, 0, 0).level()).isEqualTo(4);
    assertThat(after(0, 0, 0).level()).isEqualTo(1);
  }

  @Test
  void procParsingSkipsLoopback() {
    assertThat(LoadMeter.cpuFields("cpu  1 2 3 4 5 6 7 8 9 10\n"))
        .containsExactly(1, 2, 3, 4, 5, 6, 7, 8);
    assertThat(
            LoadMeter.transmitted(
                "  lo: 1 0 0 0 0 0 0 0 500 0\n eth0: 1 0 0 0 0 0 0 0 42 0\n docker0: 1 0 0 0 0 0 0 0 7 0\n"
                    + " veth1a: 1 0 0 0 0 0 0 0 9 0\n br-3f: 1 0 0 0 0 0 0 0 11 0\n"))
        .isEqualTo(42);
    assertThat(List.of()).isEmpty();
  }
}
