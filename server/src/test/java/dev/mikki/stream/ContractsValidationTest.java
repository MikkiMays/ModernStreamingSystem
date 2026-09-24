package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;

import dev.mikki.stream.room.Contracts;
import jakarta.validation.Validation;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Кто на самом деле проверяет {@code provider} у {@link Contracts.Command}.
 *
 * <p>{@code RoomServiceTest} зовёт {@code RoomService.command(...)} напрямую и ни разу не проходит
 * через {@code @Valid @RequestBody} у {@code ApiController} — единственное место, где
 * {@code @Pattern} у {@code provider} взаправду срабатывает. Убери «vk» из {@code WATCH_PROVIDERS}
 * — и все тесты службы останутся зелёными: площадку приняли бы без единой проверки. Этот тест ходит
 * к самой аннотации напрямую, тем же приёмом, что {@code
 * RoomServiceTest.everyCommandTypeTheRoomKnowsPassesRequestValidation} для типа команды, — но для
 * площадки. Ни Spring, ни база здесь не нужны: {@code jakarta.validation} проверяет аннотации сам.
 *
 * <p>Класс живёт в {@code dev.mikki.stream}, не в {@code dev.mikki.stream.room}: {@code
 * ArchitectureTest} запрещает пакету {@code room} звать {@code ..api..}, а под этот шаблон ArchUnit
 * подводит и {@code org.assertj.core.api} — с любым AssertJ внутри пакета {@code room} правило
 * падает на чужом «api», которого там и не было в виду. Ровно поэтому и {@code RoomServiceTest}
 * живёт здесь же, а не в {@code room}.
 */
class ContractsValidationTest {

  /** Команда открытия ролика с заданной площадкой; остальные поля заведомо проходят проверку. */
  private static Contracts.Command watchOpen(String provider) {
    return new Contracts.Command(
        UUID.randomUUID(), "watch.open", null, null, 0, provider, "video", "abc", null);
  }

  /**
   * Семь площадок — списком в самом тесте, а не {@code WATCH_PROVIDERS.split(...)}: список из
   * константы всегда совпадёт сам с собой, что бы в нём ни было, и ни разу не заметит пропажи.
   */
  @Test
  void everyDeclaredProviderPassesValidation() {
    try (var factory = Validation.buildDefaultValidatorFactory()) {
      var validator = factory.getValidator();
      for (var provider :
          new String[] {"youtube", "twitch", "vk", "rutube", "ivi", "jellyfin", "link"})
        assertThat(validator.validate(watchOpen(provider))).as("площадка %s", provider).isEmpty();
    }
  }

  /** Незнакомое имя и почти угаданное — регистр, лишний пробел — не проходят вовсе. */
  @Test
  void unknownAndNearMissProvidersAreRejected() {
    try (var factory = Validation.buildDefaultValidatorFactory()) {
      var validator = factory.getValidator();
      for (var provider : new String[] {"netflix", "YouTube", "youtube "}) {
        var violations = validator.validate(watchOpen(provider));
        assertThat(violations).as("площадка %s", provider).isNotEmpty();
        assertThat(violations)
            .as("площадка %s: отказ именно на provider", provider)
            .anyMatch(v -> v.getPropertyPath().toString().equals("provider"));
      }
    }
  }
}
