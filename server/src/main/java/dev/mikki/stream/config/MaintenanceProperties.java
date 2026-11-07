package dev.mikki.stream.config;

import jakarta.validation.constraints.NotNull;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

/**
 * Сроки технических работ (R194, {@code stream.maintenance}), словами — как все сроки ядра ({@link
 * Term}).
 *
 * @param grace отсрочка срочных работ по умолчанию: сколько идущие встречи живут после команды
 * @param maxWindow самое долгое окно от его начала; окно без конца закрывается само через этот срок
 * @param overrun сколько окно держится сверх обещанного конца, прежде чем откроет продукт само
 * @param warnBefore за сколько до начала идущим встречам уходит событие {@code maintenance.warning}
 */
@Validated
@ConfigurationProperties("stream.maintenance")
public record MaintenanceProperties(
    @DefaultValue("60 seconds") @NotNull Duration grace,
    @DefaultValue("6 hours") @NotNull Duration maxWindow,
    @DefaultValue("1 hour") @NotNull Duration overrun,
    @DefaultValue("15 minutes") @NotNull Duration warnBefore) {}
