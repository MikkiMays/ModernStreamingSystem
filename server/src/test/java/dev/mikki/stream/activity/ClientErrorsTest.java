package dev.mikki.stream.activity;

import static org.assertj.core.api.Assertions.assertThat;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * Ошибки, которые видели люди (R180): только место и код из известных списков, всё прочее — {@code
 * other}; ни текста, ни адреса в метках не бывает.
 */
class ClientErrorsTest {
  final SimpleMeterRegistry registry = new SimpleMeterRegistry();
  final ClientErrors errors = new ClientErrors(registry, Set.of("ROOM_FULL", "CINEMA_GEO"));

  double count(String place, String code) {
    var counter =
        registry.find("cord.client.errors").tag("place", place).tag("code", code).counter();
    return counter == null ? 0 : counter.count();
  }

  @Test
  void countsKnownPlacesAndCodes() {
    errors.record(
        new ClientErrors.ErrorSummary(
            List.of(
                new ClientErrors.ErrorCount("camera", "denied", 3),
                new ClientErrors.ErrorCount("join", "ROOM_FULL", 1),
                new ClientErrors.ErrorCount("cinema", "CINEMA_GEO", 2))));
    assertThat(count("camera", "denied")).isEqualTo(3);
    assertThat(count("join", "ROOM_FULL")).isEqualTo(1);
    assertThat(count("cinema", "CINEMA_GEO")).isEqualTo(2);
  }

  @Test
  void unknownPlaceOrCodeIsOther() {
    errors.record(
        new ClientErrors.ErrorSummary(
            List.of(
                new ClientErrors.ErrorCount("https://example.org/secret", "denied", 1),
                new ClientErrors.ErrorCount("board", "Failed to fetch", 1),
                new ClientErrors.ErrorCount("board", "SOMETHING_NEW", 1))));
    assertThat(count("other", "denied")).isEqualTo(1);
    assertThat(count("board", "other")).isEqualTo(2);
    registry
        .find("cord.client.errors")
        .counters()
        .forEach(
            counter ->
                assertThat(counter.getId().getTags())
                    .allSatisfy(
                        tag ->
                            assertThat(tag.getValue())
                                .isIn(
                                    union(
                                        ClientErrors.PLACES,
                                        ClientErrors.KINDS,
                                        Set.of("ROOM_FULL", "CINEMA_GEO", "other")))));
  }

  /** Реестр, который сборка кладёт в jar, — тот же {@code contracts/errors.json}. */
  @Test
  void readsTheRegistryFromTheBuild() {
    var codes = ClientErrors.registryCodes();
    assertThat(codes).contains("ROOM_FULL", "SERVER_BUSY", "CINEMA_GEO");
  }

  /** Списки мест и видов — те же, что у клиента ({@code web/src/core/failure.ts}). */
  @Test
  void placesAndKindsMatchTheWebClient() throws Exception {
    var source = Files.readString(Path.of("..", "web", "src", "core", "failure.ts"));
    assertThat(list(source, "PLACES")).isEqualTo(ClientErrors.PLACES);
    assertThat(list(source, "KINDS")).isEqualTo(ClientErrors.KINDS);
  }

  static Set<String> list(String source, String name) {
    var block =
        Pattern.compile("export const " + name + " = \\[(.*?)\\] as const", Pattern.DOTALL)
            .matcher(source);
    assertThat(block.find()).isTrue();
    var words = new HashSet<String>();
    var word = Pattern.compile("'([a-z-]+)'").matcher(block.group(1));
    while (word.find()) words.add(word.group(1));
    return words;
  }

  @SafeVarargs
  static Set<String> union(Set<String>... sets) {
    var all = new HashSet<String>();
    for (var set : sets) all.addAll(set);
    return all;
  }
}
