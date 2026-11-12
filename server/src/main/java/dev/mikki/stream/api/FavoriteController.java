package dev.mikki.stream.api;

import dev.mikki.stream.access.*;
import dev.mikki.stream.room.*;
import dev.mikki.stream.shared.Problem;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.util.*;
import org.springframework.web.bind.annotation.*;

/**
 * Избранное профиля устройства: какие встречи сохранены и в каком порядке.
 *
 * <p>КТО СПРАШИВАЕТ И КАК ЧАСТО — ДО СЛУЖБЫ (R236, {@code docs/architecture/core-scale.md} §6).
 * Записи избранного идут под общим замком системы, поэтому у каждой из них сначала {@link #caller}:
 * предел адреса, секрет профиля, похожий на секрет, предел самого профиля. Раньше предел считался
 * только по присланной строке профиля — другая строка получала новый счётчик, — а удаление шло без
 * предела вовсе.
 */
@RestController
@RequestMapping("/api/v1/favorites")
public class FavoriteController {
  /** Записей избранного с одного адреса в минуту: вдвое щедрее предела профиля — за NAT офис. */
  static final int PER_ADDRESS = 120;

  /** Записей избранного одного профиля в минуту. */
  static final int PER_PROFILE = 60;

  public record Save(@NotBlank @Size(max = 150) String roomCredential) {}

  public record Order(@NotNull List<@NotNull UUID> roomIds) {}

  private final FavoriteService favorites;
  private final RateLimits limits;
  private final Identity identity;
  private final ClientAddress address;
  private final Entries entries;

  public FavoriteController(
      FavoriteService favorites,
      RateLimits limits,
      Identity identity,
      ClientAddress address,
      Entries entries) {
    this.favorites = favorites;
    this.limits = limits;
    this.identity = identity;
    this.address = address;
    this.entries = entries;
  }

  /**
   * Дверь записей избранного и его групп: предел адреса, затем профиль — строка, не похожая на
   * секрет профиля, получает {@code 403} и до службы не доходит, — затем предел профиля.
   */
  static void caller(
      RateLimits limits, ClientAddress address, HttpServletRequest http, String profile) {
    // У нашей службы без актора (бот открывает встречу беседы) адреса человека нет — предела тоже.
    var from = address.entrant(http);
    if (from != null) limits.address("favorite-ip:" + from, PER_ADDRESS);
    var hash = Identity.profileHash(profile == null ? null : profile.replaceFirst("^Bearer ", ""));
    if (hash == null) throw Problem.forbidden();
    limits.member("favorite:" + hash, PER_PROFILE);
  }

  @GetMapping
  public List<FavoriteService.Favorite> list(@RequestHeader("Authorization") String profile) {
    return favorites.list(profile);
  }

  @PutMapping("/{id}")
  public void save(
      @PathVariable UUID id,
      @RequestHeader("Authorization") String profile,
      @Valid @RequestBody Save request,
      HttpServletRequest http) {
    caller(limits, address, http, profile);
    favorites.save(profile, id.toString(), request.roomCredential());
  }

  @PutMapping("/order")
  public void reorder(
      @RequestHeader("Authorization") String profile,
      @Valid @RequestBody Order request,
      HttpServletRequest http) {
    caller(limits, address, http, profile);
    favorites.reorder(profile, request.roomIds().stream().map(UUID::toString).toList());
  }

  @DeleteMapping("/{id}")
  public void remove(
      @PathVariable UUID id,
      @RequestHeader("Authorization") String profile,
      HttpServletRequest http) {
    caller(limits, address, http, profile);
    favorites.remove(profile, id.toString());
  }

  @PostMapping("/{id}/join")
  public Contracts.Admission join(
      @PathVariable UUID id,
      @RequestHeader("Authorization") String profile,
      @Valid @RequestBody Contracts.Rejoin request,
      HttpServletRequest http) {
    caller(limits, address, http, profile);
    return entries.admit(
        "saved",
        http,
        () ->
            favorites.join(
                profile,
                id.toString(),
                request,
                identity.entrant(http).from(address.entrant(http))));
  }
}
