package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;

import dev.mikki.stream.api.CatalogController;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;

/**
 * Каталог серверов (T05, ADR 0001 §8, решение архитектора 9): ядро отдаёт подписанный офлайн файл
 * установки ({@code CATALOG_FILE}) как есть, байт в байт, без пароля сервера. Подпись проверяет
 * клиент и {@code scripts/sign-catalog.mjs verify}; адресов серверов в репозитории нет.
 */
class CatalogTest {
  @Test
  void theCoreServesTheInstallationCatalogByteForByte(@TempDir Path dir) throws Exception {
    var file = dir.resolve("servers.jws");
    var signed = "{\"payload\":\"e30\",\"signatures\":[]}".getBytes(StandardCharsets.UTF_8);
    Files.write(file, signed);

    var response = new CatalogController(file.toString()).catalog();

    assertThat(response.getStatusCode().value()).isEqualTo(200);
    assertThat(response.getHeaders().getContentType())
        .isEqualTo(MediaType.parseMediaType("application/jose+json"));
    assertThat(response.getBody()).isEqualTo(signed);
  }

  @Test
  void aResignedCatalogIsServedWithoutARestart(@TempDir Path dir) throws Exception {
    var file = dir.resolve("servers.jws");
    Files.writeString(file, "{\"seq\":1}");
    var controller = new CatalogController(file.toString());
    assertThat(controller.catalog().getBody()).isEqualTo("{\"seq\":1}".getBytes());

    Files.writeString(file, "{\"seq\":2}");

    assertThat(controller.catalog().getBody()).isEqualTo("{\"seq\":2}".getBytes());
  }

  @Test
  void anInstallationWithoutACatalogAnswersNotFound(@TempDir Path dir) {
    var response = new CatalogController(dir.resolve("missing.jws").toString()).catalog();

    assertThat(response.getStatusCode().value()).isEqualTo(404);
    assertThat(response.getBody()).isNull();
  }
}
