package dev.mikki.stream.api;

import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.activity.RxQuality;
import dev.mikki.stream.config.Rate;
import dev.mikki.stream.room.RoomService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.time.Duration;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

/**
 * Сводки приёма раз в десять секунд ({@link RxQuality}): пропуск участника, не чаще раза в {@link
 * #WINDOW} с одного входа ({@code 429 RATE_LIMITED}) и 60 в минуту с адреса. Сводка ложится только
 * в метры — ответ никому не нужен.
 */
@RestController
@RequestMapping("/api/v1")
public class QualityController {
  /**
   * Клиент шлёт раз в десять секунд; окно чуть короче, чтобы дрожание таймера вкладки не стало
   * отказом, а второй клиент с тем же пропуском — стал.
   */
  static final Rate WINDOW = new Rate(1, Duration.ofSeconds(8));

  private final RoomService rooms;
  private final RateLimits limits;
  private final ClientAddress address;
  private final RxQuality quality;

  public QualityController(
      RoomService rooms, RateLimits limits, ClientAddress address, RxQuality quality) {
    this.rooms = rooms;
    this.limits = limits;
    this.address = address;
    this.quality = quality;
  }

  @PostMapping("/rooms/{id}/quality")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void report(
      @PathVariable UUID id,
      @RequestHeader("Authorization") String credential,
      @Valid @RequestBody RxQuality.RxSummary summary,
      HttpServletRequest http) {
    limits.check("quality-ip:" + address.of(http), 60);
    var room = rooms.read(id.toString());
    var member = rooms.authenticate(room, credential);
    limits.check("quality:" + room.id + ":" + member.id, WINDOW);
    quality.record(summary);
  }
}
