package dev.mikki.stream.activity;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.fasterxml.jackson.databind.JsonNode;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Json;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;

/**
 * Буфер фактов аналитики ({@link InsightFacts}, {@code contracts/insight.md} §2) без Spring и без
 * сети: пачки, повтор той же пачки, предел буфера, отказы итогом минуты, псевдоним профиля.
 */
class InsightFactsTest {
  static final String SESSION_SECRET = "test-session-secret-0123456789abcdef";

  final AtomicLong now = new AtomicLong(1_793_612_345_678L);
  final SimpleMeterRegistry registry = new SimpleMeterRegistry();
  final List<String> posted = new ArrayList<>();
  final Deque<Object> answers = new ArrayDeque<>();

  Secrets secrets() {
    var config = mock(StreamProperties.class);
    when(config.sessionSecret()).thenReturn(SESSION_SECRET);
    return new Secrets(config);
  }

  Clock clock() {
    var clock = mock(Clock.class);
    when(clock.millis()).thenAnswer(_ -> now.get());
    return clock;
  }

  /** Служба, которая отвечает по очереди из {@link #answers}; очередь пуста — {@code 204}. */
  InsightFacts facts() {
    return new InsightFacts(
        body -> {
          posted.add(body);
          var answer = answers.pollFirst();
          if (answer instanceof Exception failure) throw failure;
          return answer == null ? 204 : (Integer) answer;
        },
        secrets(),
        clock(),
        registry);
  }

  static List<JsonNode> factsOf(String body) {
    var tree = Json.tree(body);
    assertThat(tree.path("source").asText()).isEqualTo("core");
    var facts = new ArrayList<JsonNode>();
    tree.path("facts").forEach(facts::add);
    return facts;
  }

  double counter(String name) {
    return registry.get(name).counter().count();
  }

  /** Буфер уходит пачками не больше пятисот; у каждого факта свой номер, момент и тип. */
  @Test
  void theBufferLeavesInBatchesOfFiveHundred() {
    var facts = facts();
    for (int i = 0; i < 1200; i++)
      facts.fact("refusal").put("code", "C" + i).put("count", 1).publish();
    assertThat(facts.buffered()).isEqualTo(1200);
    assertThat(posted).isEmpty();
    assertThat(facts.flush()).isEqualTo(1200);
    assertThat(posted).hasSize(3);
    assertThat(factsOf(posted.get(0))).hasSize(500);
    assertThat(factsOf(posted.get(1))).hasSize(500);
    assertThat(factsOf(posted.get(2))).hasSize(200);
    var ids = new HashSet<String>();
    for (var body : posted)
      for (var fact : factsOf(body)) {
        assertThat(ids.add(fact.path("id").asText())).isTrue();
        assertThat(fact.path("at").asLong()).isEqualTo(now.get());
        assertThat(fact.path("type").asText()).isEqualTo("refusal");
      }
    // По порядку: что случилось раньше, уходит раньше.
    assertThat(factsOf(posted.get(0)).getFirst().path("code").asText()).isEqualTo("C0");
    assertThat(factsOf(posted.get(2)).getLast().path("code").asText()).isEqualTo("C1199");
    assertThat(facts.buffered()).isZero();
    assertThat(counter("cord.insight.facts.sent")).isEqualTo(1200);
    assertThat(facts.flush()).isZero();
    assertThat(posted).hasSize(3);
  }

  /**
   * Служба отказала ({@code 503}) или молчит — уходит та же пачка с теми же номерами: повтор у
   * службы ничего не удваивает. Новые факты встают за ней.
   */
  @Test
  void aRefusedBatchIsRetriedAsItWas() {
    var facts = facts();
    for (int i = 0; i < 3; i++) facts.fact("join").put("room", "r" + i).publish();
    answers.add(503);
    assertThat(facts.flush()).isZero();
    facts.fact("join").put("room", "late").publish();
    answers.add(new java.net.http.HttpTimeoutException("request timed out"));
    assertThat(facts.flush()).isZero();
    assertThat(facts.buffered()).isEqualTo(4);
    assertThat(facts.flush()).isEqualTo(4);
    assertThat(posted).hasSize(4);
    assertThat(posted.get(1)).isEqualTo(posted.get(0));
    assertThat(posted.get(2)).isEqualTo(posted.get(0));
    assertThat(factsOf(posted.get(3)))
        .singleElement()
        .satisfies(f -> assertThat(f.path("room").asText()).isEqualTo("late"));
    assertThat(counter("cord.insight.facts.failed")).isEqualTo(2);
    assertThat(counter("cord.insight.facts.sent")).isEqualTo(4);
    assertThat(counter("cord.insight.facts.dropped")).isZero();
  }

  /** Пачку, которую служба не примет никогда, повторять незачем: она не держит остальные. */
  @Test
  void aBatchTheServiceWillNeverTakeIsDropped() {
    var facts = facts();
    for (int i = 0; i < 600; i++) facts.fact("join").put("room", "r" + i).publish();
    answers.add(413);
    assertThat(facts.flush()).isEqualTo(100);
    assertThat(posted).hasSize(2);
    assertThat(facts.buffered()).isZero();
    assertThat(counter("cord.insight.facts.dropped")).isEqualTo(500);
  }

  /**
   * Буфер ограничен: сверх ста тысяч выбрасываются самые старые, со счётчиком. Пачка, которая уже в
   * полёте, остаётся собой — её повтор должен быть той же пачкой.
   */
  @Test
  void aFullBufferDropsTheOldestButNotTheBatchInFlight() {
    var facts = facts();
    for (int i = 0; i < 10; i++) facts.fact("join").put("room", "first-" + i).publish();
    answers.add(503);
    facts.flush();
    for (int i = 0; i < InsightFacts.BUFFER_LIMIT; i++)
      facts.fact("join").put("room", "next-" + i).publish();
    assertThat(facts.buffered()).isEqualTo(InsightFacts.BUFFER_LIMIT);
    assertThat(counter("cord.insight.facts.dropped")).isEqualTo(10);
    posted.clear();
    facts.flush();
    // Первой ушла пачка в полёте, за ней — что осталось в очереди: десять старейших из неё выпали.
    assertThat(factsOf(posted.get(0)))
        .hasSize(10)
        .allSatisfy(f -> assertThat(f.path("room").asText()).startsWith("first-"));
    assertThat(factsOf(posted.get(1)).getFirst().path("room").asText()).isEqualTo("next-10");
  }

  /** Адрес службы не задан — ничего не собирается и не шлётся. */
  @Test
  void withoutTheServiceNothingIsCollected() {
    var off = new InsightFacts(null, secrets(), clock(), registry);
    assertThat(off.enabled()).isFalse();
    off.fact("join").put("room", "r").publish();
    off.refused("RATE_LIMITED", 429);
    off.refusals();
    off.quality("r", null, new RxQuality.RxSummary(List.of()));
    assertThat(off.buffered()).isZero();
    assertThat(off.flush()).isZero();
  }

  /** Отказы защиты — итогом минуты на код, а не фактом на каждый; прочие отказы сюда не идут. */
  @Test
  void guardRefusalsLeaveAsMinuteTotals() {
    var facts = facts();
    for (int i = 0; i < 300; i++) facts.refused("RATE_LIMITED", 429);
    facts.refused("PROOF_INVALID", 403);
    facts.refused("BLOCKED", 403);
    facts.refused("OPEN_ROOMS", 429);
    // Не защита: чужой пропуск, нет встречи, занятая сцена.
    facts.refused("FORBIDDEN", 403);
    facts.refused("ROOM_NOT_FOUND", 404);
    facts.refused("INTEGRATION_BUSY", 409);
    assertThat(facts.buffered()).isZero();
    facts.refusals();
    facts.flush();
    var totals = new HashMap<String, Long>();
    for (var fact : factsOf(posted.getFirst())) {
      assertThat(fact.path("type").asText()).isEqualTo("refusal");
      totals.put(fact.path("code").asText(), fact.path("count").asLong());
    }
    assertThat(totals)
        .containsOnly(
            Map.entry("RATE_LIMITED", 300L),
            Map.entry("PROOF_INVALID", 1L),
            Map.entry("BLOCKED", 1L),
            Map.entry("OPEN_ROOMS", 1L));
    // Минута без отказов — фактов нет.
    facts.refusals();
    assertThat(facts.buffered()).isZero();
  }

  /**
   * Псевдоним профиля — по формуле контракта (§4): {@code base64url(HMAC-SHA256(SESSION_SECRET,
   * "analytics:" + hex(SHA-256(секрет профиля))))} без {@code =}. Служба считает его так же из
   * событий клиента — сойтись они обязаны.
   */
  @Test
  void theProfilePseudonymFollowsTheContractFormula() throws Exception {
    var secret = "A".repeat(43);
    var hash =
        HexFormat.of()
            .formatHex(
                MessageDigest.getInstance("SHA-256")
                    .digest(secret.getBytes(StandardCharsets.UTF_8)));
    var mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(SESSION_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    var expected =
        Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString(mac.doFinal(("analytics:" + hash).getBytes(StandardCharsets.UTF_8)));
    var facts = facts();
    assertThat(facts.pseudonym(Secrets.hash(secret))).isEqualTo(expected).hasSize(43);
    assertThat(facts.pseudonym(null)).isNull();
    facts.fact("join").profile(Secrets.hash(secret)).publish();
    facts.fact("join").profile(null).publish();
    facts.flush();
    var sent = factsOf(posted.getFirst());
    assertThat(sent.get(0).path("profile").asText()).isEqualTo(expected);
    // «Профиля нет» — явным null, как в контракте.
    assertThat(sent.get(1).has("profile")).isTrue();
    assertThat(sent.get(1).path("profile").isNull()).isTrue();
    assertThat(posted.getFirst()).doesNotContain(secret).doesNotContain(hash);
  }

  /** Факт качества: секунды камеры и показа из отдачи, байты вверх и вниз — если клиент прислал. */
  @Test
  void theQualityFactCarriesPublishSecondsAndBytes() {
    var facts = facts();
    var camera = new RxQuality.TxTrack("camera", "vp9", "hw", 9.6, 0, 0, 0);
    var screen = new RxQuality.TxTrack("screen", "av1", "sw", 4.2, 0, 0, 0);
    facts.quality(
        "room-1",
        null,
        new RxQuality.RxSummary(List.of(), List.of(camera, screen), null, 1_250_000L, 9_000_000L));
    facts.quality("room-1", null, new RxQuality.RxSummary(List.of()));
    facts.flush();
    var sent = factsOf(posted.getFirst());
    var full = sent.get(0);
    assertThat(full.path("type").asText()).isEqualTo("quality");
    assertThat(full.path("room").asText()).isEqualTo("room-1");
    assertThat(full.path("cam_s").asDouble()).isEqualTo(9.6);
    assertThat(full.path("screen_s").asDouble()).isEqualTo(4.2);
    assertThat(full.path("bytes_up").asLong()).isEqualTo(1_250_000L);
    assertThat(full.path("bytes_down").asLong()).isEqualTo(9_000_000L);
    // Старый клиент байт не шлёт — полей нет, а не нули.
    assertThat(sent.get(1).has("bytes_up")).isFalse();
    assertThat(sent.get(1).has("bytes_down")).isFalse();
  }
}
