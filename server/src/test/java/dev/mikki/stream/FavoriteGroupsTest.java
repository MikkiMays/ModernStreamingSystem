package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.hamcrest.Matchers.nullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import dev.mikki.stream.room.Contracts.Create;
import dev.mikki.stream.room.FavoriteGroupService;
import dev.mikki.stream.room.FavoriteGroupService.Group;
import dev.mikki.stream.room.FavoriteService;
import dev.mikki.stream.room.FavoriteService.Favorite;
import dev.mikki.stream.room.RoomRepository;
import dev.mikki.stream.room.RoomService;
import dev.mikki.stream.shared.Problem;
import java.security.SecureRandom;
import java.util.*;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:favorite-groups;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.max-rooms=200"
    })
@ActiveProfiles("local")
class FavoriteGroupsTest {
  private static final SecureRandom RANDOM = new SecureRandom();

  @Autowired FavoriteService favorites;
  @Autowired FavoriteGroupService groups;
  @Autowired RoomService rooms;
  @Autowired RoomRepository repository;
  @Autowired WebApplicationContext web;

  /** Свой профиль на каждый тест: наследник с Postgres делит одну базу на весь класс. */
  private static String profile() {
    var bytes = new byte[32];
    RANDOM.nextBytes(bytes);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  private static String id() {
    return UUID.randomUUID().toString();
  }

  private String save(String profile) {
    var room = rooms.create(new Create(UUID.randomUUID(), "Комната", "Хозяин", false));
    favorites.save(profile, room.roomId(), room.credential());
    return room.roomId();
  }

  private Favorite favorite(String profile, String roomId) {
    return favorites.list(profile).stream()
        .filter(f -> f.roomId().equals(roomId))
        .findFirst()
        .orElseThrow();
  }

  private static void refused(ThrowingCallable call, int status, String code) {
    assertThatThrownBy(call)
        .isInstanceOfSatisfying(
            Problem.class,
            problem -> {
              assertThat(problem.status()).isEqualTo(status);
              assertThat(problem.code()).isEqualTo(code);
            });
  }

  @Test
  void groupsAreCreatedInOrderRenamedInPlaceAndTitlesTrimmed() {
    var profile = profile();
    var work = id();
    var friends = id();
    var family = id();
    groups.put(profile, work, "  Работа  ");
    groups.put(profile, friends, "Друзья");
    groups.put(profile, family, "Семья");
    groups.put(profile, friends, "Близкие");
    assertThat(groups.list(profile))
        .containsExactly(
            new Group(work, "Работа"), new Group(friends, "Близкие"), new Group(family, "Семья"));

    refused(() -> groups.put(profile, id(), "   "), 400, "INVALID_REQUEST");
    // Идеографический пробел: @NotBlank (trim) его пропустил бы, а служба — нет.
    refused(() -> groups.put(profile, work, Character.toString(0x3000)), 400, "INVALID_REQUEST");
    refused(() -> groups.put(profile, id(), "я".repeat(61)), 400, "INVALID_REQUEST");
    groups.put(profile, family, "я".repeat(60));
    assertThat(groups.list(profile)).hasSize(3).last().isEqualTo(new Group(family, "я".repeat(60)));
  }

  @Test
  void eleventhGroupIsRefusedButRenamingAtTheLimitWorks() {
    var profile = profile();
    var ids = new ArrayList<String>();
    for (int i = 0; i < FavoriteGroupService.MAX_GROUPS; i++) {
      ids.add(id());
      groups.put(profile, ids.getLast(), "Группа " + i);
    }
    var extra = id();
    refused(() -> groups.put(profile, extra, "Лишняя"), 409, "FAVORITE_GROUPS_FULL");
    groups.put(profile, ids.getLast(), "Последняя");
    assertThat(groups.list(profile))
        .hasSize(10)
        .extracting(Group::title)
        .endsWith("Последняя")
        .doesNotContain("Лишняя");

    groups.remove(profile, ids.getFirst());
    groups.put(profile, extra, "Новая");
    assertThat(groups.list(profile)).hasSize(10).last().isEqualTo(new Group(extra, "Новая"));
  }

  @Test
  void deletingAGroupReturnsItsRoomsToTheCommonListAndRepeatsHarmlessly() {
    var profile = profile();
    var first = save(profile);
    var second = save(profile);
    var group = id();
    groups.put(profile, group, "Работа");
    groups.settings(profile, first, group, false, null);
    groups.settings(profile, second, group, true, "Своя");

    groups.remove(profile, group);
    assertThat(groups.list(profile)).isEmpty();
    assertThat(favorites.list(profile))
        .extracting(Favorite::roomId, Favorite::groupId, Favorite::pinned, Favorite::alias)
        .containsExactlyInAnyOrder(
            tuple(first, null, false, null), tuple(second, null, true, "Своя"));

    groups.remove(profile, group);
    groups.remove(profile, id());
    // Ссылки очищены, а не оставлены висеть: группа с тем же id комнаты обратно не забирает.
    groups.put(profile, group, "Снова");
    assertThat(favorites.list(profile)).extracting(Favorite::groupId).containsOnlyNulls();
  }

  @Test
  void settingsReplaceGroupPinAndAliasTogether() {
    var profile = profile();
    var room = save(profile);
    assertThat(favorite(profile, room))
        .extracting(Favorite::groupId, Favorite::pinned, Favorite::alias)
        .containsExactly(null, false, null);

    var group = id();
    groups.put(profile, group, "Работа");
    groups.settings(profile, room, group, true, "  Планёрка  ");
    assertThat(favorite(profile, room))
        .extracting(Favorite::groupId, Favorite::pinned, Favorite::alias)
        .containsExactly(group, true, "Планёрка");

    groups.settings(profile, room, null, false, "   ");
    assertThat(favorite(profile, room))
        .extracting(Favorite::groupId, Favorite::pinned, Favorite::alias)
        .containsExactly(null, false, null);

    refused(
        () -> groups.settings(profile, room, null, true, "я".repeat(61)), 400, "INVALID_REQUEST");
    assertThat(favorite(profile, room).pinned()).isFalse();
  }

  @Test
  void settingsRefuseUnknownGroupsAndRoomsOutsideTheFavorites() {
    var profile = profile();
    var room = save(profile);
    var group = id();
    groups.put(profile, group, "Работа");
    groups.settings(profile, room, group, true, "Своя");

    refused(() -> groups.settings(profile, room, id(), false, null), 409, "FAVORITE_GROUP_MISSING");
    refused(() -> groups.settings(profile, id(), null, false, null), 404, "FAVORITE_MISSING");
    var foreign = save(profile());
    refused(() -> groups.settings(profile, foreign, group, false, null), 404, "FAVORITE_MISSING");
    assertThat(favorite(profile, room))
        .extracting(Favorite::groupId, Favorite::pinned, Favorite::alias)
        .containsExactly(group, true, "Своя");
  }

  @Test
  void groupOrderIsAllOrNothing() {
    var profile = profile();
    var a = id();
    var b = id();
    var c = id();
    groups.put(profile, a, "А");
    groups.put(profile, b, "Б");
    groups.put(profile, c, "В");
    groups.reorder(profile, List.of(c, a, b));
    assertThat(groups.list(profile)).extracting(Group::id).containsExactly(c, a, b);

    refused(() -> groups.reorder(profile, List.of(a, a, b)), 400, "FAVORITE_GROUP_ORDER_INVALID");
    refused(() -> groups.reorder(profile, List.of(a, b)), 409, "FAVORITE_GROUPS_CHANGED");
    refused(() -> groups.reorder(profile, List.of(a, b, id())), 409, "FAVORITE_GROUPS_CHANGED");
    refused(() -> groups.reorder(profile, List.of(a, b, c, id())), 409, "FAVORITE_GROUPS_CHANGED");
    assertThat(groups.list(profile)).extracting(Group::id).containsExactly(c, a, b);

    var d = id();
    groups.put(profile, d, "Г");
    assertThat(groups.list(profile)).extracting(Group::id).containsExactly(c, a, b, d);
    groups.reorder(profile(), List.of());
  }

  @Test
  void anotherProfileNeitherSeesNorTouchesTheGroups() {
    var owner = profile();
    var stranger = profile();
    var ownerRoom = save(owner);
    var strangerRoom = save(stranger);
    var group = id();
    groups.put(owner, group, "Работа");
    groups.settings(owner, ownerRoom, group, true, "Своя");

    assertThat(groups.list(stranger)).isEmpty();
    refused(() -> groups.reorder(stranger, List.of(group)), 409, "FAVORITE_GROUPS_CHANGED");
    refused(
        () -> groups.settings(stranger, strangerRoom, group, false, null),
        409,
        "FAVORITE_GROUP_MISSING");
    refused(() -> groups.settings(stranger, ownerRoom, null, false, null), 404, "FAVORITE_MISSING");
    groups.remove(stranger, group);

    // Тот же id у другого профиля — его собственная группа, а не переименование чужой.
    groups.put(stranger, group, "Чужая");
    groups.settings(stranger, strangerRoom, group, false, null);
    groups.remove(stranger, group);

    assertThat(groups.list(owner)).containsExactly(new Group(group, "Работа"));
    assertThat(favorite(owner, ownerRoom))
        .extracting(Favorite::groupId, Favorite::pinned, Favorite::alias)
        .containsExactly(group, true, "Своя");
    assertThat(favorite(stranger, strangerRoom).groupId()).isNull();
  }

  @Test
  void aFavoriteWhoseGroupVanishedComesBackUngrouped() {
    var profile = profile();
    var room = save(profile);
    var group = id();
    groups.put(profile, group, "Работа");
    groups.settings(profile, room, group, true, null);
    repository.jdbc().sql("DELETE FROM favorite_groups WHERE id=?").param(group).update();

    assertThat(favorite(profile, room))
        .extracting(Favorite::groupId, Favorite::pinned)
        .containsExactly(null, true);
  }

  private static MockHttpServletRequestBuilder json(
      MockHttpServletRequestBuilder request, String profile, String body) {
    return request
        .header("Authorization", "Bearer " + profile)
        .contentType(MediaType.APPLICATION_JSON)
        .content(body);
  }

  /** Маршруты делят префикс с избранным — проверяем, что каждый доходит до своего обработчика. */
  @Test
  void routesReachTheirHandlersAndErrorsKeepTheirCodes() throws Exception {
    MockMvc mvc = MockMvcBuilders.webAppContextSetup(web).build();
    var profile = profile();
    var auth = "Bearer " + profile;
    var room = save(profile);
    var a = id();
    var b = id();
    mvc.perform(json(put("/api/v1/favorites/groups/" + a), profile, "{\"title\":\" Work \"}"))
        .andExpect(status().isOk());
    mvc.perform(json(put("/api/v1/favorites/groups/" + b), profile, "{\"title\":\"Friends\"}"))
        .andExpect(status().isOk());
    // Литерал /groups/order сильнее /groups/{id}: иначе «order» не разобрался бы как UUID.
    mvc.perform(
            json(
                put("/api/v1/favorites/groups/order"),
                profile,
                "{\"groupIds\":[\"%s\",\"%s\"]}".formatted(b, a)))
        .andExpect(status().isOk());
    mvc.perform(get("/api/v1/favorites/groups").header("Authorization", auth))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.length()").value(2))
        .andExpect(jsonPath("$[0].id").value(b))
        .andExpect(jsonPath("$[0].title").value("Friends"))
        .andExpect(jsonPath("$[1].id").value(a))
        .andExpect(jsonPath("$[1].title").value("Work"));

    mvc.perform(
            json(
                put("/api/v1/favorites/" + room + "/settings"),
                profile,
                "{\"groupId\":\"%s\",\"pinned\":true,\"alias\":\" Standup \"}".formatted(a)))
        .andExpect(status().isOk());
    mvc.perform(get("/api/v1/favorites").header("Authorization", auth))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$[0].roomId").value(room))
        .andExpect(jsonPath("$[0].groupId").value(a))
        .andExpect(jsonPath("$[0].pinned").value(true))
        .andExpect(jsonPath("$[0].alias").value("Standup"));

    mvc.perform(
            json(
                put("/api/v1/favorites/" + UUID.randomUUID() + "/settings"),
                profile,
                "{\"groupId\":null,\"pinned\":false,\"alias\":null}"))
        .andExpect(status().isNotFound())
        .andExpect(jsonPath("$.code").value("FAVORITE_MISSING"));
    mvc.perform(
            json(
                put("/api/v1/favorites/" + room + "/settings"),
                profile,
                "{\"groupId\":\"%s\",\"pinned\":false}".formatted(UUID.randomUUID())))
        .andExpect(status().isConflict())
        .andExpect(jsonPath("$.code").value("FAVORITE_GROUP_MISSING"));
    mvc.perform(
            json(
                put("/api/v1/favorites/" + room + "/settings"),
                profile,
                "{\"pinned\":false,\"alias\":\"%s\"}".formatted("x".repeat(61))))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
    mvc.perform(json(put("/api/v1/favorites/groups/" + a), profile, "{\"title\":\"   \"}"))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
    mvc.perform(
            json(
                put("/api/v1/favorites/groups/order"),
                profile,
                "{\"groupIds\":[\"%s\",\"%s\"]}".formatted(a, a)))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.code").value("FAVORITE_GROUP_ORDER_INVALID"));
    mvc.perform(
            json(
                put("/api/v1/favorites/groups/order"),
                profile,
                "{\"groupIds\":[\"%s\"]}".formatted(a)))
        .andExpect(status().isConflict())
        .andExpect(jsonPath("$.code").value("FAVORITE_GROUPS_CHANGED"));

    mvc.perform(delete("/api/v1/favorites/groups/" + a).header("Authorization", auth))
        .andExpect(status().isOk());
    mvc.perform(delete("/api/v1/favorites/groups/" + a).header("Authorization", auth))
        .andExpect(status().isOk());
    mvc.perform(get("/api/v1/favorites").header("Authorization", auth))
        .andExpect(jsonPath("$[0].groupId").value(nullValue()))
        .andExpect(jsonPath("$[0].pinned").value(true));

    // Соседние маршруты избранного не задеты: /{id} по-прежнему удаляет комнату из избранного.
    mvc.perform(delete("/api/v1/favorites/" + room).header("Authorization", auth))
        .andExpect(status().isOk());
    mvc.perform(get("/api/v1/favorites").header("Authorization", auth))
        .andExpect(jsonPath("$.length()").value(0));
  }
}
