package dev.mikki.stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.mikki.stream.access.ProofOfWork;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.shared.Json;
import dev.mikki.stream.shared.Problem;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import org.junit.jupiter.api.Test;

/**
 * Невидимая проверка «не бот» (E11-B, решение 15 архитектуры): задача proof-of-work по протоколу
 * ALTCHA, выданная на одно действие одному адресу, решается один раз.
 */
class ProofOfWorkTest {
  static final byte[] KEY = "proof-test-key-of-thirty-two-bytes!".getBytes(StandardCharsets.UTF_8);
  Clock clock = Clock.fixed(Instant.ofEpochSecond(1_800_000_000), ZoneOffset.UTC);
  ProofOfWork proofs = new ProofOfWork(KEY, RateLimits.inMemory(), () -> clock.millis());

  /** То, что делает решатель браузера: перебирает число, пока хэш соли с ним не совпадёт. */
  static String solve(ProofOfWork.Challenge challenge) throws Exception {
    var sha = MessageDigest.getInstance("SHA-256");
    for (long n = 0; n <= challenge.maxnumber(); n++) {
      var hash =
          HexFormat.of()
              .formatHex(sha.digest((challenge.salt() + n).getBytes(StandardCharsets.UTF_8)));
      if (hash.equals(challenge.challenge())) return payload(challenge, n);
    }
    throw new AssertionError("Решения нет");
  }

  static String payload(ProofOfWork.Challenge challenge, long number) {
    var body = new LinkedHashMap<String, Object>();
    body.put("algorithm", challenge.algorithm());
    body.put("challenge", challenge.challenge());
    body.put("number", number);
    body.put("salt", challenge.salt());
    body.put("signature", challenge.signature());
    return Base64.getEncoder().encodeToString(Json.write(body).getBytes(StandardCharsets.UTF_8));
  }

  @Test
  void aSolvedChallengeOpensTheDoorOnce() throws Exception {
    var challenge = proofs.issue("create", "203.0.113.7", 2000);
    assertThat(challenge.algorithm()).isEqualTo("SHA-256");
    assertThat(challenge.maxnumber()).isEqualTo(2000);
    var answer = solve(challenge);
    proofs.verify(answer, "create", "203.0.113.7");
    refused(() -> proofs.verify(answer, "create", "203.0.113.7"));
  }

  @Test
  void aProofBelongsToItsActionAndItsAddress() throws Exception {
    var answer = solve(proofs.issue("create", "203.0.113.7", 2000));
    refused(() -> proofs.verify(answer, "code", "203.0.113.7"));
    refused(() -> proofs.verify(answer, "create", "203.0.113.8"));
    proofs.verify(answer, "create", "203.0.113.7");
  }

  @Test
  void anExpiredOrForgedProofIsRefused() throws Exception {
    var challenge = proofs.issue("code", "203.0.113.7", 2000);
    var answer = solve(challenge);
    var later =
        new ProofOfWork(
            KEY, RateLimits.inMemory(), () -> clock.millis() + ProofOfWork.TTL.toMillis() + 1000);
    refused(() -> later.verify(answer, "code", "203.0.113.7"));
    var stranger =
        new ProofOfWork(
            "another-key-of-thirty-two-bytes!!!".getBytes(), RateLimits.inMemory(), clock::millis);
    refused(() -> stranger.verify(answer, "code", "203.0.113.7"));
    refused(
        () -> proofs.verify(payload(challenge, challenge.maxnumber() + 1), "code", "203.0.113.7"));
    refused(() -> proofs.verify(null, "code", "203.0.113.7"));
    refused(() -> proofs.verify("не base64", "code", "203.0.113.7"));
  }

  /**
   * Контракт с решателем браузера ({@code web/src/core/proof.worker.ts}): хэш — SHA-256 от соли и
   * десятичного числа подряд, в шестнадцатеричном виде. Вектор посчитан отдельно (Python hashlib) и
   * лежит в тесте решателя тем же.
   */
  @Test
  void theHashIsTheOneTheBrowserComputes() {
    assertThat(
            ProofOfWork.hash(
                "5f1d2c3b4a596877?expires=1900000000&for=create&k=0123456789abcdef", 31337))
        .isEqualTo("ad91462b2f8bc4a73b1abbb322bedb6fecb98d014b032f57edd9a32954093494");
  }

  static void refused(org.assertj.core.api.ThrowableAssert.ThrowingCallable call) {
    assertThatThrownBy(call)
        .isInstanceOfSatisfying(
            Problem.class,
            p -> {
              assertThat(p.status()).isEqualTo(403);
              assertThat(p.code()).isEqualTo("PROOF_INVALID");
            });
  }
}
