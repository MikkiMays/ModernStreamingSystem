package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.mikki.stream.api.CatalogController;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

/**
 * Каталог серверов (T05, ADR 0001 §8, решение архитектора 9): ядро отдаёт подписанный офлайн файл
 * {@code infra/catalog/servers.jws} как есть, байт в байт, без пароля сервера. Подпись проверяет
 * клиент; здесь — что в образ попал именно файл из репозитория и что он подписан ключом из {@code
 * contracts/catalog-keys.json}: иначе клиенты молча остались бы на старом каталоге.
 */
class CatalogTest {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final Path ROOT = Path.of("..").toAbsolutePath().normalize();

  /**
   * Префикс SPKI DER для Ed25519 (RFC 8410): за ним — 32 байта открытого ключа из JWK {@code x}.
   */
  private static final byte[] ED25519_SPKI_PREFIX =
      HexFormat.of().parseHex("302a300506032b6570032100");

  private static PublicKey key(JsonNode jwk) throws Exception {
    byte[] raw = Base64.getUrlDecoder().decode(jwk.get("x").asText());
    byte[] der = new byte[ED25519_SPKI_PREFIX.length + raw.length];
    System.arraycopy(ED25519_SPKI_PREFIX, 0, der, 0, ED25519_SPKI_PREFIX.length);
    System.arraycopy(raw, 0, der, ED25519_SPKI_PREFIX.length, raw.length);
    return KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(der));
  }

  @Test
  void theCoreServesTheCommittedCatalogByteForByte() throws Exception {
    var committed = Files.readAllBytes(ROOT.resolve("infra/catalog/servers.jws"));
    var response = new CatalogController().catalog();
    assertThat(response.getStatusCode().value()).isEqualTo(200);
    assertThat(response.getHeaders().getContentType())
        .isEqualTo(MediaType.parseMediaType("application/jose+json"));
    assertThat(response.getBody()).isEqualTo(committed);
  }

  @Test
  void theCommittedCatalogIsSignedByAListedKeyAndFollowsTheFormat() throws Exception {
    var envelope =
        JSON.readTree(
            Files.readString(ROOT.resolve("infra/catalog/servers.jws"), StandardCharsets.UTF_8));
    var jwks = JSON.readTree(Files.readString(ROOT.resolve("contracts/catalog-keys.json")));
    List<PublicKey> keys = new ArrayList<>();
    for (var jwk : jwks.get("keys")) {
      assertThat(jwk.get("kty").asText()).isEqualTo("OKP");
      assertThat(jwk.get("crv").asText()).isEqualTo("Ed25519");
      keys.add(key(jwk));
    }
    assertThat(keys).isNotEmpty();
    var payload = envelope.get("payload").asText();
    boolean signed = false;
    for (var entry : envelope.get("signatures")) {
      var header = JSON.readTree(Base64.getUrlDecoder().decode(entry.get("protected").asText()));
      assertThat(header.get("alg").asText()).isEqualTo("EdDSA");
      var input =
          (entry.get("protected").asText() + "." + payload).getBytes(StandardCharsets.US_ASCII);
      var signature = Base64.getUrlDecoder().decode(entry.get("signature").asText());
      for (var key : keys) {
        var verifier = Signature.getInstance("Ed25519");
        verifier.initVerify(key);
        verifier.update(input);
        signed |= verifier.verify(signature);
      }
    }
    assertThat(signed).as("подпись каталога ключом из contracts/catalog-keys.json").isTrue();

    var body = JSON.readTree(Base64.getUrlDecoder().decode(payload));
    assertThat(body.get("format").asText()).isEqualTo("cord.servers/1");
    assertThat(body.get("seq").asInt()).isPositive();
    var servers = body.get("servers");
    assertThat(servers.size()).isBetween(1, 50);
    int defaults = 0;
    for (var server : servers) {
      assertThat(server.get("id").asText()).matches("[a-z0-9-]{1,32}");
      assertThat(server.get("country").asText()).matches("[A-Z]{2}");
      assertThat(server.get("url").asText()).matches("https://[a-z0-9.-]+(:[0-9]{1,5})?/");
      assertThat(server.get("name").get("ru").asText()).isNotBlank();
      if (server.path("default").asBoolean(false)) defaults++;
    }
    assertThat(defaults).as("ровно один сервер по умолчанию").isEqualTo(1);
  }
}
