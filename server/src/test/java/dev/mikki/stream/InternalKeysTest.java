package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;

import dev.mikki.stream.access.InternalKeys;
import java.util.HexFormat;
import org.junit.jupiter.api.Test;

/**
 * Ключи по назначению из {@code INTERNAL_SECRET} (A14): формула HKDF и общий образец с службой.
 *
 * <p>Тот же образец — в {@code services/tests/test_keys.py}: служба шлёт ровно тот ключ, который
 * ядро ждёт.
 */
class InternalKeysTest {
  private static final String SECRET = "a-test-internal-secret-of-32-chars";

  @Test
  void rfc5869TestCase1() {
    var hex = HexFormat.of();
    var okm =
        InternalKeys.hkdf(
            hex.parseHex("0b".repeat(22)),
            hex.parseHex("000102030405060708090a0b0c"),
            hex.parseHex("f0f1f2f3f4f5f6f7f8f9"),
            42);
    assertThat(hex.formatHex(okm))
        .isEqualTo(
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
  }

  @Test
  void theServiceKeyIsTheOneTheServicesSend() {
    assertThat(InternalKeys.service(SECRET))
        .isEqualTo("0VpQEjXyrY1j1PlleKmCpXUw0obr6f_ZvOULDAArni4");
    assertThat(InternalKeys.derive(SECRET, "actor"))
        .isEqualTo("qdy2X9k6l9pwl4VXq6QW8L96EYNnB24T_l-5WfS7b4g");
  }

  @Test
  void onlyTheServiceKeyMakesAService() {
    assertThat(InternalKeys.isService(InternalKeys.service(SECRET), SECRET)).isTrue();
    assertThat(InternalKeys.isService(SECRET, SECRET)).isFalse();
    assertThat(InternalKeys.isService(InternalKeys.derive(SECRET, "actor"), SECRET)).isFalse();
    assertThat(InternalKeys.isService(null, SECRET)).isFalse();
    assertThat(InternalKeys.isService(InternalKeys.service(SECRET), null)).isFalse();
    // Другой секрет — другой ключ: кэш последнего ключа не путает установки.
    var other = "another-internal-secret-of-32-chars";
    assertThat(InternalKeys.isService(InternalKeys.service(SECRET), other)).isFalse();
    assertThat(InternalKeys.isService(InternalKeys.service(other), other)).isTrue();
  }
}
