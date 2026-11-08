package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import dev.mikki.stream.media.NodeExporter;
import org.junit.jupiter.api.Test;

class NodeExporterTest {
  static final String FIRST =
      """
      # HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.
      # TYPE node_cpu_seconds_total counter
      node_cpu_seconds_total{cpu="0",mode="idle"} 1000
      node_cpu_seconds_total{cpu="0",mode="iowait"} 10
      node_cpu_seconds_total{cpu="0",mode="steal"} 5
      node_cpu_seconds_total{cpu="0",mode="system"} 100
      node_cpu_seconds_total{cpu="0",mode="user"} 200
      node_cpu_seconds_total{cpu="1",mode="idle"} 1200
      node_cpu_seconds_total{cpu="1",mode="steal"} 5
      node_cpu_seconds_total{cpu="1",mode="user"} 300
      node_network_transmit_bytes_total{device="lo"} 7000000
      node_network_transmit_bytes_total{device="docker0"} 123456
      node_network_transmit_bytes_total{device="veth1a2b"} 123456
      node_network_transmit_bytes_total{device="br-9f8e"} 123456
      node_network_transmit_bytes_total{device="eth0"} 10000000
      node_network_transmit_bytes_total{device="eth1"} 500000
      node_network_receive_bytes_total{device="eth0"} 99999999
      """;

  @Test
  void sharesComeFromTheDifferenceOfTwoSamplesOverRealInterfacesOnly() {
    var first = NodeExporter.parse(FIRST, 1_000);
    assertThat(first).isNotNull();
    assertThat(first.total()).isEqualTo(2820);
    assertThat(first.idle()).isEqualTo(2210);
    assertThat(first.steal()).isEqualTo(10);
    assertThat(first.txBytes()).isEqualTo(10_500_000);
    assertThat(first.since(null)).isNull();

    // За 5 с: 20 с ЦП на двух ядрах, из них 8 простоя и 3 steal → занято 60 %, steal 15 %;
    // отдано 5 МБ → 8 Мбит/с.
    var second =
        NodeExporter.parse(
            FIRST
                .replace("mode=\"idle\"} 1000", "mode=\"idle\"} 1004")
                .replace("mode=\"idle\"} 1200", "mode=\"idle\"} 1204")
                .replace("cpu=\"0\",mode=\"steal\"} 5", "cpu=\"0\",mode=\"steal\"} 8")
                .replace("mode=\"user\"} 200", "mode=\"user\"} 209")
                .replace("device=\"eth0\"} 10000000", "device=\"eth0\"} 15000000"),
            6_000);
    var shares = second.since(first);
    assertThat(shares.cpu()).isCloseTo(0.6, within(1e-9));
    assertThat(shares.steal()).isCloseTo(0.15, within(1e-9));
    assertThat(shares.mbps()).isCloseTo(8.0, within(1e-9));

    // Счётчик сети сбросился (перезапуск) — трафик неизвестен, ЦП по-прежнему считается.
    var reset =
        NodeExporter.parse(
            FIRST
                .replace("mode=\"idle\"} 1000", "mode=\"idle\"} 1030")
                .replace("device=\"eth0\"} 10000000", "device=\"eth0\"} 1"),
            11_000);
    assertThat(reset.since(second).mbps()).isNaN();
    // Тот же или более ранний снимок — долей нет.
    assertThat(second.since(second)).isNull();
  }

  @Test
  void textWithoutCpuCountersIsNotNodeExporter() {
    assertThat(NodeExporter.parse("<html>502</html>", 1)).isNull();
    assertThat(NodeExporter.parse("", 1)).isNull();
    assertThat(NodeExporter.parse("node_network_transmit_bytes_total{device=\"eth0\"} 1", 1))
        .isNull();
    // Строка с мусором вместо числа пропускается, остальное читается.
    var sample =
        NodeExporter.parse(
            "node_cpu_seconds_total{cpu=\"0\",mode=\"idle\"} NaNx\nnode_cpu_seconds_total{cpu=\"0\",mode=\"user\"} 3 1700000000\n",
            1);
    assertThat(sample.total()).isEqualTo(3);
  }
}
