package dev.mikki.stream.config;

import org.springframework.boot.context.properties.ConfigurationPropertiesBinding;
import org.springframework.core.convert.converter.Converter;
import org.springframework.stereotype.Component;

/**
 * Пускает {@link Level} в разбор настроек: {@code 1080p60} в {@code application.yml} становится
 * уровнем. Как и {@link TermConverter}, стоит только на разборе конфигурации.
 */
@Component
@ConfigurationPropertiesBinding
public class LevelConverter implements Converter<String, Level> {
  @Override
  public Level convert(String source) {
    return Level.parse(source);
  }
}
