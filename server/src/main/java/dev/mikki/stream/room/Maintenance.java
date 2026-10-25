package dev.mikki.stream.room;

import dev.mikki.stream.shared.Problem;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Clock;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.stereotype.Component;

/**
 * Флаг обслуживания — дренаж перед выкаткой (W1b шаг 5, {@code docs/deployment.md} → «Обновление»).
 *
 * <p>ЗАЧЕМ. Пересборка SFU или ядра обрывает идущие звонки. По образцу Discord (draining: сервер
 * выводится из ротации и ждёт, пока разговоры кончатся сами) выкатка сначала включает этот флаг:
 * ядро перестаёт создавать новые встречи — {@code 503 MAINTENANCE} с {@code Retry-After}, — а те,
 * что идут, доигрывают; вход в идущую встречу открыт — человек, вышедший на минуту, вернётся.
 * {@code backlog/bin/deploy.sh --drain} ждёт, пока {@code active-meetings.sh} станет пуст (до 15
 * минут), и только тогда собирает и перезапускает.
 *
 * <p>Флаг живёт в памяти ядра и включается рычагом владельца ({@code POST
 * /api/v1/admin/maintenance}, пароль {@code ADMIN_PASSWORD}). Перезапуск ядра его сбрасывает — так
 * и задумано: новое ядро поднялось — сервер снова принимает, и забытый флаг не закроет сервер
 * навсегда. Прежний путь ({@code ADMISSION_OPEN=false} в {@code .env} и перезапуск ядра) остаётся
 * для случая, когда нужно закрыть и вход в идущие встречи ({@code DRAINING}).
 */
@Component
public class Maintenance {
  /** Через сколько браузеру предложить повторить: обычная выкатка укладывается в две минуты. */
  public static final int RETRY_AFTER_SECONDS = 120;

  private final AtomicBoolean on = new AtomicBoolean();
  private final Clock clock;
  private volatile long since;

  public Maintenance(MeterRegistry registry, Clock clock) {
    this.clock = clock;
    Gauge.builder("cord.maintenance", on, flag -> flag.get() ? 1 : 0)
        .description("Сервер обновляется: новые встречи не создаются (1) или принимает (0)")
        .register(registry);
  }

  public boolean on() {
    return on.get();
  }

  /** С какого момента включено, мс; {@code 0} — выключено. */
  public long since() {
    return on.get() ? since : 0;
  }

  /** Включить или выключить. {@code true} — состояние изменилось. */
  public boolean set(boolean value) {
    if (value) since = clock.millis();
    return on.getAndSet(value) != value;
  }

  /** Отказ новой встрече на время обслуживания — с подсказкой, через сколько повторить. */
  public Problem refusal() {
    return new Problem(
        503,
        "MAINTENANCE",
        "Сервер обновляется, попробуйте через 2 минуты",
        Map.of("retryAfter", RETRY_AFTER_SECONDS));
  }
}
