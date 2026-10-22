package dev.mikki.stream.api;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Каталог серверов Cord (T05, П4, ADR 0001 §8, решение архитектора 9).
 *
 * <p>Это файл установки, а не часть кода: JWS (RFC 7515, {@code alg: EdDSA}), подписанный офлайн
 * скриптом владельца {@code scripts/sign-catalog.mjs} и положенный в {@code .local/catalog/
 * servers.jws} рядом с {@code .env}; compose монтирует его в ядро ({@code CATALOG_FILE}). Своя
 * установка — свой каталог: ни образ, ни репозиторий не знают, какие серверы есть у владельца.
 * Файла нет — 404, и клиент остаётся на сервере, вшитом при его сборке.
 *
 * <p>Ядро отдаёт файл байт в байт и ничего в нём не проверяет и не меняет: закрытого ключа на
 * сервере нет, поэтому взломанный сервер не впишет в каталог чужой адрес — клиент сверит подпись с
 * ключами {@code contracts/catalog-keys.json}. Файл читается на каждый запрос (сотни байт), чтобы
 * переподписанный каталог раздавался без перезапуска.
 *
 * <p>Маршрут открытый ({@link RequestGuard}): каталог нужен клиенту раньше, чем он знает пароль
 * какого-либо сервера.
 */
@RestController
@RequestMapping("/api/v1")
public class CatalogController {
  static final MediaType JOSE_JSON = MediaType.parseMediaType("application/jose+json");

  private final Path file;

  public CatalogController(@Value("${CATALOG_FILE:/catalog/servers.jws}") String file) {
    this.file = Path.of(file);
  }

  /**
   * Подписанный каталог как есть. Тип — {@code application/jose+json}; {@code produces} не указан
   * нарочно: клиент с {@code Accept: application/json} получает тот же файл, а не 406.
   */
  @GetMapping("/catalog")
  public ResponseEntity<byte[]> catalog() {
    byte[] catalog;
    try {
      catalog = Files.readAllBytes(file);
    } catch (NoSuchFileException e) {
      return ResponseEntity.notFound().build();
    } catch (IOException e) {
      throw new UncheckedIOException("Cannot read the server catalog " + file, e);
    }
    return ResponseEntity.ok().contentType(JOSE_JSON).body(catalog);
  }
}
