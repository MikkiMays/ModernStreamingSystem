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
      boolean approvalRequired) {}

  public record Join(
      @NotNull UUID commandId,
      @NotBlank @Size(max = 150) String invite,
      @NotBlank @Size(max = 40) String name) {}

  public record JoinCode(
      @NotNull UUID commandId,
      @NotNull @Pattern(regexp = "[0-9]{9}") String code,
      @NotBlank @Size(max = 40) String name) {}

  public record Rejoin(@NotNull UUID commandId, @NotBlank @Size(max = 40) String name) {}

  public record Command(
      @NotNull UUID commandId,
      @NotBlank
          @Size(max = 30)
          @Pattern(
              regexp =
                  "leave|close|invite\\.create|invite\\.revoke|participant\\.remove|participant\\.approve|message\\.send|media\\.lost|media\\.restored")
          String type,
      @Size(max = 4000) String text,
      @Size(max = 36) String targetId,
      long generation) {}

  public record Participant(
      String id,
      String name,
      boolean owner,
      RoomState.Status status,
      long generation,
      Long recoveryDeadline,
      boolean screen) {}

  public record Snapshot(
      String id,
      String title,
      String code,
      long createdAt,
      Long closedAt,
      long sequence,
      boolean approvalRequired,
      List<Participant> participants,
      List<RoomState.Message> messages,
      long serverTime) {}

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
  public record EventPayload(RoomState.Message message) {
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
