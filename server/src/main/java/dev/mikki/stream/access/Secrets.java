package dev.mikki.stream.access;

import dev.mikki.stream.config.StreamProperties;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.stereotype.Component;

@Component
public class Secrets {
  private final byte[] key;

  public Secrets(StreamProperties properties) {
    key = properties.sessionSecret().getBytes(StandardCharsets.UTF_8);
  }

  public String derive(String scope) {
    try {
      var mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(key, "HmacSHA256"));
      return Base64.getUrlEncoder()
          .withoutPadding()
          .encodeToString(mac.doFinal(scope.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  /**
   * Отпечаток ключа адреса (IPv4, сеть /64 или актор службы): HMAC секретом сервера (П8).
   *
   * <p>Один на всё ядро: им комната помнит, откуда создана ({@code createdFrom}), им пишется адрес
   * в журнал аудита и им же блокирует владелец сервера. Поэтому «заблокировать создателя этой
   * встречи» и «заблокировать адрес из этой строки журнала» — одно и то же, а сам адрес не хранится
   * нигде. Обычный хэш с солью здесь не годится: адресов IPv4 всего 2³², и он перебирается за
   * минуты.
   */
  public String address(String key) {
    return key == null ? null : derive("origin:" + key);
  }

  public static String hash(String secret) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256").digest(secret.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  public static boolean equal(String a, String b) {
    return a != null
        && b != null
        && MessageDigest.isEqual(
            a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
  }
}
