package dev.mikki.stream.nodes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import dev.mikki.stream.config.StreamProperties;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class MediaNodesTest {
  static final String REGISTRY =
      """
      {"format":"cord.nodes/1","nodes":[
        {"id":"hel","index":1,"title":{"ru":"Хельсинки","en":"Helsinki"},"ip":"152.234.227.199",
         "rtcUrl":"wss://rtc-hel.callcord.ru","probeUrl":"https://hel.callcord.ru",
         "stun":"stun:turn-hel.callcord.ru:3478","internalUrl":"http://127.0.0.1:21000","maxRooms":2,"enabled":true,
         "country":"fi","uplinkMbps":500,"cores":2,"loadUrl":"http://127.0.0.1:21002/metrics",
         "sfuMetricsUrl":"http://127.0.0.1:21001/metrics","sfuMemoryMb":2048,
         "ssh":"root@152.234.227.199"},
        {"id":"fra","control":true,"title":{"ru":"Франкфурт"},"rtcUrl":"wss://callcord.ru",
         "probeUrl":"https://callcord.ru","stun":"stun:turn.callcord.ru:3478",
         "internalUrl":"http://127.0.0.1:7880","maxRooms":8,"enabled":true}
      ]}
      """;

  @TempDir Path dir;
  final AtomicLong now = new AtomicLong(1_000_000);
  final Clock clock = mock(Clock.class);

  StreamProperties config() {
    var config = mock(StreamProperties.class);
    when(config.nodeId()).thenReturn("fra");
    when(config.livekitUrl()).thenReturn("wss://one.example");
    when(config.livekitInternalUrl()).thenReturn("http://127.0.0.1:7880");
    when(config.publicUrl()).thenReturn("https://one.example");
    when(clock.millis()).thenAnswer(_ -> now.get());
    return config;
  }

  MediaNodes nodes(Path file) {
    return new MediaNodes(config(), file, clock, new SimpleMeterRegistry());
  }

  @Test
  void withoutARegistryThereIsOneImplicitNodeFromTheServerAddress() {
    var nodes = nodes(dir.resolve("missing.json"));
    assertThat(nodes.all()).hasSize(1);
    var only = nodes.control();
    assertThat(only.id()).isEqualTo("fra");
    assertThat(only.rtcUrl()).isEqualTo("wss://one.example");
    assertThat(nodes.resolve(null)).isEqualTo(only);
    assertThat(nodes.resolve("hel")).isEqualTo(only);
    assertThat(nodes.choose("hel").node()).isEqualTo(only);
    assertThat(nodes.choose("hel").reason()).isEqualTo("unknown-control");
  }

  @Test
  void registryIsReadControlFirstAndReloadedOnlyWhenTheFileChanges() throws Exception {
    var file = dir.resolve("registry.json");
    Files.writeString(file, REGISTRY);
    var nodes = nodes(file);
    assertThat(nodes.all()).extracting(MediaNode::id).containsExactly("fra", "hel");
    assertThat(nodes.control().id()).isEqualTo("fra");
    assertThat(nodes.resolve("hel").rtcUrl()).isEqualTo("wss://rtc-hel.callcord.ru");
    assertThat(nodes.resolve("hel").titleFor("ru")).isEqualTo("Хельсинки");
    assertThat(nodes.resolve("fra").titleFor("en")).isEqualTo("fra");
    // Неизвестное имя — узел управления: комнату не теряем.
    assertThat(nodes.resolve("msk").id()).isEqualTo("fra");

    // Правка файла видна не раньше, чем через период перечитывания, и только по новому mtime.
    Files.writeString(
        file,
        REGISTRY.replace("\"maxRooms\":2,\"enabled\":true", "\"maxRooms\":2,\"enabled\":false"));
    Files.setLastModifiedTime(file, java.nio.file.attribute.FileTime.fromMillis(2_000_000_000L));
    assertThat(nodes.resolve("hel").enabled()).isTrue();
    now.addAndGet(MediaNodes.RELOAD_MS);
    assertThat(nodes.resolve("hel").enabled()).isFalse();

    // Битый файл не роняет список: остаёмся на прошлом.
    Files.writeString(file, "{garbage");
    Files.setLastModifiedTime(file, java.nio.file.attribute.FileTime.fromMillis(2_000_000_001L));
    now.addAndGet(MediaNodes.RELOAD_MS);
    assertThat(nodes.all()).hasSize(2);
  }

  @Test
  void anUnreachableNodeTakesNoNewRoomsButIsNotDead() throws Exception {
    // Магистраль до узла молчит, его люди на связи (NodeHealth, Р-105): новые встречи — мимо него,
    // идущие остаются; для настроек он «недоступен», для эвакуации — нет.
    var file = dir.resolve("registry.json");
    Files.writeString(file, REGISTRY);
    var nodes = nodes(file);
    nodes.unreachable("hel", true);
    assertThat(nodes.isUnreachable("hel")).isTrue();
    assertThat(nodes.isDown("hel")).isFalse();
    assertThat(nodes.available()).extracting(MediaNode::id).containsExactly("fra");
    assertThat(nodes.choose("hel"))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("fra", "unreachable-control");
    assertThat(nodes.levelOf(nodes.resolve("hel")).state()).isEqualTo("down");
    nodes.unreachable("hel", false);
    assertThat(nodes.available()).extracting(MediaNode::id).containsExactly("fra", "hel");
    assertThat(nodes.choose("hel").reason()).isEqualTo("preferred");
  }

  @Test
  void capacityFieldsAreReadWithDefaultsForRegistriesWrittenBeforeR200() throws Exception {
    var file = dir.resolve("registry.json");
    Files.writeString(file, REGISTRY);
    var nodes = nodes(file);
    var hel = nodes.resolve("hel");
    assertThat(hel.country()).isEqualTo("FI");
    assertThat(hel.uplinkMbps()).isEqualTo(500);
    assertThat(hel.cores()).isEqualTo(2);
    assertThat(hel.loadUrl()).isEqualTo("http://127.0.0.1:21002/metrics");
    assertThat(hel.sfuMetricsUrl()).isEqualTo("http://127.0.0.1:21001/metrics");
    assertThat(hel.sfuMemoryMb()).isEqualTo(2048);
    // Старый реестр без полей: страны нет, канал и память SFU по умолчанию, ЦП не меряется.
    var fra = nodes.resolve("fra");
    assertThat(fra.country()).isNull();
    assertThat(fra.uplinkMbps()).isEqualTo(MediaNode.DEFAULT_UPLINK_MBPS);
    assertThat(fra.loadUrl()).isNull();
    assertThat(fra.sfuMetricsUrl()).isNull();
    assertThat(fra.sfuMemoryMb()).isEqualTo(MediaNode.DEFAULT_SFU_MEMORY_MB);
    assertThatThrownBy(
            () ->
                MediaNodes.parse(REGISTRY.replace("\"country\":\"fi\"", "\"country\":\"Finland\"")))
        .hasMessageContaining("ISO 3166");
  }

  // Р-135: выбор по задержке среди узлов с запасом, без пределов по числу встреч -----------------

  static MediaNodes.Sample cpu(double cpu) {
    return new MediaNodes.Sample(0, 0, cpu, 0, 0, Double.NaN, Double.NaN, Double.NaN);
  }

  static MediaNodes.Sample idle() {
    return cpu(0.05);
  }

  final MediaNodes.Measure hel12 = new MediaNodes.Measure("hel", 12, true);
  final MediaNodes.Measure fra41 = new MediaNodes.Measure("fra", 41, true);

  /**
   * Остыть: опросы ниже порога дольше {@link MediaNodes#COOL_AFTER_MS}, резерв истёк, ступень
   * опустилась.
   */
  void calm(MediaNodes nodes, String... ids) {
    for (var id : ids) nodes.load(id, idle());
    now.addAndGet(Math.max(MediaNodes.COOL_AFTER_MS, MediaNodes.RESERVE_MS));
    for (var id : ids) nodes.load(id, idle());
    now.addAndGet(MediaNodes.DOWN_AFTER_MS);
    for (var id : ids) nodes.load(id, idle());
  }

  @Test
  void choiceHonoursThePreferredNodeWhenItIsAliveEnabledAndHasHeadroom() throws Exception {
    var file = dir.resolve("registry.json");
    Files.writeString(file, REGISTRY);
    var nodes = nodes(file);
    assertThat(nodes.choose("hel"))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("hel", "preferred");
    assertThat(nodes.choose(null))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("fra", "default-control");
    assertThat(nodes.choose("msk").reason()).isEqualTo("unknown-control");

    // Мёртвый узел в выборе не участвует; встреча — на живой.
    nodes.down("hel", true);
    assertThat(nodes.available()).extracting(MediaNode::id).containsExactly("fra");
    assertThat(nodes.choose("hel"))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("fra", "down-control");
    assertThat(nodes.choose("hel", List.of(hel12, fra41)).reason()).isEqualTo("down-measured");
    nodes.down("hel", false);

    // Все мёртвы — встреча всё равно куда-то ставится (на узел управления), а не отказ.
    nodes.down("hel", true);
    nodes.down("fra", true);
    assertThat(nodes.choose("hel"))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("fra", "down-all-down");
  }

  @Test
  void theNumberOfMeetingsOnANodeIsNoLimit() throws Exception {
    // В реестре hel — "maxRooms":2, но это поле больше ничего не значит (Р-135): тысяча встреч при
    // спокойном ЦП и канале — узел с запасом.
    var file = dir.resolve("registry.json");
    Files.writeString(file, REGISTRY);
    var nodes = nodes(file);
    nodes.load("hel", new MediaNodes.Sample(1000, 40, 0.2, 0, 50, 0.3, 0.2, 300));
    assertThat(nodes.hot("hel")).isFalse();
    assertThat(nodes.levelOf(nodes.resolve("hel")).state()).isNotEqualTo("full");
    for (int i = 0; i < 3; i++)
      assertThat(nodes.choose("hel", List.of(hel12, fra41)))
          .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
          .containsExactly("hel", "preferred");
  }

  @Test
  void aHotPreferredNodeSendsTheMeetingToTheNextNearestWithHeadroom() throws Exception {
    var file = dir.resolve("registry.json");
    Files.writeString(file, REGISTRY);
    var nodes = nodes(file);
    // hel ближе (12 мс против 41), но горячий по ЦП — встреча идёт на следующий ближайший.
    nodes.load("hel", cpu(0.75));
    assertThat(nodes.hot("hel")).isTrue();
    assertThat(nodes.levelOf(nodes.resolve("hel"))).isEqualTo(new MediaNodes.Level(4, "full"));
    assertThat(nodes.decide("hel", List.of(hel12, fra41)))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("fra", "preferred-hot-measured");
    // Без замеров — узел управления; ближайший среди нескольких — по UDP впереди TCP, потом мс.
    assertThat(nodes.decide("hel", List.of()).reason()).isEqualTo("preferred-hot-control");
    nodes.load("hel", idle());
    nodes.load("fra", idle());
    calm(nodes, "hel", "fra");
    assertThat(
            nodes
                .decide(
                    null,
                    List.of(
                        new MediaNodes.Measure("hel", 9, false),
                        new MediaNodes.Measure("fra", 30, true)))
                .node()
                .id())
        .isEqualTo("fra");
    assertThat(nodes.decide(null, List.of(hel12, fra41)))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("hel", "default-measured");
  }

  @Test
  void everyResourceCanMakeANodeHot() throws Exception {
    var file = dir.resolve("registry.json");
    Files.writeString(file, REGISTRY);
    var nodes = nodes(file);
    var nan = Double.NaN;
    // hel: 2 ядра, канал 500 Мбит/с, память SFU 2048 МиБ (реестр выше).
    record Case(String what, MediaNodes.Sample sample) {}
    for (var hot :
        List.of(
            new Case("cpu", new MediaNodes.Sample(1, 4, 0.71, 0, 10, 0.3, 0.3, 200)),
            new Case("egress", new MediaNodes.Sample(1, 4, 0.2, 0, 360, 0.3, 0.3, 200)),
            new Case("memory", new MediaNodes.Sample(1, 4, 0.2, 0, 10, 0.86, 0.3, 200)),
            new Case("sfu-memory", new MediaNodes.Sample(1, 4, 0.2, 0, 10, 0.3, 0.3, 1700)),
            new Case("disk", new MediaNodes.Sample(1, 4, 0.2, 0, 10, 0.3, 0.91, 200)),
            // Без node-exporter ЦП оценивается по людям: 2 ядра × 15 человек, порог 70 % — 21.
            new Case("cpu", new MediaNodes.Sample(3, 22, nan, nan, nan, nan, nan, nan)),
            // Без метрик SFU его память — по людям: 60 + 6 × 300 МиБ из 2048 — выше 80 %.
            new Case("sfu-memory", new MediaNodes.Sample(3, 300, 0.2, 0, 10, nan, nan, nan)))) {
      calm(nodes, "hel");
      assertThat(nodes.hot("hel")).as(hot.what() + " before").isFalse();
      nodes.load("hel", hot.sample());
      assertThat(nodes.hot("hel")).as(hot.what()).isTrue();
      assertThat(MediaNodes.pressure(nodes.resolve("hel"), hot.sample(), 0).by())
          .isEqualTo(hot.what());
    }
  }

  @Test
  void aHotNodeCoolsOnlyBelowSixtyPercentForThirtySeconds() throws Exception {
    var file = dir.resolve("registry.json");
    Files.writeString(file, REGISTRY);
    var meters = new SimpleMeterRegistry();
    var nodes = new MediaNodes(config(), file, clock, meters);
    nodes.load("hel", cpu(0.69));
    assertThat(nodes.hot("hel")).isFalse();
    nodes.load("hel", cpu(0.70));
    assertThat(nodes.hot("hel")).isTrue();
    assertThat(meters.get("cord.node.hot").tag("node", "hel").gauge().value()).isEqualTo(1);
    assertThat(meters.get("cord.node.pressure").tag("node", "hel").gauge().value())
        .isCloseTo(1.0, org.assertj.core.data.Offset.offset(0.001));
    // 65 % — ниже порога, но выше 60 %: всё ещё горячий, сколько бы ни прошло (гистерезис).
    nodes.load("hel", cpu(0.65));
    now.addAndGet(5 * MediaNodes.COOL_AFTER_MS);
    nodes.load("hel", cpu(0.65));
    assertThat(nodes.hot("hel")).isTrue();
    // 50 % — остывает, но только простояв так 30 с; всплеск до 62 % посреди — отсчёт заново.
    nodes.load("hel", cpu(0.5));
    now.addAndGet(MediaNodes.COOL_AFTER_MS - 1);
    nodes.load("hel", cpu(0.5));
    assertThat(nodes.hot("hel")).isTrue();
    nodes.load("hel", cpu(0.62));
    nodes.load("hel", cpu(0.5));
    now.addAndGet(MediaNodes.COOL_AFTER_MS - 1);
    nodes.load("hel", cpu(0.5));
    assertThat(nodes.hot("hel")).isTrue();
    now.addAndGet(1);
    nodes.load("hel", cpu(0.5));
    assertThat(nodes.hot("hel")).isFalse();
    assertThat(meters.get("cord.node.hot").tag("node", "hel").gauge().value()).isEqualTo(0);
  }

  @Test
  void levelFollowsThePressureUpAtOnceAndDownAfterThirtySeconds() throws Exception {
    var file = dir.resolve("registry.json");
    Files.writeString(file, REGISTRY);
    var meters = new SimpleMeterRegistry();
    var nodes = new MediaNodes(config(), file, clock, meters);
    assertThat(nodes.level("hel")).isEqualTo(1);
    assertThat(nodes.levelOf(nodes.resolve("hel"))).isEqualTo(new MediaNodes.Level(1, "ok"));
    // ЦП 30 % — меньше половины порога: ступень 2; 60 % — 3 («тесно»), но ещё не горячий.
    nodes.load("hel", cpu(0.3));
    assertThat(nodes.level("hel")).isEqualTo(2);
    nodes.load("hel", cpu(0.6));
    assertThat(nodes.level("hel")).isEqualTo(3);
    assertThat(nodes.levelOf(nodes.resolve("hel")).state()).isEqualTo("busy");
    assertThat(meters.get("cord.node.level").tag("node", "hel").gauge().value()).isEqualTo(3);
    // Горячий — 4 («full» для настроек: новые встречи идут к соседу).
    nodes.load("hel", cpu(0.8));
    assertThat(nodes.levelOf(nodes.resolve("hel"))).isEqualTo(new MediaNodes.Level(4, "full"));
    // Вниз — не сразу: остывание 30 с, потом ступень ещё 30 с.
    nodes.load("hel", cpu(0.1));
    now.addAndGet(MediaNodes.COOL_AFTER_MS);
    nodes.load("hel", cpu(0.1));
    assertThat(nodes.hot("hel")).isFalse();
    assertThat(nodes.level("hel")).isEqualTo(4);
    now.addAndGet(MediaNodes.DOWN_AFTER_MS);
    nodes.load("hel", cpu(0.1));
    assertThat(nodes.level("hel")).isEqualTo(1);
    // steal выше четверти — не ниже 3.
    nodes.load("fra", new MediaNodes.Sample(0, 0, 0.3, 0.3, 10, 0.2, 0.2, 100));
    assertThat(nodes.level("fra")).isEqualTo(3);
    // Мёртвый и дренируемый — своим словом, какой бы ни была ступень.
    nodes.down("hel", true);
    assertThat(nodes.levelOf(nodes.resolve("hel")).state()).isEqualTo("down");
    nodes.down("hel", false);
    Files.writeString(
        file,
        REGISTRY.replace("\"maxRooms\":2,\"enabled\":true", "\"maxRooms\":2,\"enabled\":false"));
    Files.setLastModifiedTime(file, java.nio.file.attribute.FileTime.fromMillis(2_000_000_000L));
    now.addAndGet(MediaNodes.RELOAD_MS);
    assertThat(nodes.levelOf(nodes.resolve("hel")).state()).isEqualTo("drained");
  }

  @Test
  void aBurstOfMeetingsSpillsOverBeforeTheMetricsCatchUp() throws Exception {
    // Пачка встреч за секунды: метрики узла их ещё не видят, но каждая резервирует 0,1 ядра и
    // 25 Мбит/с на минуту — hel (2 ядра) заполняется до порога, остальное уходит на fra.
    var file = dir.resolve("registry.json");
    Files.writeString(
        file,
        REGISTRY.replace(
            "\"internalUrl\":\"http://127.0.0.1:7880\",\"maxRooms\":8,\"enabled\":true}",
            "\"internalUrl\":\"http://127.0.0.1:7880\",\"maxRooms\":8,\"enabled\":true,\"cores\":6}"));
    var nodes = nodes(file);
    nodes.load("hel", cpu(0.2));
    nodes.load("fra", cpu(0.2));
    var placed = new java.util.HashMap<String, Integer>();
    for (int i = 0; i < 30; i++)
      placed.merge(nodes.choose("hel", List.of(hel12, fra41)).node().id(), 1, Integer::sum);
    // hel: (0,2 + n × 0,05) / 0,7 < 1 → до 9 встреч; остальные — на fra.
    assertThat(placed.get("hel")).isEqualTo(9);
    assertThat(placed.get("fra")).isEqualTo(21);
    // Резерв живёт минуту: после неё hel снова ближайший с запасом.
    now.addAndGet(MediaNodes.RESERVE_MS);
    assertThat(nodes.choose("hel", List.of(hel12, fra41)).node().id()).isEqualTo("hel");
  }

  @Test
  void whenEveryNodeIsHotTheMeetingStillGoesToTheLeastLoaded() throws Exception {
    var file = dir.resolve("registry.json");
    Files.writeString(file, REGISTRY);
    var meters = new SimpleMeterRegistry();
    var nodes = new MediaNodes(config(), file, clock, meters);
    assertThat(meters.get("cord.nodes.saturated").gauge().value()).isEqualTo(0);
    nodes.load("hel", cpu(0.95));
    nodes.load("fra", cpu(0.80));
    assertThat(nodes.saturated()).isTrue();
    assertThat(meters.get("cord.nodes.saturated").gauge().value()).isEqualTo(1);
    // Отказа нет: наименее загруженный (fra), даже если создатель ближе к hel.
    assertThat(nodes.choose("hel", List.of(hel12, fra41)))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("fra", "preferred-hot-saturated");
    assertThat(
            meters
                .get("cord.node.choice")
                .tag("reason", "preferred-hot-saturated")
                .counter()
                .count())
        .isEqualTo(1);
    // Узел умер — остальные всё равно горячие, встреча на живом.
    nodes.down("fra", true);
    assertThat(nodes.choose(null).node().id()).isEqualTo("hel");
    assertThat(nodes.saturated()).isTrue();
    nodes.down("fra", false);
    // Один остыл — запас снова есть, «saturated» гаснет.
    calm(nodes, "hel");
    assertThat(nodes.saturated()).isFalse();
    assertThat(nodes.choose(null, List.of(hel12, fra41)).reason()).isEqualTo("default-measured");
  }

  @Test
  void aSingleImplicitNodeTakesEveryMeetingWhateverItsLoad() {
    var nodes = nodes(dir.resolve("missing.json"));
    var only = nodes.control();
    var measures = List.of(new MediaNodes.Measure("fra", 5, true));
    for (var sample :
        List.of(
            idle(), cpu(0.5), cpu(0.99), new MediaNodes.Sample(500, 3000, 0.2, 0, 1, 0, 0, 1))) {
      nodes.load("fra", sample);
      assertThat(nodes.decide("fra", measures).node()).isEqualTo(only);
      assertThat(nodes.decide(null, List.of()).node()).isEqualTo(only);
      assertThat(nodes.decide("hel", measures).node()).isEqualTo(only);
    }
    // Узел горячий — причина говорит «запаса нет», но встреча создаётся.
    nodes.load("fra", cpu(0.99));
    assertThat(nodes.decide(null, List.of()).reason()).isEqualTo("default-saturated");
    calm(nodes, "fra");
    assertThat(nodes.decide(null, List.of()).reason()).isEqualTo("default-control");
    assertThat(nodes.decide("fra", measures).reason()).isEqualTo("preferred");
    assertThat(nodes.decide("hel", measures).reason()).isEqualTo("unknown-measured");
    assertThat(nodes.levelOf(only).state()).isEqualTo("ok");
    assertThat(nodes.available()).hasSize(1);
  }

  @Test
  void registryWhoseControlNodeIsNotThisServerIsIgnoredLoudly() throws Exception {
    var file = dir.resolve("registry.json");
    Files.writeString(
        file,
        REGISTRY.replace("\"id\":\"fra\",\"control\":true", "\"id\":\"ams\",\"control\":true"));
    var meters = new SimpleMeterRegistry();
    var nodes = new MediaNodes(config(), file, clock, meters);
    // Реестр не про этот сервер (NODE_ID=fra, в файле управление — ams): ядро живёт одним неявным
    // узлом.
    assertThat(nodes.all()).extracting(MediaNode::id).containsExactly("fra");
    assertThat(nodes.control().rtcUrl()).isEqualTo("wss://one.example");
    assertThat(nodes.resolve("hel").id()).isEqualTo("fra");
    assertThat(meters.get("cord.node.registry.ignored").gauge().value()).isEqualTo(1);
    // Файл поправили — подхватывается на следующем перечитывании, метрика гаснет.
    Files.writeString(file, REGISTRY);
    Files.setLastModifiedTime(file, java.nio.file.attribute.FileTime.fromMillis(2_000_000_000L));
    now.addAndGet(MediaNodes.RELOAD_MS);
    assertThat(nodes.all()).extracting(MediaNode::id).containsExactly("fra", "hel");
    assertThat(meters.get("cord.node.registry.ignored").gauge().value()).isEqualTo(0);
  }

  @Test
  void registryMustHaveExactlyOneControlNodeAndUniqueIds() {
    assertThatThrownBy(() -> MediaNodes.parse(REGISTRY.replace("\"control\":true,", "")))
        .hasMessageContaining("control");
    assertThatThrownBy(() -> MediaNodes.parse(REGISTRY.replace("\"id\":\"hel\"", "\"id\":\"fra\"")))
        .hasMessageContaining("twice");
    assertThatThrownBy(() -> MediaNodes.parse("{\"format\":\"other\",\"nodes\":[]}"))
        .hasMessageContaining("format");
    assertThatThrownBy(() -> MediaNodes.parse(REGISTRY.replace("\"id\":\"hel\"", "\"id\":\"Hel\"")))
        .isInstanceOf(Exception.class);
  }
}
