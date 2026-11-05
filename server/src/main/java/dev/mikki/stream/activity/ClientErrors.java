package dev.mikki.stream.activity;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.io.IOException;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Ошибки, которые видели люди ({@code POST /api/v1/client-errors}, R180, Р-80): браузер считает,
 * где и какую ошибку он показал человеку ({@code web/src/core/failure.ts}), и присылает сводку раз
 * в 30 с и при уходе со страницы. Сводка ложится только в счётчик {@code
 * cord_client_errors_total{place,code}} — на дашборде видно, где людям чаще всего не везёт и
 * почему.
 *
 * <p>ПРИВАТНОСТЬ (П8). В сводке — место интерфейса, код и число раз; ни текста ошибки, ни адреса,
 * ни встречи, ни участника. Текст и подробности остаются в журнале браузера и — если человек сам
 * приложит диагностику к обращению — в «Недавних ошибках».
 *
 * <p>ЧИСЛО РЯДОВ. Место — из {@link #PLACES}, код — из реестра ошибок ядра и служб ({@code
 * contracts/errors.json}, сборка кладёт его в jar) или вид ошибки из {@link #KINDS}; всё прочее —
 * {@code other}. Какую бы сводку ни прислали, рядов не больше, чем мест на коды.
 */
@Component
public class ClientErrors {
  private static final Logger log = LoggerFactory.getLogger(ClientErrors.class);

  /** Места интерфейса — как их зовёт клиент ({@code core/failure.ts}: {@code PLACES}). */
  public static final Set<String> PLACES =
      Set.of(
          "app",
          "connect",
          "join",
          "meeting",
          "call",
          "camera",
          "microphone",
          "screen",
          "speaker",
          "chat",
          "files",
          "board",
          "cinema",
          "music",
          "games",
          "favorites",
          "recent",
          "invite",
          "profile",
          "settings",
          "support",
          "telegram",
          "activity");

  /**
   * Виды ошибок без кода реестра ({@code core/failure.ts}: {@code KINDS}). Виды {@code camera-*} и
   * {@code background-*} — самолечение камеры (R189, И7): человек их не видит, счётчик — видит.
   */
  public static final Set<String> KINDS =
      Set.of(
          "offline",
          "timeout",
          "server",
          "refused",
          "denied",
          "no-device",
          "device-busy",
          "unsupported",
          "call",
          "aborted",
          "bug",
          "other",
          "camera-ended",
          "camera-muted",
          "camera-silenced",
          "camera-missing",
          "camera-stalled",
          "camera-healed",
          "camera-heal-failed",
          "camera-denied",
          "background-stalled",
          "background-dropped");

  /** Разных пар «место — код» в одной сводке — столько же держит клиент. */
  public static final int MAX_ENTRIES = 60;

  public record ErrorCount(
      @NotNull @Size(min = 1, max = 32) String place,
      @NotNull @Size(min = 1, max = 64) String code,
      @Min(1) @Max(1000) int count) {}

  public record ErrorSummary(
      @NotNull @Size(max = MAX_ENTRIES) List<@Valid @NotNull ErrorCount> errors) {}

  private final MeterRegistry registry;
  private final Set<String> codes;

  @Autowired
  public ClientErrors(MeterRegistry registry) {
    this(registry, registryCodes());
  }

  public ClientErrors(MeterRegistry registry, Set<String> codes) {
    this.registry = registry;
    this.codes = Set.copyOf(codes);
  }

  public void record(ErrorSummary batch) {
    for (var entry : batch.errors()) {
      var place = PLACES.contains(entry.place()) ? entry.place() : "other";
      var code =
          KINDS.contains(entry.code()) || codes.contains(entry.code()) ? entry.code() : "other";
      Counter.builder("cord.client.errors")
          .description("Ошибки, которые видели люди, по месту интерфейса и коду")
          .tag("place", place)
          .tag("code", code)
          .register(registry)
          .increment(entry.count());
    }
  }

  /**
   * Коды реестра из jar; реестра нет (сборка без {@code contracts/}) — все коды станут {@code
   * other}.
   */
  static Set<String> registryCodes() {
    try (var input = ClientErrors.class.getResourceAsStream("/contracts/errors.json")) {
      if (input == null) {
        log.warn("Реестра кодов ошибок в сборке нет: коды ошибок клиента считаются как other");
        return Set.of();
      }
      var names = new HashSet<String>();
      new ObjectMapper().readTree(input).fieldNames().forEachRemaining(names::add);
      return names;
    } catch (IOException e) {
      log.warn("Реестр кодов ошибок не прочитан: коды ошибок клиента считаются как other", e);
      return Set.of();
    }
  }
}
