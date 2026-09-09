package dev.mikki.stream.api;

import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.application.CommandDispatcher;
import dev.mikki.stream.attachment.AttachmentService;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.media.*;
import dev.mikki.stream.room.*;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1")
public class ApiController {
  public record Capabilities(
      int maxParticipants,
      int maxScreens,
      int recoverySeconds,
      long fileMaxBytes,
      long roomMaxBytes,
      List<Integer> resolutions,
      List<Integer> frameRates,
      boolean admissionOpen,
      String region) {}

  public record Screen(@NotNull UUID commandId, boolean enabled) {}

  private final RoomService rooms;
  private final MediaService media;
  private final CommandDispatcher commands;
  private final AttachmentService files;
  private final StreamProperties config;
  private final RateLimits limits;

  public ApiController(
      RoomService rooms,
      MediaService media,
      CommandDispatcher commands,
      AttachmentService files,
      StreamProperties config,
      RateLimits limits) {
    this.rooms = rooms;
    this.media = media;
    this.commands = commands;
    this.files = files;
    this.config = config;
    this.limits = limits;
  }

  @GetMapping("/ping")
  public Map<String, Long> ping() {
    return Map.of("serverTime", System.currentTimeMillis());
  }

  @GetMapping("/capabilities")
  public Capabilities capabilities() {
    return new Capabilities(
        config.maxParticipants(),
        config.maxScreens(),
        config.recoverySeconds(),
        config.fileMaxBytes(),
        config.roomMaxBytes(),
        List.of(720, 1080, 1440),
        List.of(15, 30, 60),
        config.admissionOpen(),
        "Europe");
  }

  @PostMapping("/rooms")
  public Contracts.Admission create(
      @Valid @RequestBody Contracts.Create request, HttpServletRequest http) {
    limits.check("admission:" + clientIp(http), 30);
    return rooms.create(request);
  }

  @PostMapping("/rooms/{id}/join")
  public Contracts.Admission join(
      @PathVariable UUID id, @Valid @RequestBody Contracts.Join request, HttpServletRequest http) {
    limits.check("admission:" + clientIp(http), 30);
    return rooms.join(id.toString(), request);
  }

  @GetMapping("/rooms/{id}")
  public Contracts.Snapshot snapshot(
      @PathVariable UUID id, @RequestHeader("Authorization") String credential) {
    return rooms.snapshot(id.toString(), credential);
  }

  @PostMapping("/rooms/join-by-code")
  public Contracts.Admission joinCode(
      @Valid @RequestBody Contracts.JoinCode request, HttpServletRequest http) {
    limits.check("code-admission:" + clientIp(http), 10);
    return rooms.joinCode(request);
  }

  @PostMapping("/rooms/{id}/rejoin")
  public Contracts.Admission rejoin(
      @PathVariable UUID id,
      @RequestHeader("Authorization") String credential,
      @Valid @RequestBody Contracts.Rejoin request,
      HttpServletRequest http) {
    limits.check("admission:" + clientIp(http), 30);
    return rooms.rejoin(id.toString(), credential, request);
  }

  @GetMapping("/rooms/{id}/events")
  public Contracts.Replay replay(
      @PathVariable UUID id,
      @RequestHeader("Authorization") String credential,
      @RequestParam(defaultValue = "-1") long after) {
    return rooms.replay(id.toString(), credential, after);
  }

  @PostMapping("/rooms/{id}/resume")
  public Contracts.Replay resume(
      @PathVariable UUID id,
      @RequestHeader("Authorization") String credential,
      @Valid @RequestBody Contracts.Resume request) {
    var room = rooms.read(id.toString());
    var member = rooms.authenticate(room, credential);
    rooms.requireActive(room, member);
    return rooms.replay(room.id, credential, request.after());
  }

  @PostMapping("/rooms/{id}/commands")
  public Contracts.Ack command(
      @PathVariable UUID id,
      @RequestHeader("Authorization") String credential,
      @Valid @RequestBody Contracts.Command command) {
    limits.check("command:" + Secrets.hash(credential.replaceFirst("^Bearer ", "")), 120);
    return commands.execute(id.toString(), credential, command);
  }

  @PostMapping("/rooms/{id}/media/token")
  public Contracts.MediaToken token(
      @PathVariable UUID id, @RequestHeader("Authorization") String credential) {
    limits.check("token:" + Secrets.hash(credential), 60);
    return media.token(id.toString(), credential);
  }

  @PostMapping("/rooms/{id}/media/screen")
  public Contracts.Ack screen(
      @PathVariable UUID id,
      @RequestHeader("Authorization") String credential,
      @Valid @RequestBody Screen screen) {
    return media.screen(id.toString(), credential, screen.commandId(), screen.enabled());
  }

  @GetMapping("/rooms/{id}/attachments")
  public List<AttachmentService.Attachment> files(
      @PathVariable UUID id, @RequestHeader("Authorization") String credential) {
    return files.list(id.toString(), credential);
  }

  @PostMapping("/rooms/{id}/attachments")
  public AttachmentService.Attachment reserve(
      @PathVariable UUID id,
      @RequestHeader("Authorization") String credential,
      @Valid @RequestBody AttachmentService.Reserve request) {
    limits.check("file:" + Secrets.hash(credential), 30);
    return files.reserve(id.toString(), credential, request);
  }

  @DeleteMapping("/attachments/{id}")
  public void cancel(@PathVariable UUID id, @RequestHeader("Authorization") String credential) {
    files.cancel(id.toString(), credential);
  }

  @GetMapping("/attachments/{id}/content")
  public ResponseEntity<FileSystemResource> download(
      @PathVariable UUID id, @RequestHeader("Authorization") String credential) {
    var file = files.download(id.toString(), credential);
    return ResponseEntity.ok()
        .contentType(MediaType.APPLICATION_OCTET_STREAM)
        .contentLength(file.size())
        .header(
            HttpHeaders.CONTENT_DISPOSITION,
            ContentDisposition.attachment()
                .filename(file.name(), StandardCharsets.UTF_8)
                .build()
                .toString())
        .header("X-Content-Type-Options", "nosniff")
        .header(HttpHeaders.CACHE_CONTROL, "no-store")
        .body(new FileSystemResource(files.path(id.toString())));
  }

  private String clientIp(HttpServletRequest request) {
    String forwarded = request.getHeader("X-Real-IP");
    return forwarded != null
            && Secrets.equal(request.getHeader("X-Internal-Secret"), config.internalSecret())
        ? forwarded
        : request.getRemoteAddr();
  }
}
