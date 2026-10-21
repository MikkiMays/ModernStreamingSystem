package dev.mikki.stream.access;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicReference;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Ключи по назначению из {@code INTERNAL_SECRET} (A14 {@code docs/abuse-model.md}).
 *
 * <p>Раньше один секрет установки был и заголовком «я служба Cord» ({@code X-Service-Secret}), и
 * ключом подписи адресов кинозала, и HMAC номера пользователя бота, и ключом сейфа входов.
 * Заголовок уходит по сети с каждым запросом службы — попади он в чей-то журнал, вместе с ним
 * утекли бы и подписи, и сейф. Теперь у каждого назначения свой ключ HKDF-SHA256 (RFC 5869): соль
 * {@code cord-internal-secret}, {@code info} — имя назначения, 32 байта. Зная один ключ, не
 * получить ни соседний, ни сам секрет.
 *
 * <p>Формула общая с службой ({@code services/cord_services/keys.py}); общий образец — {@code
 * InternalKeysTest} и {@code services/tests/test_keys.py}. Ядру из всех назначений нужно одно —
 * {@link #SERVICE}: остальными пользуется служба.
 *
 * <p>Шлюз (Caddy) выводить ключи не умеет и ставит {@code X-Internal-Secret} самим секретом. Это
 * заявление «пришло через нашу дверь», а не «я служба»: оно не открывает пароль сервера и не делает
 * {@code X-Cord-Actor} правдой.
 */
public final class InternalKeys {
  /** Заголовок {@code X-Service-Secret} службы к ядру. */
  public static final String SERVICE = "service";

  private static final byte[] SALT = "cord-internal-secret".getBytes(StandardCharsets.UTF_8);

  /** Последний выведенный ключ службы: секрет у процесса один, HKDF на каждый запрос не нужен. */
  private static final AtomicReference<String[]> LAST = new AtomicReference<>();

  private InternalKeys() {}

  /** HKDF-SHA256 (RFC 5869): извлечь, затем растянуть до {@code length} байт. */
  public static byte[] hkdf(byte[] ikm, byte[] salt, byte[] info, int length) {
    try {
      var mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(salt.length == 0 ? new byte[32] : salt, "HmacSHA256"));
      var prk = mac.doFinal(ikm);
      mac.init(new SecretKeySpec(prk, "HmacSHA256"));
      var out = new byte[length];
      var block = new byte[0];
      for (int counter = 1, filled = 0; filled < length; counter++) {
        mac.update(block);
        mac.update(info);
        mac.update((byte) counter);
        block = mac.doFinal();
        int n = Math.min(block.length, length - filled);
        System.arraycopy(block, 0, out, filled, n);
        filled += n;
      }
      return out;
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  /** Ключ назначения строкой: base64url без {@code =} (43 знака), как его шлёт служба. */
  public static String derive(String secret, String purpose) {
    return Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(
            hkdf(
                secret.getBytes(StandardCharsets.UTF_8),
                SALT,
                purpose.getBytes(StandardCharsets.UTF_8),
                32));
  }

  /** Ключ службы для этого секрета. */
  public static String service(String secret) {
    var last = LAST.get();
    if (last != null && last[0].equals(secret)) return last[1];
    var key = derive(secret, SERVICE);
    LAST.set(new String[] {secret, key});
    return key;
  }

  /** Прислала ли запрос наша служба: {@code X-Service-Secret} — ключ службы, а не сам секрет. */
  public static boolean isService(String header, String secret) {
    return header != null && secret != null && Secrets.equal(header, service(secret));
  }
}
