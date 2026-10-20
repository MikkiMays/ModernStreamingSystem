package dev.mikki.stream.config;

import org.springframework.boot.context.properties.ConfigurationPropertiesBinding;
import org.springframework.core.convert.converter.Converter;
import org.springframework.stereotype.Component;

/** Пускает {@link Allowance} в разбор настроек: {@code 2GB per 1 day} становится квотой. */
@Component
@ConfigurationPropertiesBinding
public class AllowanceConverter implements Converter<String, Allowance> {
  @Override
  public Allowance convert(String source) {
    return Allowance.parse(source);
  }
}
