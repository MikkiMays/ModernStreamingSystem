package dev.mikki.stream.support;

import dev.mikki.stream.config.Rate;
import jakarta.validation.constraints.NotNull;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Обращения в поддержку (E13, T36) — {@code stream.support} в {@code application.yml}.
 *
 * <p>Своя запись, а не поле {@code StreamProperties}: настройки поддержки читает только эта часть
 * ядра, а общую запись правят параллельно несколько эпиков.
 *
 * <p>{@code notifyTelegramChat} — куда бот доносит обращения (чат владельца Cord). Пусто —
 * обращения копятся в базе и видны на странице «Активность», в Telegram не уходят. {@code perIp} —
 * сколько обращений принимается с одного адреса, {@code perServer} — со всех вместе: поток формы не
 * должен засыпать владельцу Telegram. {@code retention} — сколько хранится обращение: в нём может
 * быть контакт человека.
 */
@Validated
@ConfigurationProperties("stream.support")
public record SupportProperties(
    boolean enabled,
    String notifyTelegramChat,
    @NotNull Rate perIp,
    @NotNull Rate perServer,
    @NotNull Duration retention,
    Sla sla,
    Duration autoArchive) {
  /** Сроки SLA (R215): первая реакция и решение; пусто — умолчания. */
  public record Sla(Duration firstResponse, Duration resolve) {}

  public Sla slaOrDefault() {
    return sla == null
        ? new Sla(Duration.ofHours(4), Duration.ofHours(48))
        : new Sla(
            sla.firstResponse() == null ? Duration.ofHours(4) : sla.firstResponse(),
            sla.resolve() == null ? Duration.ofHours(48) : sla.resolve());
  }

  /** Решённое уходит в архив через две недели, если не задано иное. */
  public Duration autoArchiveOrDefault() {
    return autoArchive == null ? Duration.ofDays(14) : autoArchive;
  }

  /** Чат владельца, если задан. */
  public String chat() {
    return notifyTelegramChat == null ? "" : notifyTelegramChat.trim();
  }
}
