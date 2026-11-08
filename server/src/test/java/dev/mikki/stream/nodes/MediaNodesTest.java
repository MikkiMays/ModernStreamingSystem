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
         "ssh":"root@152.234.227.199"},
        {"id":"fra","control":true,"title":{"ru":"Франкфурт"},"rtcUrl":"wss://cord.nikg.tech",
         "probeUrl":"https://cord.nikg.tech","stun":"stun:turn.cord.nikg.tech:3478",
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
