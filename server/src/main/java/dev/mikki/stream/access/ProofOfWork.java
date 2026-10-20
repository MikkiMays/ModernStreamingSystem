package dev.mikki.stream.access;

import dev.mikki.stream.config.Rate;
import dev.mikki.stream.shared.Json;
import dev.mikki.stream.shared.Problem;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.function.LongSupplier;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Невидимая проверка «не бот» без учётных записей и чужих сервисов (решение 15 архитектуры, {@code
 * docs/abuse-model.md} §3): задача proof-of-work по протоколу ALTCHA, своим кодом на обеих
 * сторонах.
 *
 * <p>КАК УСТРОЕНО. Сервер выдаёт соль и хэш {@code SHA-256(соль + n)} для случайного {@code n ≤
 * maxnumber}, подписанный HMAC своим ключом. Браузер в фоновом потоке перебирает числа, пока не
 * найдёт {@code n}, и присылает ответ заголовком {@code X-Cord-Proof} — base64 от JSON {@code
 * {algorithm, challenge, number, salt, signature}}, как у ALTCHA. Проверка стоит одного хэша и
 * одного HMAC; человеку это доли секунды, а скрипту, создающему встречи тысячами, — тысячи таких
 * долей.
 *
 * <p>ПРИВЯЗКА БЕЗ ХРАНЕНИЯ. В соль вписаны срок, действие ({@code create}, {@code code}) и
 * отпечаток адреса; подпись покрывает хэш, а хэш — соль, поэтому подменить их нельзя, а выдача
 * задачи ничего не пишет. Одноразовость — счётчик подписи с окном в срок жизни задачи: второй
 * предъявленный тот же ответ получает отказ. Своей защиты от повтора у ALTCHA нет, она лежит на
 * сервере.
 *
 * <p>Протокол — первая версия ALTCHA (SHA-256 и {@code maxnumber}): её решатель — двадцать строк на
 * WebCrypto, без зависимостей и без послаблений CSP.
 */
@Component
public class ProofOfWork {
  /** Сколько живёт выданная задача: браузер решает её, пока открыта форма. */
  public static final Duration TTL = Duration.ofMinutes(5);

  public static final String HEADER = "X-Cord-Proof";

  /** Задача, как её получает браузер ({@code GET /api/v1/proof}). */
  public record Challenge(
      String algorithm, String challenge, long maxnumber, String salt, String signature) {}

  private final byte[] key;
  private final RateLimits limits;
  private final LongSupplier clock;
  private final SecureRandom random = new SecureRandom();

  @Autowired
  public ProofOfWork(Secrets secrets, RateLimits limits, Clock clock) {
    this(secrets.derive("proof").getBytes(StandardCharsets.UTF_8), limits, clock::millis);
  }

  public ProofOfWork(byte[] key, RateLimits limits, LongSupplier clock) {
    this.key = key.clone();
    this.limits = limits;
    this.clock = clock;
  }

  /** Новая задача на действие {@code action} для ключа адреса {@code address}. */
  public Challenge issue(String action, String address, long maxnumber) {
    var nonce = new byte[12];
    random.nextBytes(nonce);
    long expires = (clock.getAsLong() + TTL.toMillis()) / 1000;
    var salt =
        HexFormat.of().formatHex(nonce)
            + "?expires="
            + expires
            + "&for="
            + action
            + "&k="
            + fingerprint(address);
    long number = random.nextLong(maxnumber + 1);
    var challenge = hash(salt, number);
    return new Challenge("SHA-256", challenge, maxnumber, salt, mac(challenge));
  }

  /** Принять ответ на задачу — или отказать {@code 403 PROOF_INVALID}. Ответ годится один раз. */
  public void verify(String header, String action, String address) {
    if (header == null || header.length() > 2048) throw invalid();
    String algorithm, challenge, salt, signature;
    long number;
    try {
      var body =
          Json.tree(new String(Base64.getDecoder().decode(header.strip()), StandardCharsets.UTF_8));
      algorithm = body.path("algorithm").asText();
      challenge = body.path("challenge").asText();
      salt = body.path("salt").asText();
      signature = body.path("signature").asText();
      if (!body.path("number").canConvertToLong()) throw invalid();
      number = body.path("number").asLong();
    } catch (IllegalArgumentException e) {
      throw invalid();
    }
    if (!"SHA-256".equals(algorithm) || number < 0) throw invalid();
    if (!Secrets.equal(signature, mac(challenge))) throw invalid();
    if (!Secrets.equal(challenge, hash(salt, number))) throw invalid();
    var params = params(salt);
    long expires;
    try {
      expires = Long.parseLong(params.getOrDefault("expires", ""));
    } catch (NumberFormatException e) {
      throw invalid();
    }
    if (expires * 1000 < clock.getAsLong()
        || !action.equals(params.get("for"))
        || !fingerprint(address).equals(params.get("k"))) throw invalid();
    if (limits.hit("proof:" + signature, new Rate(1, TTL.plusMinutes(1))) > 1) throw invalid();
  }

  /** Хэш, который ищет браузер: SHA-256 от соли и десятичного числа подряд, шестнадцатерично. */
  public static String hash(String salt, long number) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256")
                  .digest((salt + number).getBytes(StandardCharsets.UTF_8)));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  private String mac(String value) {
    try {
      var mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(key, "HmacSHA256"));
      return HexFormat.of().formatHex(mac.doFinal(value.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  /** Отпечаток адреса в соли: сам адрес задаче видеть незачем. */
  private String fingerprint(String address) {
    return mac("address:" + (address == null ? "" : address)).substring(0, 16);
  }

  private static LinkedHashMap<String, String> params(String salt) {
    var out = new LinkedHashMap<String, String>();
    int start = salt.indexOf('?');
    if (start < 0) return out;
    for (var pair : salt.substring(start + 1).split("&")) {
      int eq = pair.indexOf('=');
      if (eq > 0) out.putIfAbsent(pair.substring(0, eq), pair.substring(eq + 1));
    }
    return out;
  }

  private static Problem invalid() {
    return new Problem(
        403, "PROOF_INVALID", "Не удалось проверить браузер. Обновите страницу и попробуйте снова");
  }
}
