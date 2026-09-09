package dev.mikki.stream.api;

import dev.mikki.stream.attachment.AttachmentService;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.media.MediaService;
import dev.mikki.stream.shared.Json;
import dev.mikki.stream.shared.Problem;
import io.livekit.server.WebhookReceiver;
import java.net.*;
import java.util.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/internal")
public class InternalController {
  private final MediaService media;
  private final AttachmentService files;
  private final WebhookReceiver receiver;

  public InternalController(MediaService media, AttachmentService files, StreamProperties config) {
    this.media = media;
    this.files = files;
    receiver = new WebhookReceiver(config.livekitKey(), config.livekitSecret());
  }

  @GetMapping("/signaling-auth")
  public void signaling(
      @RequestHeader(value = "Authorization", required = false) String authorization,
      @RequestHeader(value = "X-Media-Token", required = false) String mediaToken) {
    String token =
        mediaToken == null || mediaToken.isBlank()
            ? (authorization == null ? null : authorization.replaceFirst("^Bearer ", ""))
            : mediaToken;
    // Only the token forwarded from the actual signaling request may authorize it.
    // Arbitrary client headers such as X-Original-Uri must never override that token.
    if (token == null) throw Problem.forbidden();
    media.authorizeSignaling(token);
  }

  @GetMapping("/upload-auth")
  public void uploadAuth(
      @RequestHeader("X-Original-Uri") String uri,
      @RequestHeader("X-Original-Method") String method,
      @RequestHeader("Authorization") String credential) {
    var path = URI.create(uri).getPath();
    if (method.equals("POST") && path.equals("/uploads/"))
      return; // pre-create hook checks reservation, length and owner.
    if (!path.matches("/uploads/[0-9a-f-]{36}")) throw Problem.forbidden();
    files.authorizeUpload(path.substring("/uploads/".length()), credential, method);
  }

  @PostMapping("/tus")
  public Map<String, Object> hook(@RequestBody String body) {
    var hook = Json.tree(body);
    var event = hook.path("Event");
    var upload = event.path("Upload");
    switch (hook.path("Type").asText()) {
      case "pre-create" -> {
        try {
          String credential =
              event.path("HTTPRequest").path("Header").path("Authorization").path(0).asText();
          if (upload.path("SizeIsDeferred").asBoolean()
              || upload.path("IsPartial").asBoolean()
              || upload.path("IsFinal").asBoolean()) throw Problem.forbidden();
          String id =
              files.begin(
                  upload.path("MetaData").path("attachmentId").asText(),
                  credential,
                  upload.path("Size").asLong());
          return Map.of("ChangeFileInfo", Map.of("ID", id, "MetaData", Map.of("attachmentId", id)));
        } catch (Problem e) {
          return Map.of(
              "RejectUpload",
              true,
              "HTTPResponse",
              Map.of("StatusCode", e.status(), "Body", e.getMessage()));
        }
      }
      case "post-finish" ->
          files.complete(upload.path("ID").asText(), upload.path("Size").asLong());
      default -> throw Problem.forbidden();
    }
    return Map.of();
  }

  @PostMapping("/livekit")
  public void webhook(
      @RequestBody String body, @RequestHeader("Authorization") String authorization) {
    try {
      var event = receiver.receive(body, authorization);
      if (event.hasParticipant() && event.hasRoom())
        media.webhook(
            event.getRoom().getName(),
            event.getParticipant().getIdentity(),
            event.getParticipant().getSid(),
            event.getEvent(),
            event.getCreatedAt() * 1000);
    } catch (Exception e) {
      throw Problem.forbidden();
    }
  }
}
