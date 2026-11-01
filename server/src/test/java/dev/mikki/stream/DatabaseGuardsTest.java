package dev.mikki.stream;

import static org.junit.jupiter.api.Assertions.*;

import com.zaxxer.hikari.HikariDataSource;
import dev.mikki.stream.config.DatabaseGuards;
import org.junit.jupiter.api.Test;

/**
 * Сроки соединений ставятся только пулу Postgres (стенд, 01.11.2026: замок держали сорок минут).
 */
class DatabaseGuardsTest {
  private static HikariDataSource pool(String url) {
    var pool = new HikariDataSource();
    pool.setJdbcUrl(url);
    new DatabaseGuards().postProcessBeforeInitialization(pool, "dataSource");
    return pool;
  }

  @Test
  void postgresGetsLockAndIdleTransactionAndSocketTimeouts() {
    var props = pool("jdbc:postgresql://127.0.0.1:5432/streaming").getDataSourceProperties();
    assertEquals("120", props.getProperty("socketTimeout"));
    assertTrue(props.getProperty("options").contains("lock_timeout=15s"));
    assertTrue(props.getProperty("options").contains("idle_in_transaction_session_timeout=60s"));
  }

  @Test
  void h2IsLeftAlone() {
    assertTrue(pool("jdbc:h2:mem:guards").getDataSourceProperties().isEmpty());
  }
}
