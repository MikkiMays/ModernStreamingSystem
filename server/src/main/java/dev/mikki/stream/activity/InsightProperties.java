package dev.mikki.stream.activity;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Служба аналитики {@code insight} (R239, {@code stream.insight}; {@code contracts/insight.md}).
 *
 * @param url адрес службы на петле машины ядра ({@code INSIGHT_URL}, обычно {@code
 *     http://127.0.0.1:18300}). Пусто — аналитики нет: факты не собираются, отчёты пульту отвечают
 *     {@code 503 INSIGHT_UNAVAILABLE}
 */
@ConfigurationProperties("stream.insight")
public record InsightProperties(String url) {
  /** Задан ли адрес службы. */
  public boolean on() {
    return url != null && !url.isBlank();
  }

  /** Адрес службы без косой черты в конце. */
  public String base() {
    return url == null ? "" : url.strip().replaceAll("/+$", "");
  }
}
