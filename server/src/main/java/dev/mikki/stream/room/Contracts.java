package dev.mikki.stream.room;

import jakarta.validation.constraints.*;
import java.util.List;
import java.util.UUID;

public final class Contracts {
  private Contracts() {}

  public record Create(
      @NotNull UUID commandId,
      @NotBlank @Size(max = 80) String title,
      @NotBlank @Size(max = 40) String name,
      boolean approvalRequired,
      Boolean integrationsAllowed) {
    public Create(UUID commandId, String title, String name, boolean approvalRequired) {
      this(commandId, title, name, approvalRequired, null);
    }
  }

  public record Join(
      @NotNull UUID commandId,
      @NotBlank @Size(max = 150) String invite,
      @NotBlank @Size(max = 40) String name) {}

  public record JoinCode(
      @NotNull UUID commandId,
      @NotNull @Pattern(regexp = "[0-9]{9}") String code,
      @NotBlank @Size(max = 40) String name) {}

  public record Rejoin(@NotNull UUID commandId, @NotBlank @Size(max = 40) String name) {}

  /**
   * Что ведущий может поменять во встрече, которая уже идёт.
   *
   * <p>Название и режим входа записывались ровно один раз, при создании, и поменять их потом было
   * нечем: опечатку в названии комната несла до конца, а решение «пускаю всех» или «пускаю по
   * одному» приходилось принимать до того, как стало понятно, кто придёт.
   *
   * <p>Ограничения те же, что при создании: одно и то же поле не может быть длиннее в одном месте и
   * короче в другом.
   */
  public record RoomSettings(@NotBlank @Size(max = 80) String title, boolean approvalRequired) {}

  /**
   * Все типы команд, какие комната принимает, — одной строкой.
   *
   * <p>ОДИН СПИСОК, А НЕ ДВА. Раньше их было именно два: эта регулярка и перечисление в {@code
   * OpenApiConfig}, из которого рождается тип для браузера. Добавить команду в одно место и забыть
   * про второе — значит получить кнопку, которая собирается, проходит все тесты и отвечает
   * «Проверьте данные запроса» в первом же живом нажатии. Теперь схема читает этот же список.
   *
   * <p>Точки экранированы, потому что это выражение: {@link #commandTypes()} возвращает его уже
   * разобранным на имена.
   */
  public static final String COMMAND_TYPES =
      "leave|close|invite\\.create|invite\\.revoke|participant\\.remove|participant\\.approve|message\\.send|media\\.lost|media\\.restored|screen\\.started|view\\.open|view\\.close|view\\.playing|microphone\\.mute|profile\\.avatar|watch\\.open|watch\\.play|watch\\.pause|watch\\.seek|watch\\.close|poker\\.open|poker\\.close|poker\\.sit|poker\\.stand|poker\\.deal|poker\\.next|poker\\.act|poker\\.settings|poker\\.rebuy|poker\\.reveal|durak\\.open|durak\\.close|durak\\.sit|durak\\.stand|durak\\.deal|durak\\.act|durak\\.settings|durak\\.react";

  /** Те же типы списком имён — для схемы и для проверок. Разбирается один раз. */
  private static final List<String> TYPES = List.of(COMMAND_TYPES.replace("\\.", ".").split("\\|"));

  public static List<String> commandTypes() {
    return TYPES;
  }

  /**
   * Команда участника комнате.
   *
   * <p>Поля совместного просмотра пришли последними и необязательны: у команды одна форма на все
   * типы, и добавление ещё одного типа не должно заводить второй конверт. Прежний конструктор из
   * пяти полей оставлен, потому что им пользуется всё, что просмотра не касается.
   */
  public record Command(
      @NotNull UUID commandId,
      @NotBlank @Size(max = 30) @Pattern(regexp = COMMAND_TYPES) String type,
      @Size(max = 4000) String text,
      @Size(max = 36) String targetId,
      long generation,
      @Pattern(regexp = "youtube|twitch") String provider,
      @Pattern(regexp = "video|channel") String kind,
      @Size(max = 64) @Pattern(regexp = "[A-Za-z0-9_-]*") String contentId,
      @Min(0) @Max(86400000) Long positionMs,
      /**
       * Одно слово, уточняющее команду: режим стола, действие в раздаче, имя настройки. Игра пришла
       * последней и ведёт себя так же, как просмотр до неё, — одним конвертом на все типы.
       */
      @Size(max = 24) @Pattern(regexp = "[a-z0-9-]*") String option,
      @Min(0) @Max(9) Integer seat,
      /** Фишки: до чего повышать. Верхний предел — больше, чем может быть на любом столе. */
      @Min(0) @Max(100000000) Long chips,
      /**
       * Карта, которой ходят: {@code As}, {@code Td}, {@code 7h}.
       *
       * <p>Пришла вместе с дураком, где ход — это карта, а не сумма. Записана так же, как карты
       * приезжают обратно в снимке, — иначе провод говорил бы о картах на двух языках.
       */
      @Size(max = 2) @Pattern(regexp = "[23456789TJQKA][shdc]|") String card,
      /**
       * Какую карту бьём.
       *
       * <p>Второе поле, а не догадка «бьём первую неотбитую»: когда на столе две неотбитые карты,
       * «чем» без «что» неоднозначно, и сервер выбрал бы за человека не ту.
       */
      @Size(max = 2) @Pattern(regexp = "[23456789TJQKA][shdc]|") String under) {
    public Command(UUID commandId, String type, String text, String targetId, long generation) {
      this(
          commandId,
          type,
          text,
          targetId,
          generation,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null);
    }

    public Command(
        UUID commandId,
        String type,
        String text,
        String targetId,
        long generation,
        String provider,
        String kind,
        String contentId,
        Long positionMs) {
      this(
          commandId,
          type,
          text,
          targetId,
          generation,
          provider,
          kind,
          contentId,
          positionMs,
          null,
          null,
          null,
          null,
          null);
    }

    /** Конверт игры без карт: покеру хватает слова, места и числа фишек. */
    public Command(
        UUID commandId,
        String type,
        String text,
        String targetId,
        long generation,
        String provider,
        String kind,
        String contentId,
        Long positionMs,
        String option,
        Integer seat,
        Long chips) {
      this(
          commandId,
          type,
          text,
          targetId,
          generation,
          provider,
          kind,
          contentId,
          positionMs,
          option,
          seat,
          chips,
          null,
          null);
    }
  }

  public record Participant(
      String id,
      String name,
      String avatar,
      boolean owner,
      RoomState.Status status,
      long generation,
      Long recoveryDeadline,
      boolean screen,
      String service,
      String screenId,
      boolean screenStarted,
      String viewingScreenId) {}

  /**
   * Что комната смотрит вместе. {@code positionMs} верна в момент {@code anchorAt} по часам
   * сервера; сам {@code serverTime} снимка и даёт клиенту поправку на его собственные часы.
   */
  public record Watch(
      String provider,
      String kind,
      String contentId,
      String title,
      String openedBy,
      boolean paused,
      long positionMs,
      long anchorAt,
      long revision) {}

  public record Snapshot(
      String id,
      String title,
      String code,
      long createdAt,
      Long closedAt,
      long sequence,
      boolean approvalRequired,
      boolean integrationsAllowed,
      List<Participant> participants,
      List<RoomState.Message> messages,
      long serverTime,
      Watch watch,
      /**
       * Покерный стол — у каждого свой: карты в нём только собственные. Поэтому снимок собирается
       * на конкретного участника и никогда не пересылается от одного другому.
       */
      dev.mikki.stream.game.TableView poker,
      /**
       * Стол дурака — тоже у каждого свой: карты в нём только собственные, а колода и козырь под
       * ней остаются в ядре.
       */
      dev.mikki.stream.game.DurakView durak,
      /**
       * Когда в этой беседе последний раз доиграли, или 0 — если ещё ни разу.
       *
       * <p>Сами итоги игр приезжают отдельной ручкой ({@code /games}): в снимке им не место. А эта
       * метка — единственное, чего не хватало браузеру, чтобы перечитать историю в тот момент,
       * когда она и правда изменилась.
       */
      long pokerGamesAt,
      /** То же самое для дурака: одно число, по которому браузер понимает, что история выросла. */
      long durakGamesAt) {}

  public record Admission(
      String roomId,
      String participantId,
      String credential,
      String inviteUrl,
      int recoverySeconds,
      Snapshot snapshot) {}

  public record Resume(@Min(-1) long after) {}

  public record Ack(UUID commandId, boolean ok, long sequence, String value) {}

  @com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = true)
  public record EventPayload(RoomState.Message message, String screenId, String participantId) {
    public EventPayload(RoomState.Message message) {
      this(message, null, null);
    }

    public static EventPayload screen(String screenId, String participantId) {
      return new EventPayload(null, screenId, participantId);
    }

    public static EventPayload changed() {
      return new EventPayload(null);
    }
  }

  public record Event(
      int version,
      String eventId,
      long sequence,
      String type,
      EventPayload payload,
      long occurredAt) {}

  public record Replay(boolean reset, Snapshot snapshot, List<Event> events) {}

  public record MediaToken(String url, String token, long expiresAt) {}
}
