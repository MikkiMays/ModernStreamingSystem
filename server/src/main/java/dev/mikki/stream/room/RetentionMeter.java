package dev.mikki.stream.room;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Component;

/**
 * Сколько ушло по сроку и сколько лежит самое старое (Р-134, {@code
 * docs/architecture/data-retention.md} §4).
 *
 * <ul>
 *   <li>{@code cord_retention_deleted_total{kind}} — сколько записей, файлов и элементов ушло по
 *       сроку с запуска ядра: {@code message}, {@code room_event}, {@code attachment}, {@code
 *       board_element}, {@code board_file}, {@code watch}, {@code game_summary}, {@code avatar},
 *       {@code support_text}, {@code participant}, {@code audit}, …
 *   <li>{@code cord_retention_oldest_content_seconds{kind}} — сколько лет самому старому
 *       содержимому каждого вида после последней почасовой очистки; больше 25 ч — очистка не
 *       справилась (оповещение {@code CordContentRetention}).
 *   <li>{@code cord_retention_last_sweep_timestamp_seconds} — когда очистка прошла последний раз.
 * </ul>
 *
 * <p>Метки — только вид (П8): ни встречи, ни человека.
 */
@Component
public class RetentionMeter {
  /** Виды содержимого, у которых меряется возраст самого старого. */
  public static final List<String> CONTENT =
      List.of("message", "attachment", "board_element", "board_file", "support_text");

  private final MeterRegistry registry;
  private final Map<String, Counter> deleted = new ConcurrentHashMap<>();
  private final Map<String, AtomicLong> oldest = new ConcurrentHashMap<>();
  private final AtomicLong lastSweep = new AtomicLong();

  public RetentionMeter(MeterRegistry registry) {
    this.registry = registry;
    for (var kind : CONTENT) {
      var age = new AtomicLong();
      oldest.put(kind, age);
      Gauge.builder("cord.retention.oldest.content", age, AtomicLong::get)
          .description(
              "Возраст самого старого содержимого после очистки, с (Р-134: не больше суток)")
          .baseUnit("seconds")
          .tag("kind", kind)
          .register(registry);
    }
    Gauge.builder("cord.retention.last.sweep.timestamp", lastSweep, AtomicLong::get)
        .description("Когда почасовая очистка содержимого прошла последний раз, с от эпохи")
        .baseUnit("seconds")
        .register(registry);
  }

  /** Ушло по сроку {@code count} записей вида {@code kind}. */
  public void deleted(String kind, long count) {
    if (count <= 0) return;
    deleted
        .computeIfAbsent(
            kind,
            k ->
                Counter.builder("cord.retention.deleted")
                    .description("Удалено по сроку хранения (Р-134)")
                    .tag("kind", k)
                    .register(registry))
        .increment(count);
  }

  /**
   * Самое старое содержимое вида {@code kind} добавлено в {@code since} (мс); {@link
   * Long#MAX_VALUE} — содержимого нет.
   */
  public void oldest(String kind, long since, long now) {
    var age = oldest.get(kind);
    if (age != null) age.set(since == Long.MAX_VALUE ? 0 : Math.max(0, (now - since) / 1000));
  }

  /** Очистка прошла. */
  public void swept(long now) {
    lastSweep.set(now / 1000);
  }

  /** Сколько с запуска ушло вида {@code kind} — для тестов и отчёта. */
  public double deleted(String kind) {
    var counter = deleted.get(kind);
    return counter == null ? 0 : counter.count();
  }

  /** Возраст самого старого вида {@code kind} после последней очистки, с. */
  public long oldest(String kind) {
    var age = oldest.get(kind);
    return age == null ? 0 : age.get();
  }
}
