package dev.mikki.stream.media;

/**
 * Чтение ЦП и отдачи канала узла из текста node-exporter (R200, {@code server-selection.md} §3.4).
 *
 * <p>На каждом узле уже стоит node-exporter ({@code compose.node.yaml}), и его порт 9100 отдаётся
 * узлу управления магистралью ({@code backbone-config.mjs}: {@code NODE_SERVICES.node}). Ядро
 * читает {@code /metrics?collect[]=cpu&collect[]=netdev} раз в опрос и считает по разности двух
 * снимков то же, что {@code activity.LoadMeter} считает по {@code /proc} своей машины: занятость ЦП
 * вместе со steal, сам steal и мегабиты в секунду на отдачу настоящими интерфейсами. Так ядро не
 * зависит ни от мониторинга, ни от нового образа на узле.
 */
public final class NodeExporter {
  private NodeExporter() {}

  /** Снимок счётчиков: секунды ЦП по всем ядрам и байты отдачи. */
  public record Sample(double total, double idle, double steal, double txBytes, long at) {
    /**
     * Доли за промежуток между снимками; {@code null} — промежутка нет (первый снимок или сброс).
     */
    public Shares since(Sample previous) {
      if (previous == null || at <= previous.at) return null;
      var spent = total - previous.total;
      if (spent <= 0) return null;
      var idleShare = Math.max(0, Math.min(1, (idle - previous.idle) / spent));
      var stealShare = Math.max(0, Math.min(1, (steal - previous.steal) / spent));
      var bytes = txBytes - previous.txBytes;
      var mbps = bytes < 0 ? Double.NaN : bytes * 8.0 / 1_000_000 / ((at - previous.at) / 1000.0);
      return new Shares(1 - idleShare, stealShare, mbps);
    }
  }

  /** ЦП (с steal) и steal — доли 0…1; отдача — Мбит/с ({@code NaN} — счётчик сбросился). */
  public record Shares(double cpu, double steal, double mbps) {}

  /**
   * Разобрать текст метрик. Нужны только {@code node_cpu_seconds_total{cpu,mode}} и {@code
   * node_network_transmit_bytes_total{device}}; остальное пропускается. Нет ни одной строки ЦП —
   * {@code null}: это не node-exporter.
   */
  public static Sample parse(String text, long at) {
    double total = 0, idle = 0, steal = 0, tx = 0;
    var sawCpu = false;
    for (var line : text.split("\n")) {
      if (line.isEmpty() || line.charAt(0) == '#') continue;
      if (line.startsWith("node_cpu_seconds_total{")) {
        var value = value(line);
        if (Double.isNaN(value)) continue;
        sawCpu = true;
        total += value;
        var mode = label(line, "mode");
        if ("idle".equals(mode) || "iowait".equals(mode)) idle += value;
        else if ("steal".equals(mode)) steal += value;
      } else if (line.startsWith("node_network_transmit_bytes_total{")) {
        var device = label(line, "device");
        // Мосты и пары Docker — тот же трафик ещё раз: считаем только настоящие интерфейсы.
        if (device == null
            || device.equals("lo")
            || device.startsWith("docker")
            || device.startsWith("veth")
            || device.startsWith("br-")) continue;
        var value = value(line);
        if (!Double.isNaN(value)) tx += value;
      }
    }
    return sawCpu ? new Sample(total, idle, steal, tx, at) : null;
  }

  private static String label(String line, String name) {
    var key = name + "=\"";
    var start = line.indexOf(key);
    if (start < 0) return null;
    start += key.length();
    var end = line.indexOf('"', start);
    return end < 0 ? null : line.substring(start, end);
  }

  private static double value(String line) {
    var close = line.lastIndexOf('}');
    if (close < 0) return Double.NaN;
    var rest = line.substring(close + 1).trim();
    var space = rest.indexOf(' ');
    if (space >= 0) rest = rest.substring(0, space);
    try {
      return Double.parseDouble(rest);
    } catch (NumberFormatException e) {
      return Double.NaN;
    }
  }
}
