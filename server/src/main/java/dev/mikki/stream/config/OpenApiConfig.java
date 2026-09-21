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
      schemas
          .get("Command")
          .getProperties()
          .put(
              "type",
              new io.swagger.v3.oas.models.media.StringSchema()
                  ._enum(
                      List.of(
                          "leave",
                          "close",
                          "invite.create",
                          "invite.revoke",
                          "participant.remove",
                          "participant.approve",
                          "message.send",
                          "media.lost",
                          "media.restored",
                          "screen.started",
                          "view.open",
                          "view.close",
                          "view.playing",
                          "microphone.mute",
                          "profile.avatar",
                          "watch.open",
                          "watch.play",
                          "watch.pause",
                          "watch.seek",
                          "watch.close",
                          "poker.open",
                          "poker.close",
                          "poker.sit",
                          "poker.stand",
                          "poker.deal",
                          "poker.act",
                          "poker.settings",
                          "poker.rebuy",
                          "poker.reveal")));
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
                          "screen.first_viewer")));
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
              "Event",
              "EventPayload",
              "Replay",
              "Watch",
              "Capabilities",
              "TableView",
              "SeatView",
              "PotView",
              "NoteView",
              "ResultView",
              "AwardView",
              "YouView")) {
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
      Map<String, List<String>> nullable =
          Map.of(
              "Admission",
              List.of("inviteUrl"),
              "Participant",
              List.of("recoveryDeadline", "service", "screenId", "viewingScreenId"),
              "Snapshot",
              // Смотреть и играть вместе может быть нечего — и чаще всего нечего.
              List.of("closedAt", "watch", "poker"),
              // Пустое место — это место без человека; итог есть только у сыгранной раздачи;
              // кнопок нет у того, кто не сидит за столом.
              "SeatView",
              List.of("memberId"),
              "TableView",
              List.of("result", "you"),
              "Ack",
              List.of("value"),
              "Attachment",
              List.of("uploadId", "completedAt", "sha256", "cancelledAt"),
              "EventPayload",
              List.of("message", "screenId", "participantId"),
              "Replay",
              List.of("snapshot"));
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
