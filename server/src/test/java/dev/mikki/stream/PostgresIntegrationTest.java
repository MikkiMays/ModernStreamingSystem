package dev.mikki.stream;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.junit.jupiter.*;
import org.testcontainers.postgresql.PostgreSQLContainer;

@Testcontainers(disabledWithoutDocker = true)
class PostgresIntegrationTest extends RoomServiceTest {
  @Container
  // PostgreSQL 18.3 Alpine: use digest-only syntax supported by Testcontainers' parser.
  static PostgreSQLContainer postgres =
      new PostgreSQLContainer(
          "postgres@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7");

  @DynamicPropertySource
  static void database(DynamicPropertyRegistry registry) {
    registry.add("spring.datasource.url", postgres::getJdbcUrl);
    registry.add("spring.datasource.username", postgres::getUsername);
    registry.add("spring.datasource.password", postgres::getPassword);
  }

  /**
   * Сроки {@code DatabaseGuards} доходят до самого Postgres: их понимает сервер, а не только
   * драйвер.
   */
  @Test
  void sessionsCarryLockAndIdleTransactionTimeouts() {
    assertEquals("15s", jdbc.sql("SHOW lock_timeout").query(String.class).single());
    assertEquals(
        "1min", jdbc.sql("SHOW idle_in_transaction_session_timeout").query(String.class).single());
  }
}
