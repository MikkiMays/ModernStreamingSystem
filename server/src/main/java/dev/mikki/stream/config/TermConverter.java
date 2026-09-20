package dev.mikki.stream.config;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationPropertiesBinding;
import org.springframework.core.convert.converter.Converter;
import org.springframework.stereotype.Component;

/**
 * Пускает {@link Term} в разбор настроек: {@code 3 months} становится {@link Duration}.
 *
 * <p>Собственных сроков Spring знает два вида — ISO-8601 ({@code PT2H}) и короткий ({@code 7d}); ни
 * месяцев, ни «никогда» среди них нет. Конвертер стоит только на разборе конфигурации ({@link
 * ConfigurationPropertiesBinding}), то есть больше нигде в приложении строки в сроки не
 * превращаются молча.
 */
@Component
@ConfigurationPropertiesBinding
public class TermConverter implements Converter<String, Duration> {
  @Override
  public Duration convert(String source) {
    return Term.parse(source);
  }
}
