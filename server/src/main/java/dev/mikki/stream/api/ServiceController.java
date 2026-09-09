package dev.mikki.stream.api;

import dev.mikki.stream.room.Contracts;
import dev.mikki.stream.room.RoomService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;

/** Not routed publicly. RequestGuard requires the dedicated internal secret. */
@RestController
@RequestMapping("/internal/services")
public class ServiceController {
  public record Add(@NotNull UUID commandId) {}

  private final RoomService rooms;

  public ServiceController(RoomService rooms) {
    this.rooms = rooms;
  }

  public record Info(
      String id,
      String title,
      String code,
      Long closedAt,
      boolean ownerPresent,
      boolean integrationsAllowed) {}

  @GetMapping("/{roomId}")
  public Info info(@PathVariable UUID roomId) {
    var room = rooms.read(roomId.toString());
    return new Info(
        room.id,
        room.title,
        room.code,
        room.closedAt,
        room.members.values().stream()
            .anyMatch(
                member ->
                    member.owner
                        && member.status == dev.mikki.stream.room.RoomState.Status.CONNECTED),
        room.integrationsAllowed);
  }

  @PostMapping("/{roomId}/invite")
  public Map<String, String> invite(@PathVariable UUID roomId) {
    return Map.of("url", rooms.serviceInvite(roomId.toString()));
  }

  @PostMapping("/{roomId}/music")
  public Contracts.Admission music(@PathVariable UUID roomId, @Valid @RequestBody Add request) {
    return rooms.addMusicService(roomId.toString(), request.commandId());
  }
}
