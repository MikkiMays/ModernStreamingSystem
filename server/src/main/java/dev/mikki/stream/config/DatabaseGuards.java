package dev.mikki.stream.config;

import com.zaxxer.hikari.HikariDataSource;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.stereotype.Component;

/**
 * Сроки соединений с Postgres: ни запрос, ни транзакция не держат общий замок дольше разумного.
 *
 * <p>Что было (стенд, 01.11.2026). Виртуальный поток ядра не проснулся на ответ Postgres — ошибка
 * JDK 25.0.2 (JDK-8369227, исправлена в 25.0.3): ответ лежал в сокете, а поток ждал вечно. Перед
 * этим он взял {@code system_lock} ({@code FOR UPDATE}), и сорок минут никто не мог создать
 * встречу: каждый следующий запрос вставал в очередь за замком, держа соединение пула, пока пул не
 * кончился. Образ обновлён, но зависнуть может не только JDK — поэтому сроки:
 *
 * <ul>
 *   <li>{@code idle_in_transaction_session_timeout} — Postgres сам обрывает транзакцию, клиент
 *       которой молчит дольше минуты: замок освобождается, даже если поток ядра не проснётся
 *       никогда;
 *   <li>{@code lock_timeout} — замок ждать не дольше 15 с: очередь за занятым замком не съедает
 *       пул, а получает «сервер занят» (браузер всё равно ждёт ответа только 8 с);
 *   <li>{@code socketTimeout} — ответ ждать не дольше двух минут: поток, которого не разбудили,
 *       проснётся по сроку и вернёт соединение пулу.
 * </ul>
 *
 * <p>Только для Postgres: тесты идут на H2, ей эти свойства незнакомы. Свойства ставятся до первого
 * соединения — пул Hikari открывается при первом запросе, после инициализации бина.
 */
@Component
public class DatabaseGuards implements BeanPostProcessor {
  static final String SOCKET_TIMEOUT_SECONDS = "120";
  static final String OPTIONS = "-c lock_timeout=15s -c idle_in_transaction_session_timeout=60s";

  @Override
  public Object postProcessBeforeInitialization(Object bean, String name) {
    if (bean instanceof HikariDataSource pool
        && pool.getJdbcUrl() != null
        && pool.getJdbcUrl().startsWith("jdbc:postgresql:")) {
      pool.addDataSourceProperty("socketTimeout", SOCKET_TIMEOUT_SECONDS);
      pool.addDataSourceProperty("options", OPTIONS);
    }
    return bean;
  }
}
