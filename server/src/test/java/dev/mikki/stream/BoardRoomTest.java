package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.JsonNode;
import dev.mikki.stream.board.BoardProperties;
import dev.mikki.stream.board.BoardRoom;
import dev.mikki.stream.board.Ephemeral;
import dev.mikki.stream.shared.Json;
import java.util.*;
import org.junit.jupiter.api.Test;

/**
 * Сцена доски в памяти ядра (R159): слияние элементов «последний побеждает» по {@code version} и
 * {@code versionNonce} — той же формулой, что {@code reconcileElements} Excalidraw, — отметки
 * удалённых, пределы, номер правки и возврат по {@code since}, очистка новым поколением.
 */
class BoardRoomTest {
  static String el(String id, long version, long nonce) {
    return el(id, version, nonce, false, "rectangle", "");
  }

  static String el(
      String id, long version, long nonce, boolean deleted, String type, String extra) {
    return "{\"id\":\""
        + id
        + "\",\"type\":\""
        + type
        + "\",\"version\":"
        + version
        + ",\"versionNonce\":"
        + nonce
        + ",\"isDeleted\":"
        + deleted
        + ",\"x\":10,\"y\":20,\"width\":30,\"height\":40,\"index\":\"a0\""
        + extra
        + "}";
  }

  static JsonNode batch(String... elements) {
    return Json.tree("[" + String.join(",", elements) + "]");
  }

  static BoardRoom room() {
    return new BoardRoom("room", BoardProperties.defaults());
  }

  static BoardRoom room(int maxElements, int maxIds, long maxSceneBytes, int maxFiles) {
    var d = BoardProperties.defaults();
    return new BoardRoom(
        "room",
        new BoardProperties(
            maxElements,
            maxIds,
            maxSceneBytes,
            d.maxElementBytes(),
            d.maxMessageBytes(),
            maxFiles,
            d.maxFileBytes(),
            3,
            d.ringBytes(),
            d.outboxBytes(),
            d.flushMs(),
            d.idleMs(),
            d.sendTimeoutMs()));
  }

  static Map<String, JsonNode> scene(BoardRoom room) {
    var map = new LinkedHashMap<String, JsonNode>();
    for (var node : Json.tree(room.scene().elements())) map.put(node.path("id").asText(), node);
    return map;
  }

  @Test
  void higherVersionWinsAndEqualVersionGoesToTheLowerNonce() {
    var room = room();
    assertThat(room.apply(batch(el("a", 1, 50)), "anna").accepted()).isEqualTo(1);
    // Старая версия проигрывает — и автор получает победителя.
    var older = room.apply(batch(el("a", 1, 70)), "boris");
    assertThat(older.batch()).isNull();
    assertThat(older.stale()).singleElement().asString().contains("\"versionNonce\":50");
    // Та же версия, меньший nonce — побеждает, как у reconcileElements.
    assertThat(room.apply(batch(el("a", 1, 10)), "boris").accepted()).isEqualTo(1);
    assertThat(scene(room).get("a").path("versionNonce").asLong()).isEqualTo(10);
    // Больше версия — побеждает при любом nonce.
    assertThat(room.apply(batch(el("a", 2, 999)), "anna").accepted()).isEqualTo(1);
    assertThat(scene(room).get("a").path("version").asLong()).isEqualTo(2);
    // Ровно то же самое — не правка: номер не растёт, отказа нет.
    long seq = room.seq();
    var same = room.apply(batch(el("a", 2, 999)), "boris");
    assertThat(same.batch()).isNull();
    assertThat(same.stale()).isEmpty();
    assertThat(room.seq()).isEqualTo(seq);
  }

  @Test
  void concurrentEditsConvergeWhateverTheOrder() {
    var one = room();
    var two = room();
    var edits = List.of(el("a", 3, 5), el("a", 3, 2), el("a", 2, 1), el("b", 1, 9), el("b", 4, 8));
    for (var edit : edits) one.apply(batch(edit), "x");
    var reversed = new ArrayList<>(edits);
    Collections.reverse(reversed);
    for (var edit : reversed) two.apply(batch(edit), "y");
    assertThat(scene(one)).isEqualTo(scene(two));
    assertThat(scene(one).get("a").path("versionNonce").asLong()).isEqualTo(2);
    assertThat(scene(one).get("b").path("version").asLong()).isEqualTo(4);
  }

  @Test
  void deletionKeepsATraceWithoutTheHeavyPoints() {
    var room = room();
    var points = new StringBuilder("[[0,0]");
    for (int i = 1; i < 500; i++)
      points.append(",[").append(i).append(',').append(i * 2).append(']');
    points.append(']');
    var stroke = ",\"points\":" + points + ",\"pressures\":[0.5,0.5]";
    room.apply(batch(el("s", 1, 1, false, "freedraw", stroke)), "anna");
    assertThat(room.live()).isEqualTo(1);
    room.apply(batch(el("s", 2, 1, true, "freedraw", stroke)), "anna");
    assertThat(room.live()).isZero();
    var trace = scene(room).get("s");
    assertThat(trace.path("isDeleted").asBoolean()).isTrue();
    assertThat(trace.path("points")).hasSize(2);
    assertThat(trace.path("points").get(1).get(0).asInt()).isEqualTo(499);
    assertThat(trace.path("pressures")).isEmpty();
    // Старая копия вернувшегося без сети не воскрешает удалённое.
    assertThat(room.apply(batch(el("s", 1, 0, false, "freedraw", stroke)), "boris").batch())
        .isNull();
    assertThat(room.live()).isZero();
    // А отмена удаления у автора — новая версия — возвращает элемент.
    room.apply(batch(el("s", 3, 1, false, "freedraw", stroke)), "anna");
    assertThat(room.live()).isEqualTo(1);
  }

  @Test
  void embedsScriptsAndBrokenElementsAreRefusedOneByOne() {
    var room = room();
    var applied =
        room.apply(
            batch(
                el("ok", 1, 1),
                el("frame", 1, 1, false, "embeddable", ",\"link\":\"https://youtube.com/x\""),
                el("js", 1, 1, false, "rectangle", ",\"link\":\"javascript:alert(1)\""),
                "{\"id\":\"no version\",\"type\":\"rectangle\"}",
                el("bad id!", 1, 1),
                el("link", 1, 1, false, "text", ",\"link\":\"https://cord.example/x\"")),
            "anna");
    assertThat(applied.accepted()).isEqualTo(2);
    assertThat(applied.rejected())
        .extracting(BoardRoom.Rejected::code)
        .containsOnly("BOARD_INVALID")
        .hasSize(4);
    assertThat(scene(room)).containsOnlyKeys("ok", "link");
  }

  @Test
  void limitsRefuseGrowthButNotDeletion() {
    var room = room(2, 3, 1 << 20, 32);
    room.apply(batch(el("a", 1, 1), el("b", 1, 1)), "anna");
    var full = room.apply(batch(el("c", 1, 1)), "anna");
    assertThat(full.rejected()).extracting(BoardRoom.Rejected::code).containsExactly("BOARD_FULL");
    // Удалить можно всегда; освободившееся место — снова место.
    assertThat(room.apply(batch(el("a", 2, 1, true, "rectangle", "")), "anna").accepted())
        .isEqualTo(1);
    assertThat(room.apply(batch(el("c", 1, 1)), "anna").accepted()).isEqualTo(1);
    // Но следы тоже считаются в maxIds: четвёртого нового элемента не будет.
    room.apply(batch(el("b", 2, 1, true, "rectangle", "")), "anna");
    assertThat(room.apply(batch(el("d", 1, 1)), "anna").rejected())
        .extracting(BoardRoom.Rejected::code)
        .containsExactly("BOARD_FULL");

    var small = room(100, 100, 600, 32);
    var big = ",\"text\":\"" + "я".repeat(150) + "\"";
    assertThat(small.apply(batch(el("t", 1, 1, false, "text", big)), "anna").accepted())
        .isEqualTo(1);
    assertThat(small.apply(batch(el("u", 1, 1, false, "text", big)), "anna").rejected())
        .extracting(BoardRoom.Rejected::code)
        .containsExactly("BOARD_FULL");
  }

  @Test
  void tooLargeElementIsRefused() {
    var room = room();
    var huge = ",\"text\":\"" + "x".repeat(70_000) + "\"";
    assertThat(room.apply(batch(el("t", 1, 1, false, "text", huge)), "anna").rejected())
        .extracting(BoardRoom.Rejected::code)
        .containsExactly("BOARD_INVALID");
  }

  @Test
  void sinceReplaysOnlyWhatWasMissedOrAsksForTheWholeScene() {
    var room = room(100, 100, 1 << 20, 32); // кольцо — три пачки
    long epoch = room.epoch();
    for (int i = 1; i <= 5; i++) room.apply(batch(el("e" + i, 1, 1)), "anna");
    assertThat(room.seq()).isEqualTo(5);
    assertThat(room.since(epoch, 5)).contains(List.of());
    assertThat(room.since(epoch, 3).orElseThrow())
        .extracting(BoardRoom.Batch::seq)
        .containsExactly(4L, 5L);
    assertThat(room.since(epoch, 2).orElseThrow()).hasSize(3);
    // Кольцо ушло вперёд, номер из будущего, чужое поколение — только вся сцена.
    assertThat(room.since(epoch, 1)).isEmpty();
    assertThat(room.since(epoch, 9)).isEmpty();
    assertThat(room.since(epoch + 1, 5)).isEmpty();
    assertThat(room.since(epoch, -1)).isEmpty();
  }

  @Test
  void clearStartsANewGenerationWithAnEmptyScene() {
    var room = room();
    room.apply(batch(el("a", 1, 1)), "anna");
    room.addFile(new BoardRoom.FileMeta("f1", "image/png", 10));
    long before = room.epoch();
    long seq = room.seq();
    assertThat(room.clear()).isEqualTo(before + 1);
    assertThat(room.seq()).isGreaterThan(seq);
    assertThat(scene(room)).isEmpty();
    assertThat(room.files()).isEmpty();
    assertThat(room.since(before, seq)).isEmpty();
    // После очистки тот же номер элемента — новый элемент, а не старая версия.
    assertThat(room.apply(batch(el("a", 1, 1)), "anna").accepted()).isEqualTo(1);
  }

  @Test
  void restoredSceneIsTheSameScene() {
    var room = room();
    room.apply(batch(el("a", 3, 1), el("b", 1, 2, true, "line", "")), "anna");
    var saved = room.scene();
    var again =
        BoardRoom.restore(
            "room",
            BoardProperties.defaults(),
            saved.epoch(),
            saved.seq(),
            saved.elements(),
            List.of(new BoardRoom.FileMeta("f", "image/png", 3)));
    assertThat(scene(again)).isEqualTo(scene(room));
    assertThat(again.live()).isEqualTo(1);
    assertThat(again.seq()).isEqualTo(room.seq());
    assertThat(again.hasFile("f")).isTrue();
    assertThat(again.dirty()).isFalse();
    assertThat(again.apply(batch(el("a", 2, 0)), "boris").batch()).isNull();
  }

  @Test
  void fullBoardFreesFilesThatNoVisibleImageUses() {
    var room = room(100, 100, 1 << 20, 2);
    room.addFile(new BoardRoom.FileMeta("used", "image/png", 1));
    room.addFile(new BoardRoom.FileMeta("gone", "image/png", 1));
    room.apply(batch(el("i", 1, 1, false, "image", ",\"fileId\":\"used\"")), "anna");
    room.apply(batch(el("j", 1, 1, true, "image", ",\"fileId\":\"gone\"")), "anna");
    assertThat(room.makeRoomForFile()).containsExactly("gone");
    assertThat(room.hasFile("gone")).isFalse();
    room.addFile(new BoardRoom.FileMeta("next", "image/png", 1));
    room.apply(batch(el("k", 1, 1, false, "image", ",\"fileId\":\"next\"")), "anna");
    assertThat(room.makeRoomForFile()).isNull();
  }

  @Test
  void inkDeltasQueuedForASlowSocketAreGluedNotLost() {
    var first =
        new Ephemeral.Ink(
            "i:a:s", "a", "s", 0, List.of(new double[] {0, 0}, new double[] {1, 1}), "{}", 1, 1);
    var second =
        new Ephemeral.Ink(
            "i:a:s", "a", "s", 1, List.of(new double[] {1, 1}, new double[] {2, 2}), null, 2, 2);
    var glued = (Ephemeral.Ink) first.merge(second);
    assertThat(glued.start()).isZero();
    assertThat(glued.points()).extracting(p -> p[0]).containsExactly(0.0, 1.0, 2.0);
    assertThat(glued.style()).isEqualTo("{}");
    assertThat(Json.tree(glued.render()).path("pts")).hasSize(3);
    assertThat(Json.tree(glued.render()).path("el").isObject()).isTrue();
    // Другой штрих того же автора не склеивается — его ключ другой, а склейка отдаёт новое.
    var other = new Ephemeral.Ink("i:a:t", "a", "t", 0, List.of(new double[] {5, 5}), null, 3, 3);
    assertThat(first.merge(other)).isSameAs(other);
    var cursor = new Ephemeral.Presence("p:a", "{\"x\":1}");
    assertThat(cursor.merge(new Ephemeral.Presence("p:a", "{\"x\":2}")).render())
        .isEqualTo("{\"x\":2}");
  }
}
