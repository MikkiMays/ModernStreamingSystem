package dev.mikki.stream.api;

import dev.mikki.stream.room.Contracts;
import dev.mikki.stream.room.RoomService;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/rooms/{roomId}/integrations")
public class IntegrationSettingsController {
  public record Settings(boolean enabled) {}

  private final RoomService rooms;

  public IntegrationSettingsController(RoomService rooms) {
    this.rooms = rooms;
  }

  @PutMapping
  public Contracts.Snapshot update(
      @PathVariable UUID roomId,
      @RequestHeader("Authorization") String credential,
      @RequestBody Settings settings) {
    return rooms.integrationSettings(roomId.toString(), credential, settings.enabled());
  }
}
