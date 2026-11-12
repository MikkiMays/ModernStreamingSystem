package dev.mikki.stream.activity;

import dev.mikki.stream.access.InternalKeys;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Json;
import dev.mikki.stream.shared.Problem;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Отчёты службы аналитики {@code insight} для пульта (R239, {@code contracts/insight.md} §3, формы
 * ответов — {@code contracts/insight-reports.md}).
 *
 * <p>Ядро отчётов не строит и не разбирает: спрашивает службу на петле своей машины ({@code GET
 * /internal/reports/...} с ключом назначения {@code insight}) и отдаёт её ответ как есть. Пульт
 * ходит к ядру своим каналом и ключа службы не знает.
 *
 * <p>ОТКАЗЫ. Службы нет ({@code stream.insight.url} пуст), она не ответила за срок, ответила не
 * тем, чего от неё ждут ({@code 401}, {@code 5xx}), — {@code 503 INSIGHT_UNAVAILABLE}: спросить
 * позже. Служба отказала запросу ({@code 400} — период или вид, {@code 404} — нет такого раздела
 * или группы ошибок) — тот же статус в формате отказов ядра, со словами службы.
 */
@Component
public class InsightReports {
  /** Параметры запроса, которые ядро пересылает службе; остальные до неё не доходят. */
  public static final List<String> PARAMS = List.of("from", "to", "view", "strict", "compare");

  /** Сколько ждать отчёт: служба считает его по базе, это дольше приёма фактов. */
  static final Duration READ_TIMEOUT = Duration.ofSeconds(15);

  /** Запрос к службе: адрес целиком — в ответ статус и тело. */
  @FunctionalInterface
  public interface Transport {
    Answer get(URI uri) throws Exception;
  }

  public record Answer(int status, byte[] body) {}

  private final String base;
  private final Transport transport;

  @Autowired
  public InsightReports(InsightProperties insight, StreamProperties config) {
    this(
        insight.base(),
        insight.on()
            ? http(InternalKeys.derive(config.internalSecret(), InsightFacts.PURPOSE))
            : null);
  }

  /** Со своим запросом — для тестов; {@code transport == null} — службы нет. */
  public InsightReports(String base, Transport transport) {
    this.base = base;
    this.transport = transport;
  }

  private static Transport http(String key) {
    var client =
        HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(InsightFacts.CONNECT_TIMEOUT)
            .build();
    return uri -> {
      var response =
          client.send(
              HttpRequest.newBuilder(uri)
                  .timeout(READ_TIMEOUT)
                  .header(InsightFacts.KEY_HEADER, key)
                  .GET()
                  .build(),
              HttpResponse.BodyHandlers.ofByteArray());
      return new Answer(response.statusCode(), response.body());
    };
  }

  /**
   * Отчёт раздела {@code section}; {@code key} — группа ошибок у раздела {@code errors} или {@code
   * null}. Ответ — тело службы без изменений.
   */
  public byte[] report(String section, String key, Map<String, String> query) {
    if (transport == null) throw unavailable();
    var path = new StringBuilder(base).append("/internal/reports/").append(encode(section));
    if (key != null) path.append('/').append(encode(key));
    char separator = '?';
    for (var name : PARAMS) {
      var value = query.get(name);
      if (value == null) continue;
      path.append(separator).append(name).append('=').append(encode(value));
      separator = '&';
    }
    Answer answer;
    try {
      answer = transport.get(URI.create(path.toString()));
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw unavailable();
    } catch (Exception e) {
      throw unavailable();
    }
    if (answer.status() == 200) return answer.body();
    var said = said(answer.body());
    if (answer.status() == 400) throw new Problem(400, "INSIGHT_REQUEST", said);
    if (answer.status() == 404) throw new Problem(404, "INSIGHT_NOT_FOUND", said);
    throw unavailable();
  }

  private static Problem unavailable() {
    return new Problem(503, "INSIGHT_UNAVAILABLE", "Аналитика сейчас недоступна. Попробуйте позже");
  }

  /** Что сказала служба в отказе ({@code {"error": "…"}}); не разобрать — общими словами. */
  private static String said(byte[] body) {
    try {
      var text =
          Json.tree(new String(body == null ? new byte[0] : body, StandardCharsets.UTF_8))
              .path("error")
              .asText("")
              .strip();
      if (!text.isEmpty()) return text.substring(0, Math.min(200, text.length()));
    } catch (RuntimeException e) {
      // Ниже — общими словами.
    }
    return "Служба аналитики не приняла запрос";
  }

  private static String encode(String value) {
    return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
  }
}
