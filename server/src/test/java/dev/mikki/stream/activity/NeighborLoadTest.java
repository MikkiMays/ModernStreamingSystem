package dev.mikki.stream.activity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.net.http.HttpClient;
import java.nio.file.Files;
import java.time.Clock;
import java.util.Base64;
import org.junit.jupiter.api.Test;

/** Соседи по каталогу (R143): свой — из замера, без ответа — «unknown», а не ошибка. */
class NeighborLoadTest {
  @Test
  void selfComesFromTheMeterAndAnUnreachableNeighbourIsUnknown() throws Exception {
    var payload =
        Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString(
                "{\"servers\":[{\"url\":\"https://cord.example/\"},{\"url\":\"https://127.0.0.1:1/\"},{\"url\":\"ftp://bad/\"}]}"
                    .getBytes());
    var file = Files.createTempFile("catalog", ".jws");
    Files.writeString(file, "{\"payload\":\"" + payload + "\",\"signatures\":[]}");
    var clock = mock(Clock.class);
    when(clock.millis()).thenReturn(1000L);
    var neighbors = new NeighborLoad(file, clock, HttpClient.newHttpClient());
    assertThat(neighbors.servers())
        .containsExactly("https://cord.example/", "https://127.0.0.1:1/");
    var all = neighbors.all("https://cord.example", new LoadMeter.Load(2, "ok", 900));
    assertThat(all.get(0))
        .isEqualTo(new NeighborLoad.CatalogLoad("https://cord.example/", 2, "ok", 900));
    assertThat(all.get(1))
        .extracting(NeighborLoad.CatalogLoad::level, NeighborLoad.CatalogLoad::state)
        .containsExactly(0, "unknown");
  }

  @Test
  void noCatalogMeansNoServers() {
    var neighbors =
        new NeighborLoad(
            java.nio.file.Path.of("/nonexistent"), mock(Clock.class), HttpClient.newHttpClient());
    assertThat(neighbors.servers()).isEmpty();
  }
}
