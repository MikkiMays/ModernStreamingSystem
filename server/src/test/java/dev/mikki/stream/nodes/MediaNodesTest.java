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
    when(config.maxRooms()).thenReturn(8);
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
  void choiceHonoursThePreferredNodeWhenItIsAliveEnabledAndNotFull() throws Exception {
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

    nodes.down("hel", true);
    assertThat(nodes.available()).extracting(MediaNode::id).containsExactly("fra");
    assertThat(nodes.choose("hel"))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("fra", "down-control");
    nodes.down("hel", false);

    // Полный узел не берётся по предпочтению; полный узел управления уступает первому живому.
    nodes.rooms("hel", 2);
    assertThat(nodes.choose("hel"))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("fra", "preferred-full-control");
    nodes.rooms("hel", 1);
    nodes.rooms("fra", 8);
    assertThat(nodes.choose(null))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("hel", "default-first");

    // Все мёртвы — встреча всё равно куда-то ставится (на узел управления), а не отказ.
    nodes.down("hel", true);
    nodes.down("fra", true);
    assertThat(nodes.choose("hel"))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("fra", "down-all-down");
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
    // Старый реестр без полей: страны нет, канал по умолчанию, ЦП не меряется.
    var fra = nodes.resolve("fra");
    assertThat(fra.country()).isNull();
    assertThat(fra.uplinkMbps()).isEqualTo(MediaNode.DEFAULT_UPLINK_MBPS);
    assertThat(fra.loadUrl()).isNull();
    assertThatThrownBy(
            () ->
                MediaNodes.parse(REGISTRY.replace("\"country\":\"fi\"", "\"country\":\"Finland\"")))
        .hasMessageContaining("ISO 3166");
  }

  @Test
  void levelFollowsTheBusiestShareUpAtOnceAndDownAfterThirtySeconds() throws Exception {
    var file = dir.resolve("registry.json");
    Files.writeString(file, REGISTRY);
    var meters = new SimpleMeterRegistry();
    var nodes = new MediaNodes(config(), file, clock, meters);
    assertThat(nodes.level("hel")).isEqualTo(1);
    assertThat(nodes.levelOf(nodes.resolve("hel"))).isEqualTo(new MediaNodes.Level(1, "ok"));
    // Одна встреча из двух — половина мест: ступень 3 («тесно»).
    nodes.load("hel", 1, 2, Double.NaN, Double.NaN, Double.NaN);
    assertThat(nodes.level("hel")).isEqualTo(3);
    assertThat(nodes.levelOf(nodes.resolve("hel")).state()).isEqualTo("busy");
    assertThat(meters.get("cord.node.level").tag("node", "hel").gauge().value()).isEqualTo(3);
    // Люди: 9 из 12 — ступень 4 без полных мест.
    nodes.load("hel", 1, 9, Double.NaN, Double.NaN, Double.NaN);
    assertThat(nodes.level("hel")).isEqualTo(4);
    assertThat(nodes.levelOf(nodes.resolve("hel")).state()).isEqualTo("full");
    // Вниз — не сразу: ступень держится 30 с.
    nodes.load("hel", 0, 0, 0.1, 0.0, 10);
    assertThat(nodes.level("hel")).isEqualTo(4);
    now.addAndGet(MediaNodes.DOWN_AFTER_MS - 1);
    nodes.load("hel", 0, 0, 0.1, 0.0, 10);
    assertThat(nodes.level("hel")).isEqualTo(4);
    now.addAndGet(1);
    nodes.load("hel", 0, 0, 0.1, 0.0, 10);
    assertThat(nodes.level("hel")).isEqualTo(1);
    // ЦП и канал узла: 60 % ЦП — ступень 3; 400 из 500 Мбит/с — ступень 4; steal выше четверти — не
    // ниже 3.
    nodes.load("hel", 0, 0, 0.6, 0.0, 10);
    assertThat(nodes.level("hel")).isEqualTo(3);
    nodes.load("hel", 0, 0, 0.1, 0.0, 400);
    assertThat(nodes.level("hel")).isEqualTo(4);
    nodes.load("fra", 0, 0, 0.1, 0.3, 10);
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
  void aBusyPreferredNodeYieldsOnlyToAFreeNodeWithinTwentyMilliseconds() throws Exception {
    var file = dir.resolve("registry.json");
    Files.writeString(file, REGISTRY);
    var nodes = nodes(file);
    var hel = new MediaNodes.Measure("hel", 12, true);
    var fraNear = new MediaNodes.Measure("fra", 25, true);
    var fraFar = new MediaNodes.Measure("fra", 41, true);

    // Свободный предпочтительный узел берётся всегда, даже если сосед не хуже.
    assertThat(nodes.decide("hel", List.of(hel, fraNear)).reason()).isEqualTo("preferred");

    // Тесно на hel (ступень 3), fra свободен и не дальше 20 мс — встреча идёт на fra.
    nodes.load("hel", 1, 2, Double.NaN, Double.NaN, Double.NaN);
    assertThat(nodes.decide("hel", List.of(hel, fraNear)))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("fra", "preferred-busy");
    // Тот же fra в 41 мс — слишком далеко: лучше тесно, чем далеко (создатель мерил не зря).
    assertThat(nodes.decide("hel", List.of(hel, fraFar)))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("hel", "preferred");
    // Без замеров сравнивать нечего — предпочтение уважается.
    assertThat(nodes.decide("hel", List.of()).reason()).isEqualTo("preferred");

    // Сосед со ступенью ≤ 2, но без запаса под ещё одну встречу (прогноз людей > 75 %), — не
    // замена.
    nodes.load("fra", 4, 0, Double.NaN, Double.NaN, Double.NaN); // 4 из 8 — ступень 3
    nodes.load("hel", 0, 5, Double.NaN, Double.NaN, Double.NaN); // 5 из 12 — ступень 2, но (5+6)/12
    now.addAndGet(MediaNodes.DOWN_AFTER_MS);
    nodes.load("hel", 0, 5, Double.NaN, Double.NaN, Double.NaN);
    assertThat(nodes.level("hel")).isEqualTo(2);
    assertThat(nodes.headroom(nodes.resolve("hel"))).isFalse();
    assertThat(nodes.decide("fra", List.of(hel, fraNear)))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("fra", "preferred");
    nodes.load("hel", 0, 2, Double.NaN, Double.NaN, Double.NaN); // запас есть: (2+6)/12
    assertThat(nodes.decide("fra", List.of(hel, fraNear)))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("hel", "preferred-busy");

    // Ступень 4 без полных мест (люди) — узел не берётся вовсе: лучший по замеру среди остальных.
    nodes.load("fra", 0, 0, Double.NaN, Double.NaN, Double.NaN);
    now.addAndGet(MediaNodes.DOWN_AFTER_MS);
    nodes.load("fra", 0, 0, Double.NaN, Double.NaN, Double.NaN);
    nodes.load("hel", 1, 9, Double.NaN, Double.NaN, Double.NaN);
    assertThat(nodes.decide("hel", List.of(hel, fraFar)))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("fra", "preferred-level-measured");
    // Полный по встречам — как и раньше, но с замерами причина говорит, что выбирали по пути.
    nodes.load("hel", 2, 2, Double.NaN, Double.NaN, Double.NaN);
    assertThat(nodes.decide("hel", List.of(hel, fraFar)).reason())
        .isEqualTo("preferred-full-measured");
    assertThat(nodes.decide("hel", List.of()).reason()).isEqualTo("preferred-full-control");
    // Мёртвый предпочтительный с замерами — лучший по пути из живых, UDP впереди TCP.
    nodes.down("hel", true);
    assertThat(nodes.decide("hel", List.of(hel, new MediaNodes.Measure("fra", 30, false))))
        .extracting(c -> c.node().id(), MediaNodes.Choice::reason)
        .containsExactly("fra", "down-measured");
  }

  @Test
  void aSingleImplicitNodeBehavesExactlyAsBeforeWhateverItsLoad() {
    var nodes = nodes(dir.resolve("missing.json"));
    var only = nodes.control();
    var measures = List.of(new MediaNodes.Measure("fra", 5, true));
    // Пусто, тесно, полно по людям, полно по встречам — встреча всегда на единственном узле.
    for (int[] load : new int[][] {{0, 0}, {4, 20}, {2, 48}, {8, 48}}) {
      nodes.load("fra", load[0], load[1], Double.NaN, Double.NaN, Double.NaN);
      assertThat(nodes.decide("fra", measures).node()).isEqualTo(only);
      assertThat(nodes.decide(null, List.of()).node()).isEqualTo(only);
      assertThat(nodes.decide("hel", measures).node()).isEqualTo(only);
    }
    assertThat(nodes.decide(null, List.of()).reason()).isEqualTo("default-control-full");
    nodes.load("fra", 0, 0, Double.NaN, Double.NaN, Double.NaN);
    assertThat(nodes.decide(null, List.of()).reason()).isEqualTo("default-control");
    now.addAndGet(MediaNodes.DOWN_AFTER_MS);
    nodes.load("fra", 0, 0, Double.NaN, Double.NaN, Double.NaN);
    assertThat(nodes.decide("fra", measures).reason()).isEqualTo("preferred");
    assertThat(nodes.decide("hel", measures).reason()).isEqualTo("unknown-measured");
    // Ступень видна, но capabilities узлов не показывают (как в 1.2.1): мерить один узел незачем.
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
