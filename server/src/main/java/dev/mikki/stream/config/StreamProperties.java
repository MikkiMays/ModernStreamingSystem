package dev.mikki.stream.config;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.nio.file.Path;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.Name;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties("stream")
public record StreamProperties(
    @NotBlank String publicUrl,
    @NotBlank String livekitUrl,
    @NotBlank String livekitInternalUrl,
    @NotBlank String tusdInternalUrl,
    @NotBlank String livekitKey,
    @NotBlank @Size(min = 32) String livekitSecret,
    @NotBlank @Size(min = 32) String sessionSecret,
    @NotBlank @Size(min = 32) String internalSecret,
    @NotNull Path filesRoot,
    // Blank leaves the server open, which is what every installation did before the gate
    // existed. A value here is asked for once per visit, before any room is reachable.
    @Size(max = 200) String accessPassword,
    @Size(max = 60) String serverName,
    boolean redisEnabled,
    // Сколько людей во встрече; боты (музыка) не считаются (T06, П3). Выше пятидесяти не пускаем:
    // снимок читает каждый участник на каждое изменение, и бюджет 24 КиБ мерян на двадцать.
    @Min(1) @Max(50) int maxParticipants,
    @Min(1) @Max(2) int maxScreens,
    @Min(1) int maxRooms,
    @Min(5) @Max(60) int recoverySeconds,
    @Min(20) @Max(300) int joinSeconds,
    @Min(20) int emptyRoomSeconds,
    @Min(60) int unusedRoomSeconds,
    @NotNull @Valid Retention retention,
    @Min(60) @Max(3600) int uploadTimeoutSeconds,
    @Min(1) long fileMaxBytes,
    @Min(1) long roomMaxBytes,
    @Min(1) long totalMaxBytes,
    @Min(10) @Max(10000) int eventHistoryLimit,
    boolean admissionOpen,
    @NotNull @Valid Media media,
    @NotNull @Valid Favorites favorites,
    @NotNull @Valid Meeting meeting) {
  /**
   * Избранное профиля устройства (T06, П3): до {@code max-saved} сохранённых комнат на профиль — во
   * всех группах вместе. Сохранённое сверх предела раньше не удаляется, но новое не добавляется.
   */
  public record Favorites(@Min(1) @Max(1000) int maxSaved) {}

  /**
   * Правила встречи для человека.
   *
   * <p>{@code oneActivePerProfile} — у профиля устройства активна одна встреча (T52, П13): вход во
   * вторую отвечает {@code 409 ALREADY_IN_MEETING}, пока человек не согласится выйти из первой.
   */
  public record Meeting(boolean oneActivePerProfile) {}

  /**
   * Правила медиа, которые сервер отдаёт каждому входящему ({@code capabilities.quality}).
   *
   * <p>Сервер задаёт, клиент исполняет (П2, решение 3 целевой архитектуры): умолчание и потолок
   * качества живут здесь, а не в четырёх файлах веба, и переопределяются переменными окружения, как
   * сроки хранения.
   */
  public record Media(@NotNull @Valid Quality quality) {
    public record Quality(
        // Что публикуется, пока человек не выбрал иначе. `default` — слово Java, поэтому в коде
        // компонент зовётся иначе, а ключ в yml и в `capabilities` остаётся `default`.
        @Name("default") @NotNull Level initial,
        // Выше этого выбрать нельзя; список разрешений и частот в `capabilities` выводится отсюда.
        @NotNull Level ceiling,
        // Окно разгона полосы после публикации: столько жалобы кодировщика не считаются, столько
        // отправитель ждёт кадра целевого размера, прежде чем открыть показ зрителям (T48), и
        // столько
        // реконсайлер не открывает показ сам.
        @NotNull Duration settle,
        // Ужимать ли камеру до одного маленького слоя на время демонстрации экрана. По П2 —
        // нет, если человек не выбрал иначе; переключатель в настройках — E03.
        boolean cameraYieldsToScreen) {
      @AssertTrue(
          message =
              "stream.media.quality: default must not exceed ceiling in resolution or frame rate")
      public boolean isDefaultWithinCeiling() {
        return initial != null && ceiling != null && initial.within(ceiling);
      }

      /**
       * Минута ожидания — это уже не разгон, а зависший показ, и такую опечатку лучше не принять.
       */
      @AssertTrue(message = "stream.media.quality.settle must be between 0 and 60 seconds")
      public boolean isSettleSane() {
        return settle != null
            && !settle.isNegative()
            && settle.compareTo(Duration.ofSeconds(60)) <= 0;
      }
    }
  }

  /**
   * Сколько что живёт после того, как разговор кончился.
   *
   * <p>Сроки здесь пишутся словами — {@code 7 days}, {@code 3 months}, {@code never}, {@code
   * immediately}, — и разбирает их {@link Term}. Это единственные настройки хранения на весь
   * сервер: менять их приходится тому, кто ставит Cord себе, и менять по-человечески — в {@code
   * application.yml} или переменной окружения, а не в интерфейсе. Встреча — не переписка, и решение
   * «сколько её держать» принимает хозяин сервера, а не участник.
   */
  public record Retention(
      // Сколько живёт сохранённая встреча без единого входа. Отсчёт идёт от последнего входа
      // человека, а не от создания: пока в неё заходят, она остаётся, сколько бы месяцев ей
      // ни было.
      @NotNull Duration savedRoom,
      // Сколько живёт завершённая встреча, которую никто не сохранил себе. По умолчанию
      // `immediately`: разговор кончился, вернуться в него некому, и держать его не для кого.
      // Этот же срок — окно на «я случайно вышел»: пока оно не истекло, встреча открывается
      // по прежней ссылке из списка недавних.
      @NotNull Duration unsavedRoom,
      // Сколько после завершения хранится переписка и события встречи.
      @NotNull Duration closedHistory,
      // Сколько живут сообщения, события, расписки, приглашения и вложения идущей встречи.
      @NotNull Duration messages) {}

  @AssertTrue(message = "File quota must not exceed room quota, which must not exceed total quota")
  public boolean isQuotaOrderValid() {
    return fileMaxBytes <= roomMaxBytes && roomMaxBytes <= totalMaxBytes;
  }

  /**
   * История не может пережить саму встречу, а срок сохранённой — быть короче несохранённой.
   *
   * <p>Оба порядка проверяются при старте, а не наблюдаются потом: перепутанные местами сроки
   * выглядят как работающий сервер, который молча удаляет не то и не тогда.
   */
  @AssertTrue(
      message =
          "stream.retention: closed-history must not exceed saved-room, and unsaved-room must not"
              + " exceed saved-room")
  public boolean isRetentionOrderValid() {
    return retention != null
        && retention.closedHistory().compareTo(retention.savedRoom()) <= 0
        && retention.unsavedRoom().compareTo(retention.savedRoom()) <= 0;
  }
}
