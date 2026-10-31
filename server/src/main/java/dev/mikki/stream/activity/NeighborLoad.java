package dev.mikki.stream.activity;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Загрузка серверов каталога — для «Сменить сервер» в браузере (R143).
 *
 * <p>Браузер к чужому серверу не сходит: CSP {@code connect-src} пускает только свой адрес, и
 * ослаблять её ради палочек нельзя. Поэтому спрашивает ядро — сервер-сервер, по адресам из своего
 * же подписанного каталога ({@code CATALOG_FILE}), не чаще раза в 30 с на соседа и с таймаутом 2 с.
 * Сосед старой версии без {@code /api/v1/load} (404) или недоступный — {@code unknown}, без ошибки.
 * Клиент Windows спрашивает соседей сам, через {@code net.fetch} оболочки.
 */
@Component
public class NeighborLoad {
  /** Ступень соседа: {@code level} 0 — неизвестно. */
  public record CatalogLoad(String url, int level, String state, long at) {}

  static final Duration TTL = Duration.ofSeconds(30);
  private static final Duration TIMEOUT = Duration.ofSeconds(2);

  private static final ObjectMapper JSON = new ObjectMapper();

  private final Path catalog;
  private final Clock clock;
  private final HttpClient http;
  private final Map<String, CatalogLoad> cache = new ConcurrentHashMap<>();

  @Autowired
  public NeighborLoad(@Value("${CATALOG_FILE:/catalog/servers.jws}") String catalog, Clock clock) {
    this(Path.of(catalog), clock, HttpClient.newBuilder().connectTimeout(TIMEOUT).build());
  }

  NeighborLoad(Path catalog, Clock clock, HttpClient http) {
    this.catalog = catalog;
    this.clock = clock;
    this.http = http;
  }

  /** Все серверы каталога; свой — из замера, остальные — из кеша или свежим вопросом. */
  public List<CatalogLoad> all(String self, LoadMeter.Load own) {
    var answers = new ArrayList<CatalogLoad>();
    for (var url : servers()) {
      if (sameServer(url, self)) {
        answers.add(new CatalogLoad(url, own.level(), own.state(), own.updatedAt()));
        continue;
      }
      var cached = cache.get(url);
      if (cached == null || clock.millis() - cached.at() > TTL.toMillis()) {
        cached = ask(url);
        cache.put(url, cached);
      }
      answers.add(cached);
    }
    return answers;
  }

  List<String> servers() {
    try {
      var envelope = JSON.readTree(Files.readAllBytes(catalog));
      var payload = envelope.path("payload").asText("");
      if (payload.isEmpty()) return List.of();
      var body = JSON.readTree(Base64.getUrlDecoder().decode(payload));
      var urls = new ArrayList<String>();
      for (JsonNode server : body.path("servers")) {
        var url = server.path("url").asText("");
        if (url.startsWith("https://") || url.startsWith("http://localhost")) urls.add(url);
      }
      return urls;
    } catch (IOException | IllegalArgumentException e) {
      return List.of();
    }
  }

  private CatalogLoad ask(String url) {
    var now = clock.millis();
    try {
      var request =
          HttpRequest.newBuilder(URI.create(url.replaceAll("/+$", "") + "/api/v1/load"))
              .timeout(TIMEOUT)
              .header("Accept", "application/json")
              .GET()
              .build();
      var response = http.send(request, HttpResponse.BodyHandlers.ofByteArray());
      if (response.statusCode() != 200) return new CatalogLoad(url, 0, "unknown", now);
      var body = JSON.readTree(response.body());
      var level = body.path("level").asInt(0);
      var state = body.path("state").asText("unknown");
      if (level < 1 || level > 4) return new CatalogLoad(url, 0, "unknown", now);
      return new CatalogLoad(url, level, state.length() > 16 ? "unknown" : state, now);
    } catch (IOException | IllegalArgumentException e) {
      return new CatalogLoad(url, 0, "unknown", now);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      return new CatalogLoad(url, 0, "unknown", now);
    }
  }

  static boolean sameServer(String url, String self) {
    if (self == null || self.isBlank()) return false;
    try {
      return URI.create(url).getHost().equalsIgnoreCase(URI.create(self).getHost());
    } catch (IllegalArgumentException | NullPointerException e) {
      return false;
    }
  }
}
