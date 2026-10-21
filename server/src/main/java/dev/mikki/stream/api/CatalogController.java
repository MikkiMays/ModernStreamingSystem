package dev.mikki.stream.api;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Каталог серверов Cord (T05, П4, ADR 0001 §8, решение архитектора 9).
 *
 * <p>Это статичный файл {@code infra/catalog/servers.jws}: JWS (RFC 7515, {@code alg: EdDSA}),
 * подписанный офлайн скриптом владельца {@code scripts/sign-catalog.mjs}. Сборка кладёт его в jar
 * ({@code server/pom.xml}, {@code catalog/servers.jws}), ядро отдаёт байт в байт и ничего в нём не
 * проверяет и не меняет: закрытого ключа на сервере нет, поэтому взломанный сервер не впишет в
 * каталог чужой адрес — клиент сверит подпись с ключами {@code contracts/catalog-keys.json}.
 *
 * <p>Маршрут открытый ({@link RequestGuard}): каталог нужен клиенту раньше, чем он знает пароль
 * какого-либо сервера.
 */
@RestController
@RequestMapping("/api/v1")
public class CatalogController {
  static final MediaType JOSE_JSON = MediaType.parseMediaType("application/jose+json");
  private static final String RESOURCE = "/catalog/servers.jws";

  private final byte[] catalog;

  public CatalogController() {
    try (InputStream input = CatalogController.class.getResourceAsStream(RESOURCE)) {
      this.catalog = input == null ? null : input.readAllBytes();
    } catch (IOException e) {
      throw new UncheckedIOException("Cannot read the server catalog", e);
    }
  }

  /**
   * Подписанный каталог как есть. Тип — {@code application/jose+json}; {@code produces} не указан
   * нарочно: клиент с {@code Accept: application/json} получает тот же файл, а не 406.
   */
  @GetMapping("/catalog")
  public ResponseEntity<byte[]> catalog() {
    if (catalog == null) return ResponseEntity.notFound().build();
    return ResponseEntity.ok().contentType(JOSE_JSON).body(catalog);
  }
}
