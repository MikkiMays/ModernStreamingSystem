package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;

import dev.mikki.stream.room.Contracts.Create;
import dev.mikki.stream.room.FavoriteService;
import dev.mikki.stream.room.RoomService;
import dev.mikki.stream.shared.Problem;
import java.util.*;
import java.util.concurrent.*;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.datasource.init.ScriptUtils;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:favorite-order;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.max-rooms=200"
    })
@ActiveProfiles("local")
class FavoriteOrderTest {
  @Autowired FavoriteService favorites;
  @Autowired RoomService rooms;
  @Autowired DataSource dataSource;

  @Test
  void migrationPreservesExistingOrderWithinEachProfile() throws Exception {
    var schema = "favorite_migration_" + UUID.randomUUID().toString().replace("-", "");
    try (var connection = dataSource.getConnection();
        var statement = connection.createStatement()) {
      var original = connection.getSchema();
      statement.execute("CREATE SCHEMA " + schema);
      try {
        connection.setSchema(schema);
        statement.execute(
            "CREATE TABLE favorites(profile_hash VARCHAR(64), room_id VARCHAR(36), saved_at BIGINT)");
        statement.execute(
            "INSERT INTO favorites VALUES('a','old',1),('a','new-a',2),('a','new-b',2),('b','other',9)");
        ScriptUtils.executeSqlScript(
            connection, new ClassPathResource("db/migration/V7__favorite_order.sql"));
        try (var rows =
            statement.executeQuery(
                "SELECT room_id,sort_order FROM favorites WHERE profile_hash='a' ORDER BY sort_order")) {
          for (var id : List.of("new-a", "new-b", "old")) {
            assertThat(rows.next()).isTrue();
            assertThat(rows.getString(1)).isEqualTo(id);
          }
          assertThat(rows.next()).isFalse();
        }
        try (var rows =
            statement.executeQuery("SELECT sort_order FROM favorites WHERE profile_hash='b'")) {
          assertThat(rows.next()).isTrue();
          assertThat(rows.getLong(1)).isZero();
        }
      } finally {
        connection.setSchema(original);
        statement.execute("DROP SCHEMA " + schema + " CASCADE");
      }
    }
  }

  private String save(String profile) {
    var room = rooms.create(new Create(UUID.randomUUID(), "Комната", "Хозяин", false));
    favorites.save(profile, room.roomId(), room.credential());
    return room.roomId();
  }

  @Test
  void concurrentRoomExpiryRejectsAStaleOrder() throws Exception {
    var profile = "T".repeat(43);
    var expired = save(profile);
    var remaining = save(profile);
    try (var workers = Executors.newSingleThreadExecutor();
        var connection = dataSource.getConnection()) {
      connection.setAutoCommit(false);
      try (var delete = connection.prepareStatement("DELETE FROM rooms WHERE id=?")) {
        delete.setString(1, expired);
        assertThat(delete.executeUpdate()).isEqualTo(1);
      }
      var started = new CountDownLatch(1);
      var order =
          workers.submit(
              () -> {
                started.countDown();
                favorites.reorder(profile, List.of(expired, remaining));
              });
      try {
        assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
        assertThatThrownBy(() -> order.get(150, TimeUnit.MILLISECONDS))
            .isInstanceOf(TimeoutException.class);
        connection.commit();
      } finally {
        connection.rollback(); // Release locks even when the blocking assertion fails.
      }
      assertThatThrownBy(() -> order.get(5, TimeUnit.SECONDS))
          .isInstanceOf(ExecutionException.class)
          .hasCauseInstanceOf(Problem.class);
      assertThat(favorites.list(profile))
          .extracting(FavoriteService.Favorite::roomId)
          .containsExactly(remaining);
    }
  }

  @Test
  void explicitOrderSurvivesReadAndNewRoomsGoFirst() {
    var profile = "O".repeat(43);
    var first = save(profile);
    var second = save(profile);
    var third = save(profile);
    favorites.reorder(profile, List.of(first, third, second));
    assertThat(favorites.list(profile))
        .extracting(FavoriteService.Favorite::roomId)
        .containsExactly(first, third, second);
  }

  @Test
  void addAndRemoveRetainChosenRelativeOrder() {
    var profile = "P".repeat(43);
    var first = save(profile);
    var second = save(profile);
    favorites.reorder(profile, List.of(first, second));
    var newest = save(profile);
    assertThat(favorites.list(profile))
        .extracting(FavoriteService.Favorite::roomId)
        .containsExactly(newest, first, second);
    favorites.remove(profile, first);
    assertThat(favorites.list(profile))
        .extracting(FavoriteService.Favorite::roomId)
        .containsExactly(newest, second);
  }

  @Test
  void invalidOrStaleOrderNeverPartiallyChangesTheProfile() {
    var profile = "Q".repeat(43);
    var first = save(profile);
    var second = save(profile);
    var foreign = save("R".repeat(43));
    for (var invalid : List.of(List.of(first, first), List.of(first), List.of(first, foreign))) {
      assertThatThrownBy(() -> favorites.reorder(profile, invalid)).isInstanceOf(Problem.class);
      assertThat(favorites.list(profile))
          .extracting(FavoriteService.Favorite::roomId)
          .containsExactly(second, first);
    }
    assertThat(favorites.list("R".repeat(43)))
        .extracting(FavoriteService.Favorite::roomId)
        .containsExactly(foreign);
    favorites.reorder("S".repeat(43), List.of());
  }
}
