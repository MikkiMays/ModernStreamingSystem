package dev.mikki.stream.config;

import java.util.*;
import org.springdoc.core.customizers.OpenApiCustomizer;
import org.springframework.context.annotation.*;

@Configuration
public class OpenApiConfig {
  @Bean
  OpenApiCustomizer explicitResponseContracts() {
    return api -> {
      api.getInfo().setTitle("ModernStreamingSystem API");
      api.getInfo().setVersion("1.0.0");
      var schemas = api.getComponents().getSchemas();
      // Типы команд — из одного места с проверкой запроса: второй список рано или поздно
      // разойдётся с первым, и разойдётся он молча (dev.mikki.stream.room.Contracts).
      schemas
          .get("Command")
          .getProperties()
          .put(
              "type",
              new io.swagger.v3.oas.models.media.StringSchema()
                  ._enum(dev.mikki.stream.room.Contracts.commandTypes()));
      schemas
          .get("Event")
          .getProperties()
          .put(
              "type",
              new io.swagger.v3.oas.models.media.StringSchema()
                  ._enum(
                      List.of(
                          "room.changed",
                          "message.created",
                          "files.changed",
                          "screen.started",
                          "screen.first_viewer",
                          "meeting.warning")));
      for (String name :
          List.of(
              "Admission",
              "Participant",
              "Snapshot",
              "Message",
              "Ack",
              "MediaToken",
              "Attachment",
              "Favorite",
              "Group",
              "Event",
              "EventPayload",
              "Replay",
              "Watch",
              "RoomYou",
              "Capabilities",
              "QualityRules",
              "Level",
              "TableView",
              "SeatView",
              "PotView",
              "NoteView",
              "ResultView",
              "AwardView",
              "YouView",
              "GameSummary",
              "PlayerSummary",
              "Highlight",
              "DurakView",
              "CardPair",
              "DurakSeat",
              "DurakNote",
              "DurakYou",
              "DurakPlay",
              "DurakScore",
              "DurakSummary",
              "DurakPlayer",
              "DurakResult",
              "GameVisualEvent",
              "DurakReaction",
              "ChessView",
              "ChessPlayer",
              "ChessMove",
              "GarticView",
              "GarticPlayer",
              "GarticYou",
              "GarticStroke",
              "GarticEntry",
              "GarticAlbum",
              "GarticGuess")) {
        var schema = schemas.get(name);
        if (schema != null && schema.getProperties() != null)
          schema.setRequired(new ArrayList<>(schema.getProperties().keySet()));
      }
      // Additive fields are optional so old clients and persisted snapshots remain valid.
      schemas
          .get("Participant")
          .getRequired()
          .removeAll(List.of("screenId", "screenStarted", "viewingScreenId"));
      schemas.get("EventPayload").getRequired().removeAll(List.of("screenId", "participantId"));
      schemas
          .get("Snapshot")
          .getRequired()
          .removeAll(List.of("chess", "gartic", "you", "startedAt", "endsAt", "cinemaTraffic"));
      // «Вы ещё здесь?» спрашивают не всегда (A2, E10-B).
      schemas.get("RoomYou").getRequired().remove("presenceBy");
      schemas.get("TableView").getRequired().remove("visualEvents");
      schemas
          .get("DurakView")
          .getRequired()
          .removeAll(List.of("visualEvents", "reactions", "paused", "pausedAt", "pausedRemaining"));
      schemas.get("DurakYou").getRequired().remove("plays");
      // Группы избранного (T40): группа и своё имя есть не у каждой комнаты.
      schemas.get("Favorite").getRequired().removeAll(List.of("groupId", "alias"));
      // Решение стола за игрока (T07) — новое поле; прежнее ядро его не присылает.
      schemas.get("DurakSeat").getRequired().remove("auto");
      schemas
          .get("DurakSeat")
          .getProperties()
          .put(
              "auto",
              new io.swagger.v3.oas.models.media.StringSchema()._enum(List.of("pass", "take")));
      schemas
          .get("DurakPlay")
          .getProperties()
          .put(
              "option",
              new io.swagger.v3.oas.models.media.StringSchema()
                  ._enum(List.of("attack", "beat", "transfer")));
      schemas
          .get("GameVisualEvent")
          .getProperties()
          .put(
              "type",
              new io.swagger.v3.oas.models.media.StringSchema()
                  ._enum(List.of("deal", "draw", "play", "transfer", "take", "discard")));
      Map<String, List<String>> nullable =
          Map.ofEntries(
              Map.entry("Admission", List.of("inviteUrl")),
              Map.entry(
                  "Participant",
                  List.of("recoveryDeadline", "service", "screenId", "viewingScreenId")),
              // Смотреть и играть вместе может быть нечего — и чаще всего нечего. Прав нет у
              // постороннего: снимок без зрителя. Начала нет, пока на связи не было двоих.
              Map.entry(
                  "Snapshot",
                  List.of(
                      "closedAt",
                      "watch",
                      "poker",
                      "durak",
                      "chess",
                      "gartic",
                      "you",
                      "startedAt",
                      "endsAt",
                      "cinemaTraffic")),
              Map.entry("ChessView", List.of("white", "black", "result", "winner", "drawOffer")),
              Map.entry("GarticView", List.of("drawerId", "you", "answer", "hint", "revealed")),
              Map.entry("GarticYou", List.of("prompt", "previous")),
              Map.entry("GarticEntry", List.of("text")),
              // Пустое место — это место без человека; итог есть только у сыгранной раздачи;
              // кнопок нет у того, кто не сидит за столом.
              Map.entry("SeatView", List.of("memberId")),
              // Итоги есть только у законченной игры.
              Map.entry("TableView", List.of("result", "you", "summary")),
              // У дурака то же самое: карты и козырь появляются с раздачей, зерно — после
              // партии, а кнопок нет у того, кто за столом не сидит.
              Map.entry(
                  "DurakView",
                  List.of("trump", "trumpSuit", "boutEnd", "you", "result", "commitment", "seed")),
              Map.entry("DurakSeat", List.of("memberId", "auto")),
              Map.entry("DurakPlay", List.of("under")),
              Map.entry("GameVisualEvent", List.of("fromSeat", "toSeat")),
              // Карта лежит неотбитой ровно до тех пор, пока её не побили.
              Map.entry("CardPair", List.of("beat")),
              Map.entry("Ack", List.of("value")),
              Map.entry("RoomYou", List.of("presenceBy")),
              // Комната без группы и без своего имени — обычное дело; null в настройках и
              // означает «убрать из группы», «вернуть название комнаты».
              Map.entry("Favorite", List.of("groupId", "alias")),
              Map.entry("FavoriteSettings", List.of("groupId", "alias")),
              Map.entry("Attachment", List.of("uploadId", "completedAt", "sha256", "cancelledAt")),
              Map.entry("EventPayload", List.of("message", "screenId", "participantId")),
              Map.entry("Replay", List.of("snapshot")));
      nullable.forEach(
          (name, fields) -> {
            var schema = schemas.get(name);
            if (schema != null)
              for (var field : fields) {
                var property =
                    (io.swagger.v3.oas.models.media.Schema<?>) schema.getProperties().get(field);
                if (property != null) {
                  if (property.get$ref() != null) {
                    var nullableRef = new io.swagger.v3.oas.models.media.ComposedSchema();
                    nullableRef.setOneOf(
                        List.of(
                            new io.swagger.v3.oas.models.media.Schema<>().$ref(property.get$ref()),
                            new io.swagger.v3.oas.models.media.Schema<>().types(Set.of("null"))));
                    schema.getProperties().put(field, nullableRef);
                    continue;
                  }
                  var types = new HashSet<String>();
                  if (property.getTypes() != null) types.addAll(property.getTypes());
                  if (property.getType() != null) types.add(property.getType());
                  types.add("null");
                  property.setTypes(types);
                  property.setNullable(true);
                }
              }
          });
    };
  }
}
