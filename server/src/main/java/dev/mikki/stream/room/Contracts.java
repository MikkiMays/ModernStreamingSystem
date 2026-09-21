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
   * Команда участника комнате.
   *
   * <p>Поля совместного просмотра пришли последними и необязательны: у команды одна форма на все
   * типы, и добавление ещё одного типа не должно заводить второй конверт. Прежний конструктор из
   * пяти полей оставлен, потому что им пользуется всё, что просмотра не касается.
   */
  public record Command(
      @NotNull UUID commandId,
      @NotBlank
          @Size(max = 30)
          @Pattern(
              regexp =
                  "leave|close|invite\\.create|invite\\.revoke|participant\\.remove|participant\\.approve|message\\.send|media\\.lost|media\\.restored|screen\\.started|view\\.open|view\\.close|view\\.playing|microphone\\.mute|profile\\.avatar|watch\\.open|watch\\.play|watch\\.pause|watch\\.seek|watch\\.close|poker\\.open|poker\\.close|poker\\.sit|poker\\.stand|poker\\.deal|poker\\.act|poker\\.settings|poker\\.rebuy|poker\\.reveal")
          String type,
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
      @Size(max = 24) @Pattern(regexp = "[a-z-]*") String option,
      @Min(0) @Max(9) Integer seat,
      /** Фишки: до чего повышать. Верхний предел — больше, чем может быть на любом столе. */
      @Min(0) @Max(100000000) Long chips) {
    public Command(UUID commandId, String type, String text, String targetId, long generation) {
      this(commandId, type, text, targetId, generation, null, null, null, null, null, null, null);
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
      dev.mikki.stream.game.TableView poker) {}

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
