package dev.mikki.stream.activity;

import jakarta.validation.constraints.NotNull;
import java.time.Duration;
import java.time.ZoneId;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

/**
 * Аналитика продукта (R210, {@code stream.analytics}; {@code docs/architecture/admin-analytics.md}
 * §2).
 *
 * @param enabled писать ли события; выключено — отчёт отвечает тем, что уже записано
 * @param zone пояс дней аналитики: «сегодня» пульта — день владельца, а не UTC
 * @param retention сколько живёт посетитель после последнего появления и строка дня после своего
 *     дня (Р-121); словами, как все сроки ядра
 */
@Validated
@ConfigurationProperties("stream.analytics")
public record AnalyticsProperties(
    @DefaultValue("true") boolean enabled,
    @DefaultValue("Europe/Moscow") @NotNull ZoneId zone,
    @DefaultValue("365 days") @NotNull Duration retention) {}
