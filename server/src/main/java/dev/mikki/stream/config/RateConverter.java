package dev.mikki.stream.config;

import org.springframework.boot.context.properties.ConfigurationPropertiesBinding;
import org.springframework.core.convert.converter.Converter;
import org.springframework.stereotype.Component;

/** Пускает {@link Rate} в разбор настроек: {@code 10 per hour} становится пределом. */
@Component
@ConfigurationPropertiesBinding
public class RateConverter implements Converter<String, Rate> {
  @Override
  public Rate convert(String source) {
    return Rate.parse(source);
  }
}
