package dev.mikki.stream.api;

import dev.mikki.stream.access.*;
import dev.mikki.stream.room.*;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.util.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/favorites")
public class FavoriteController {
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

  @GetMapping
  public List<FavoriteService.Favorite> list(@RequestHeader("Authorization") String profile) {
    return favorites.list(profile);
  }

  @PutMapping("/{id}")
  public void save(
      @PathVariable UUID id,
      @RequestHeader("Authorization") String profile,
      @Valid @RequestBody Save request) {
    limits.check("favorite:" + Secrets.hash(profile), 60);
    favorites.save(profile, id.toString(), request.roomCredential());
  }

  @PutMapping("/order")
  public void reorder(
      @RequestHeader("Authorization") String profile, @Valid @RequestBody Order request) {
    limits.check("favorite:" + Secrets.hash(profile), 60);
    favorites.reorder(profile, request.roomIds().stream().map(UUID::toString).toList());
  }

  @DeleteMapping("/{id}")
  public void remove(@PathVariable UUID id, @RequestHeader("Authorization") String profile) {
    favorites.remove(profile, id.toString());
  }

  @PostMapping("/{id}/join")
  public Contracts.Admission join(
      @PathVariable UUID id,
      @RequestHeader("Authorization") String profile,
      @Valid @RequestBody Contracts.Rejoin request,
      HttpServletRequest http) {
    limits.check("favorite:" + Secrets.hash(profile), 60);
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
