package dev.mikki.stream.api;

import dev.mikki.stream.access.*;
import dev.mikki.stream.room.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.util.*;
import org.springframework.web.bind.annotation.*;

/**
 * Группы избранного и личные пометки комнаты (T40). Отдельно от {@link FavoriteController}: там —
 * какие комнаты сохранены, здесь — как человек их разложил.
 *
 * <p>Маршруты делят префикс с избранным: литерал {@code /groups/order} у Spring сильнее {@code
 * /groups/{id}}, а {@code /{id}/settings} не пересекается с {@code /{id}} и {@code /{id}/join}.
 */
@RestController
@RequestMapping("/api/v1/favorites")
public class FavoriteGroupController {
  public record GroupTitle(@NotBlank @Size(max = FavoriteGroupService.MAX_TITLE) String title) {}

  public record GroupOrder(@NotNull List<@NotNull UUID> groupIds) {}

  /** {@code groupId} и {@code alias} могут быть null: «без группы» и «своего имени нет». */
  public record FavoriteSettings(
      UUID groupId, boolean pinned, @Size(max = FavoriteGroupService.MAX_TITLE) String alias) {}

  private final FavoriteGroupService groups;
  private final RateLimits limits;

  public FavoriteGroupController(FavoriteGroupService groups, RateLimits limits) {
    this.groups = groups;
    this.limits = limits;
  }

  @GetMapping("/groups")
  public List<FavoriteGroupService.Group> list(@RequestHeader("Authorization") String profile) {
    return groups.list(profile);
  }

  @PutMapping("/groups/order")
  public void reorder(
      @RequestHeader("Authorization") String profile, @Valid @RequestBody GroupOrder request) {
    limits.check("favorite:" + Secrets.hash(profile), 60);
    groups.reorder(profile, request.groupIds().stream().map(UUID::toString).toList());
  }

  @PutMapping("/groups/{id}")
  public void put(
      @PathVariable UUID id,
      @RequestHeader("Authorization") String profile,
      @Valid @RequestBody GroupTitle request) {
    limits.check("favorite:" + Secrets.hash(profile), 60);
    groups.put(profile, id.toString(), request.title());
  }

  @DeleteMapping("/groups/{id}")
  public void remove(@PathVariable UUID id, @RequestHeader("Authorization") String profile) {
    groups.remove(profile, id.toString());
  }

  @PutMapping("/{id}/settings")
  public void settings(
      @PathVariable UUID id,
      @RequestHeader("Authorization") String profile,
      @Valid @RequestBody FavoriteSettings request) {
    limits.check("favorite:" + Secrets.hash(profile), 60);
    groups.settings(
        profile,
        id.toString(),
        request.groupId() == null ? null : request.groupId().toString(),
        request.pinned(),
        request.alias());
  }
}
