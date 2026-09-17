package dev.mikki.stream.api;

import dev.mikki.stream.room.Contracts;
import dev.mikki.stream.room.RoomService;
import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;

/**
 * Название встречи и режим входа, пока встреча идёт.
 *
 * <p>Отдельно от настроек интеграций рядом: те живут в своей панели и отвечают на вопрос «кому
 * можно включать музыку», а эти — на вопрос «что это за встреча и кого в неё пускать». Одно поле в
 * двух ручках оказалось бы двумя источниками правды.
 */
@RestController
@RequestMapping("/api/v1/rooms/{roomId}/settings")
public class RoomSettingsController {
  private final RoomService rooms;

  public RoomSettingsController(RoomService rooms) {
    this.rooms = rooms;
  }

  // Имя метода становится operationId: `update` уже занят настройками интеграций, и два
  // одинаковых имени в одном API превращаются в `update` и `update_1` — ни о чём.
  @PutMapping
  public Contracts.Snapshot updateRoomSettings(
      @PathVariable UUID roomId,
      @RequestHeader("Authorization") String credential,
      @Valid @RequestBody Contracts.RoomSettings settings) {
    return rooms.roomSettings(roomId.toString(), credential, settings);
  }
}
