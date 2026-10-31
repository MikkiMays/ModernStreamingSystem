package dev.mikki.stream.activity;

import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.room.Maintenance;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Насколько сервер занят — ступенью 1–4 для палочек рядом с пингом (R143, Р-37).
 *
 * <p>Наружу уходит только ступень и состояние: число идущих встреч и людей — сведения об
 * использовании, они остаются за паролем владельца ({@code /activity/now}). Человеку, который
 * выбирает сервер, хватает «свободно — средне — тесно — мест нет».
 *
 * <p>Ступень — наибольшая из четырёх долей, потому что звонок портит любое узкое место, а не их
 * среднее: занятые встречи к {@code max-rooms}, люди на связи к обычной встрече из пяти-шести
 * человек на каждое место, ЦП хоста вместе со steal провайдера (на этой машине он и есть «звонок
 * дёргается») и отдача канала к {@code stream.uplink-mbps}. Пороги — четверти; steal выше четверти
 * поднимает ступень не ниже третьей. Ядро в {@code network_mode: host} — {@code /proc} у него
 * хостовый.
 *
 * <p>Вверх ступень идёт сразу, вниз — только простояв ниже порога 30 с: иначе палочки мигали бы на
 * каждом всплеске.
 */
@Component
public class LoadMeter {
  /** Ответ {@code GET /api/v1/load}. {@code state}: ok, busy, full, maintenance, closed. */
  public record Load(int level, String state, long updatedAt) {}

  /** Источник {@code /proc} — в тестах подставной. */
  public interface Proc {
    String stat() throws IOException;

    String netDev() throws IOException;

    static Proc host() {
      return new Proc() {
        @Override
        public String stat() throws IOException {
          return Files.readString(Path.of("/proc/stat"));
        }

        @Override
        public String netDev() throws IOException {
          return Files.readString(Path.of("/proc/net/dev"));
        }
      };
    }
  }

  /** Сколько людей на связи считается «полной» встречей при расчёте доли людей. */
  static final int PEOPLE_PER_ROOM = 6;

  static final long DOWN_AFTER_MS = 30_000;
  private static final double EWMA = 0.35;

  private final ActivityReport report;
  private final StreamProperties config;
  private final Maintenance maintenance;
  private final Clock clock;
  private final Proc proc;
  private final double uplinkMbps;

  private long[] lastCpu;
  private long lastTx = -1;
  private long lastAt;
  private double cpu;
  private double steal;
  private double tx;
  private int level = 1;
  private long lowerSince = -1;
  private volatile Load current = new Load(1, "ok", 0);

  @Autowired
  public LoadMeter(
      ActivityReport report,
      StreamProperties config,
      Maintenance maintenance,
      Clock clock,
      @Value("${stream.uplink-mbps:1000}") double uplinkMbps,
      MeterRegistry registry) {
    this(report, config, maintenance, clock, Proc.host(), uplinkMbps);
    // Та же ступень — в «Cord — сервер»: что видели люди рядом с пингом, видно и владельцу.
    Gauge.builder("cord.server.load.level", this, meter -> meter.current.level())
        .description("Загрузка сервера ступенью 1–4, как её видят люди рядом с пингом (R143)")
        .register(registry);
  }

  LoadMeter(
      ActivityReport report,
      StreamProperties config,
      Maintenance maintenance,
      Clock clock,
      Proc proc,
      double uplinkMbps) {
    this.report = report;
    this.config = config;
    this.maintenance = maintenance;
    this.clock = clock;
    this.proc = proc;
    this.uplinkMbps = Math.max(1, uplinkMbps);
  }

  /** Последняя ступень; если замер давно не обновлялся (планировщик выключен) — замерить сейчас. */
  public Load current() {
    var load = current;
    if (clock.millis() - load.updatedAt() > 15_000) return sample();
    return load;
  }

  @Scheduled(fixedDelay = 5_000)
  public void tick() {
    sample();
  }

  synchronized Load sample() {
    var now = clock.millis();
    readCpu();
    readNetwork(now);
    var snapshot = report.now();
    var rooms = snapshot.rooms().size();
    var maxRooms = Math.max(1, config.maxRooms());
    var share =
        Math.max(
            Math.max(
                (double) rooms / maxRooms,
                (double) snapshot.connected() / (maxRooms * PEOPLE_PER_ROOM)),
            Math.max(cpu, tx / uplinkMbps));
    var wanted = step(share);
    if (steal > 0.25) wanted = Math.max(wanted, 3);
    var full = rooms >= maxRooms;
    if (full) wanted = 4;
    if (wanted >= level) {
      level = wanted;
      lowerSince = -1;
    } else if (lowerSince < 0) lowerSince = now;
    else if (now - lowerSince >= DOWN_AFTER_MS) {
      level = wanted;
      lowerSince = -1;
    }
    String state;
    if (maintenance.on()) state = "maintenance";
    else if (!config.admissionOpen()) state = "closed";
    else if (full) state = "full";
    else if (level >= 3) state = "busy";
    else state = "ok";
    current = new Load(level, state, now);
    return current;
  }

  /** Доля 0…1 → ступень 1…4 по четвертям. */
  static int step(double share) {
    if (share < 0.25) return 1;
    if (share < 0.5) return 2;
    if (share < 0.75) return 3;
    return 4;
  }

  private void readCpu() {
    long[] fields;
    try {
      fields = cpuFields(proc.stat());
    } catch (IOException | RuntimeException e) {
      return;
    }
    if (fields == null) return;
    if (lastCpu != null) {
      long total = 0, previous = 0;
      for (int i = 0; i < Math.min(8, fields.length); i++) {
        total += fields[i];
        previous += lastCpu[i];
      }
      var spent = total - previous;
      if (spent > 0) {
        // idle и iowait — простой; всё остальное, включая steal, — занято.
        var idle = (fields[3] + fields[4]) - (lastCpu[3] + lastCpu[4]);
        var stolen = fields.length > 7 ? fields[7] - lastCpu[7] : 0;
        cpu = smooth(cpu, Math.max(0, Math.min(1, 1 - (double) idle / spent)));
        steal = smooth(steal, Math.max(0, Math.min(1, (double) stolen / spent)));
      }
    }
    lastCpu = fields;
  }

  private void readNetwork(long now) {
    long sent;
    try {
      sent = transmitted(proc.netDev());
    } catch (IOException | RuntimeException e) {
      return;
    }
    if (lastTx >= 0 && now > lastAt && sent >= lastTx) {
      var mbps = (sent - lastTx) * 8.0 / 1_000_000 / ((now - lastAt) / 1000.0);
      tx = smooth(tx, mbps);
    }
    lastTx = sent;
    lastAt = now;
  }

  private static double smooth(double previous, double value) {
    return previous == 0 ? value : previous + EWMA * (value - previous);
  }

  /** Строка {@code cpu} из {@code /proc/stat}: user nice system idle iowait irq softirq steal. */
  static long[] cpuFields(String stat) {
    for (var line : stat.split("\n")) {
      if (!line.startsWith("cpu ")) continue;
      var parts = line.trim().split("\\s+");
      var fields = new long[Math.min(8, parts.length - 1)];
      for (int i = 0; i < fields.length; i++) fields[i] = Long.parseLong(parts[i + 1]);
      return fields.length >= 5 ? fields : null;
    }
    return null;
  }

  /** Отдано настоящими интерфейсами (без петли и мостов Docker), байт с загрузки. */
  static long transmitted(String netDev) {
    long sum = 0;
    for (var line : netDev.split("\n")) {
      var colon = line.indexOf(':');
      if (colon < 0) continue;
      var name = line.substring(0, colon).trim();
      // Мосты и пары Docker — тот же трафик ещё раз: считаем только настоящие интерфейсы.
      if (name.equals("lo")
          || name.startsWith("docker")
          || name.startsWith("veth")
          || name.startsWith("br-")) continue;
      var parts = line.substring(colon + 1).trim().split("\\s+");
      if (parts.length > 8) sum += Long.parseLong(parts[8]);
    }
    return sum;
  }
}
