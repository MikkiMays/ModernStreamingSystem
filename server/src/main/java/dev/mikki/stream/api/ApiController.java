package dev.mikki.stream.api;

import dev.mikki.stream.access.Entrant;
import dev.mikki.stream.access.Identity;
import dev.mikki.stream.access.ProofOfWork;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.access.ServerAccess;
import dev.mikki.stream.application.CommandDispatcher;
import dev.mikki.stream.attachment.AttachmentService;
import dev.mikki.stream.config.Level;
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
      String region,
      // What the connect screen needs before it may ask for anything: how this server calls
      // itself, and whether it will want a password.
      String name,
      boolean passwordRequired,
      // Правила качества видео: сервер задаёт, клиент исполняет (П2). `resolutions` и
      // `frameRates` выше — список допустимого, выведенный из потолка; здесь — умолчание, сам
      // потолок и окно разгона.
      QualityRules quality,
      // Сколько встреч профиль устройства хранит в избранном (T06, П3): интерфейс пишет «N из
      // этого числа», не зашивая его. Сколько людей во встрече — `maxParticipants` выше, без ботов.
      int favoritesMax) {}

  public record QualityRules(
      @com.fasterxml.jackson.annotation.JsonProperty("default") Level initial,
      Level ceiling,
      long settleMs,
      boolean cameraYieldsToScreen) {}

  public record Screen(@NotNull UUID commandId, boolean enabled) {}

  private final RoomService rooms;
  private final MediaService media;
  private final CommandDispatcher commands;
  private final AttachmentService files;
  private final StreamProperties config;
  private final RateLimits limits;
  private final ServerAccess access;
  private final ClientAddress address;
  private final Identity identity;
  private final ProofOfWork proofs;

  public ApiController(
      RoomService rooms,
      MediaService media,
      CommandDispatcher commands,
      AttachmentService files,
      StreamProperties config,
      RateLimits limits,
      ServerAccess access,
      ClientAddress address,
      Identity identity,
      ProofOfWork proofs) {
    this.rooms = rooms;
    this.media = media;
    this.commands = commands;
    this.files = files;
    this.config = config;
    this.limits = limits;
    this.access = access;
    this.address = address;
    this.identity = identity;
    this.proofs = proofs;
  }

  @GetMapping("/ping")
  public Map<String, Long> ping() {
    return Map.of("serverTime", System.currentTimeMillis());
  }

  @GetMapping("/capabilities")
  public Capabilities capabilities() {
    var quality = config.media().quality();
    return new Capabilities(
        config.maxParticipants(),
        config.maxScreens(),
        config.recoverySeconds(),
        config.fileMaxBytes(),
        config.roomMaxBytes(),
        Level.RESOLUTIONS.stream().filter(r -> r <= quality.ceiling().resolution()).toList(),
        Level.FRAME_RATES.stream().filter(f -> f <= quality.ceiling().fps()).toList(),
        config.admissionOpen(),
        "Europe",
        access.name(),
        access.required(),
        new QualityRules(
            quality.initial(),
            quality.ceiling(),
            quality.settle().toMillis(),
            quality.cameraYieldsToScreen()),
        config.favorites().maxSaved());
  }

  /*
   Четыре двери во встречу ниже (и пятая — `/favorites/{id}/join`) передают ядру, кто входит:
   профиль устройства из `X-Cord-Profile`, встречу из `X-Cord-Leave`, если человек согласился её
   покинуть (T52), и ключ адреса для пределов антибота (E11). Тела запросов от этого не меняются.
  */

  /**
   * Задача «не бот» на действие {@code create} или {@code code} (E11-B, {@link ProofOfWork}).
   *
   * <p>Браузер просит её, как только открыта форма, и решает в фоне — к нажатию ответ готов. Задача
   * дорожает вчетверо, если адрес уже выбрал половину своего предела, и ввосьмеро, пока включён
   * «щит». При {@code human-check: off} ответ пустой ({@code 204}), и браузер ничего не решает.
   */
  @GetMapping("/proof")
  public ResponseEntity<ProofOfWork.Challenge> proof(
      @RequestParam("for") String action, HttpServletRequest http) {
    if (!action.equals("create") && !action.equals("code"))
      throw new IllegalArgumentException("Unknown proof action");
    var abuse = config.abuse();
    if (abuse.humanCheck() == StreamProperties.Abuse.HumanCheck.OFF)
      return ResponseEntity.noContent().build();
    var key = address.of(http);
    limits.check("proof-issue:" + key, 60);
    var pressure =
        action.equals("create")
            ? limits.count("rooms:ip:" + key, abuse.perIp().roomsCreated()) * 2
                >= abuse.perIp().roomsCreated().count()
            : limits.count("code-miss:" + key, abuse.perIp().codeMisses()) * 2
                >= abuse.perIp().codeMisses().count();
    long cost = (long) abuse.proofCost() * (rooms.shielded() ? 8 : 1) * (pressure ? 4 : 1);
    return ResponseEntity.ok(proofs.issue(action, key, cost));
  }

  /** Кто входит — с ключом адреса; людская проверка «не бот» — для всех, кроме наших служб. */
  private Entrant entrant(HttpServletRequest http, String proofFor) {
    var key = address.of(http);
    var abuse = config.abuse().perIp();
    var service = address.service(http);
    if (proofFor != null) {
      limits.check(
          (proofFor.equals("code") ? "code-admission:" : "admission:") + key,
          proofFor.equals("code") ? abuse.codeJoins() : abuse.admissions());
      if (!service && config.abuse().humanCheck() != StreamProperties.Abuse.HumanCheck.OFF)
        proofs.verify(http.getHeader(ProofOfWork.HEADER), proofFor, key);
    } else limits.check("admission:" + key, abuse.admissions());
    return identity.entrant(http).from(address.entrant(http));
  }

  @PostMapping("/rooms")
  public Contracts.Admission create(
      @Valid @RequestBody Contracts.Create request, HttpServletRequest http) {
    return rooms.create(request, entrant(http, "create"));
  }

  @PostMapping("/rooms/{id}/join")
  public Contracts.Admission join(
      @PathVariable UUID id, @Valid @RequestBody Contracts.Join request, HttpServletRequest http) {
    return rooms.join(id.toString(), request, entrant(http, null));
  }

  @GetMapping("/rooms/{id}")
  public Contracts.Snapshot snapshot(
      @PathVariable UUID id, @RequestHeader("Authorization") String credential) {
    return rooms.snapshot(id.toString(), credential);
  }

  /**
   * История игр этой беседы: чем кончилась каждая.
   *
   * <p>Отдельная ручка, а не поле снимка: итоги десяти игр — это килобайты таблиц, и пересылать их
   * на каждое чужое повышение незачем. Спрашивают их тогда, когда открывают историю.
   */
  @GetMapping("/rooms/{id}/games")
  public List<dev.mikki.stream.game.GameSummary> games(
      @PathVariable UUID id, @RequestHeader("Authorization") String credential) {
    return rooms.games(id.toString(), credential);
  }

  /** То же самое для дурака: итоги партий этой беседы вместе со счётом вечера. */
  @GetMapping("/rooms/{id}/durak-games")
  public List<dev.mikki.stream.game.DurakSummary> durakGames(
      @PathVariable UUID id, @RequestHeader("Authorization") String credential) {
    return rooms.durakGames(id.toString(), credential);
  }

  @PostMapping("/rooms/join-by-code")
  public Contracts.Admission joinCode(
      @Valid @RequestBody Contracts.JoinCode request, HttpServletRequest http) {
    return rooms.joinCode(request, entrant(http, "code"));
  }

  @PostMapping("/rooms/{id}/rejoin")
  public Contracts.Admission rejoin(
      @PathVariable UUID id,
      @RequestHeader("Authorization") String credential,
      @Valid @RequestBody Contracts.Rejoin request,
      HttpServletRequest http) {
    return rooms.rejoin(id.toString(), credential, request, entrant(http, null));
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
    limits.command(credential, command.type());
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
}
