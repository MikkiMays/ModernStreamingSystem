package dev.mikki.stream.attachment;

import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.room.*;
import dev.mikki.stream.shared.Problem;
import jakarta.validation.constraints.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AttachmentService {
  public record Reserve(
      @NotNull UUID commandId, @NotBlank @Size(max = 255) String name, @Min(1) long size) {}

  public record Attachment(
      String id,
      String roomId,
      String ownerId,
      String name,
      long size,
      long createdAt,
      String uploadId,
      Long completedAt,
      String sha256,
      long expiresAt,
      Long cancelledAt,
      /**
       * Может ли файл запустить программу — по настоящему расширению имени (A7 модели угроз).
       * Интерфейс показывает такому файлу предупреждение перед скачиванием ({@code
       * stream.chat.executable-attachments: warn}).
       */
      boolean executable) {}

  /**
   * Расширения, под которыми файл может запустить программу или спрятать её: исполняемые файлы
   * Windows, Android и macOS, сценарии, ярлыки, образы дисков, документы с макросами и архивы.
   */
  static final java.util.Set<String> EXECUTABLE =
      java.util.Set.of(
          "exe",
          "msi",
          "msix",
          "msixbundle",
          "appx",
          "appxbundle",
          "bat",
          "cmd",
          "com",
          "scr",
          "pif",
          "cpl",
          "ps1",
          "psm1",
          "vbs",
          "vbe",
          "js",
          "jse",
          "wsf",
          "wsh",
          "hta",
          "jar",
          "lnk",
          "url",
          "reg",
          "dll",
          "sys",
          "apk",
          "xapk",
          "aab",
          "iso",
          "img",
          "vhd",
          "vhdx",
          "dmg",
          "pkg",
          "app",
          "deb",
          "rpm",
          "sh",
          "run",
          "docm",
          "xlsm",
          "pptm",
          "zip",
          "rar",
          "7z",
          "cab",
          "gz",
          "tgz",
          "tar",
          "xz",
          "bz2");

  /** Запускает ли файл с таким именем программу: решает последнее расширение, а не первое. */
  public static boolean executable(String name) {
    int dot = name == null ? -1 : name.lastIndexOf('.');
    return dot >= 0
        && EXECUTABLE.contains(name.substring(dot + 1).strip().toLowerCase(java.util.Locale.ROOT));
  }

  private final RoomService rooms;
  private final RoomRepository repository;
  private final StreamProperties config;
  private final TusGateway tus;

  public AttachmentService(
      RoomService rooms, RoomRepository repository, StreamProperties config, TusGateway tus) {
    this.rooms = rooms;
    this.repository = repository;
    this.config = config;
    this.tus = tus;
  }

  private Attachment map(java.sql.ResultSet rs, int row) throws java.sql.SQLException {
    return new Attachment(
        rs.getString("id"),
        rs.getString("room_id"),
        rs.getString("owner_id"),
        rs.getString("name"),
        rs.getLong("size_bytes"),
        rs.getLong("created_at"),
        rs.getString("upload_id"),
        rs.getObject("completed_at", Long.class),
        rs.getString("sha256"),
        rs.getObject("expires_at") == null ? 0 : rs.getLong("expires_at"),
        rs.getObject("cancelled_at", Long.class),
        executable(rs.getString("name")));
  }

  public Attachment get(String id) {
    return repository
        .jdbc()
        .sql("SELECT * FROM attachments WHERE id=?")
        .param(id)
        .query(this::map)
        .optional()
        .orElseThrow(() -> new Problem(404, "FILE_NOT_FOUND", "Файл не найден"));
  }

  private long expires(Attachment a, RoomState room) {
    if (a.cancelledAt() != null) return a.cancelledAt();
    long expiry =
        a.completedAt() == null
            ? Math.min(
                a.createdAt() + config.uploadTimeoutSeconds() * 1000L,
                rooms.expiry(a.createdAt(), room))
            : rooms.expiry(a.createdAt(), room);
    return Math.min(expiry, a.expiresAt() == 0 ? Long.MAX_VALUE : a.expiresAt());
  }

  private Attachment view(Attachment a, RoomState room) {
    return new Attachment(
        a.id(),
        a.roomId(),
        a.ownerId(),
        a.name(),
        a.size(),
        a.createdAt(),
        a.uploadId(),
        a.completedAt(),
        a.sha256(),
        expires(a, room),
        a.cancelledAt(),
        a.executable());
  }

  public List<Attachment> list(String roomId, String credential) {
    var room = rooms.read(roomId);
    var member = rooms.authenticate(room, credential);
    if (!rooms.historyAllowed(room, member)) return List.of();
    return repository
        .jdbc()
        .sql("SELECT * FROM attachments WHERE room_id=? ORDER BY created_at")
        .param(roomId)
        .query(this::map)
        .list()
        .stream()
        .filter(
            a ->
                expires(a, room) > rooms.now()
                    && (a.completedAt() != null || a.ownerId().equals(member.id)))
        .map(a -> view(a, room))
        .toList();
  }

  @Transactional
  public Attachment reserve(String roomId, String credential, Reserve request) {
    repository.lockGlobal();
    var room = rooms.lock(roomId);
    var member = rooms.authenticate(room, credential);
    rooms.requireActive(room, member);
    return rooms.receipt(
        "file:" + roomId + ":" + member.id,
        request.commandId(),
        request,
        Attachment.class,
        () -> {
          if (request.size() > config.fileMaxBytes())
            throw new Problem(413, "FILE_TOO_LARGE", "Максимальный размер файла — 100 МиБ");
          var pending =
              repository
                  .jdbc()
                  .sql(
                      "SELECT COUNT(*) FROM attachments WHERE owner_id=? AND completed_at IS NULL AND cancelled_at IS NULL AND created_at>?")
                  .params(member.id, rooms.now() - config.uploadTimeoutSeconds() * 1000L)
                  .query(Long.class)
                  .single();
          if (pending > 0)
            throw Problem.conflict("UPLOAD_BUSY", "Дождитесь завершения текущей загрузки");
          long total =
              repository
                  .jdbc()
                  .sql("SELECT COALESCE(SUM(size_bytes),0) FROM attachments")
                  .query(Long.class)
                  .single();
          long roomTotal =
              repository
                  .jdbc()
                  .sql("SELECT COALESCE(SUM(size_bytes),0) FROM attachments WHERE room_id=?")
                  .param(roomId)
                  .query(Long.class)
                  .single();
          if (request.size() > config.totalMaxBytes() - total
              || request.size() > config.roomMaxBytes() - roomTotal)
            throw new Problem(413, "QUOTA_EXCEEDED", "Недостаточно места для вложения");
          // Подмена направления (U+202E) и невидимые символы уходят из имени: `счёт‮fdp.exe` в
          // списке выглядел бы как `счётexe.pdf` (A7). Решает настоящее расширение.
          String name = Names.clean(request.name()).replaceAll("[/\\\\]", "_");
          if (name.isEmpty()) name = "файл";
          if (executable(name)
              && config.chat().executableAttachments() == StreamProperties.Chat.Executables.BLOCK)
            throw new Problem(
                415,
                "FILE_TYPE_BLOCKED",
                "Такие файлы на этом сервере не принимаются: они могут запустить программу");
          var id = UUID.randomUUID().toString();
          repository
              .jdbc()
              .sql(
                  "INSERT INTO attachments(id,room_id,owner_id,name,size_bytes,created_at) VALUES(?,?,?,?,?,?)")
              .params(id, roomId, member.id, name, request.size(), rooms.now())
              .update();
          return view(get(id), room);
        });
  }

  @Transactional
  public String begin(String id, String credential, long size) {
    repository.lockGlobal();
    var a = get(id);
    var room = rooms.lock(a.roomId());
    var member = rooms.authenticate(room, credential);
    rooms.requireActive(room, member);
    if (!member.id.equals(a.ownerId())
        || a.size() != size
        || expires(a, room) <= rooms.now()
        || a.uploadId() != null) throw Problem.forbidden();
    repository.jdbc().sql("UPDATE attachments SET upload_id=? WHERE id=?").params(id, id).update();
    return id;
  }

  public void authorizeUpload(String id, String credential, String method) {
    if (!Set.of("HEAD", "PATCH").contains(method)) throw Problem.forbidden();
    var a = get(id);
    var room = rooms.read(a.roomId());
    var member = rooms.authenticate(room, credential);
    rooms.requireActive(room, member);
    if (!member.id.equals(a.ownerId())
        || expires(a, room) <= rooms.now()
        || a.uploadId() == null
        || a.completedAt() != null && method.equals("PATCH")) throw Problem.forbidden();
  }

  @Transactional
  public void complete(String id, long size) {
    var a = get(id);
    var room = rooms.lock(a.roomId());
    if (a.completedAt() != null) return;
    if (a.uploadId() == null || expires(a, room) <= rooms.now() || a.size() != size)
      throw Problem.forbidden();
    try {
      var path = path(id);
      if (Files.size(path) != a.size()) throw Problem.forbidden();
      var digest = MessageDigest.getInstance("SHA-256");
      try (var input = Files.newInputStream(path)) {
        byte[] buffer = new byte[65536];
        int n;
        while ((n = input.read(buffer)) != -1) digest.update(buffer, 0, n);
      }
      repository
          .jdbc()
          .sql("UPDATE attachments SET completed_at=?,sha256=? WHERE id=?")
          .params(rooms.now(), HexFormat.of().formatHex(digest.digest()), id)
          .update();
      rooms.emit(room, "files.changed", Contracts.EventPayload.changed());
      repository.save(room, rooms.now());
    } catch (java.io.IOException | java.security.NoSuchAlgorithmException e) {
      throw new Problem(503, "FILE_NOT_READY", "Файл ещё обрабатывается");
    }
  }

  public Path path(String id) {
    if (!id.matches("[0-9a-f-]{36}")) throw Problem.forbidden();
    var root = config.filesRoot().toAbsolutePath().normalize();
    var path = root.resolve(id).normalize();
    if (!path.getParent().equals(root) || Files.isSymbolicLink(path)) throw Problem.forbidden();
    return path;
  }

  public Attachment download(String id, String credential) {
    var a = get(id);
    var room = rooms.read(a.roomId());
    if (!rooms.historyAllowed(room, rooms.authenticate(room, credential)))
      throw Problem.forbidden();
    if (a.completedAt() == null || expires(a, room) <= rooms.now())
      throw new Problem(410, "FILE_EXPIRED", "Файл недоступен или удалён");
    return view(a, room);
  }

  @Transactional
  public void cancel(String id, String credential) {
    repository.lockGlobal();
    var a = get(id);
    var room = rooms.lock(a.roomId());
    var m = rooms.authenticate(room, credential);
    if (!a.ownerId().equals(m.id)) throw Problem.forbidden();
    repository
        .jdbc()
        .sql("UPDATE attachments SET cancelled_at=? WHERE id=?")
        .params(rooms.now(), id)
        .update();
    rooms.emit(room, "files.changed", Contracts.EventPayload.changed());
    repository.save(room, rooms.now());
  }

  private void delete(Attachment a) {
    // No database transaction/room lock may be held while waiting for tusd:
    // the active PATCH's completion hook may need that same room lock.
    if (a.uploadId() != null && !tus.terminate(a.uploadId())) return;
    try {
      Files.deleteIfExists(path(a.id()));
      Files.deleteIfExists(path(a.id()).resolveSibling(a.id() + ".info"));
      repository.jdbc().sql("DELETE FROM attachments WHERE id=?").param(a.id()).update();
    } catch (java.io.IOException e) {
      /* Keep quota reserved; the next sweep retries deletion. */
    }
  }

  @Scheduled(fixedDelay = 60000)
  public void sweep() {
    for (var a : repository.jdbc().sql("SELECT * FROM attachments").query(this::map).list()) {
      var room = rooms.read(a.roomId());
      if (expires(a, room) <= rooms.now()) delete(a);
    }
    sweepOrphans();
  }

  private void sweepOrphans() {
    var root = config.filesRoot().toAbsolutePath().normalize();
    if (!Files.isDirectory(root)) return;
    try (var paths = Files.list(root)) {
      for (var file :
          paths.filter(p -> p.getFileName().toString().matches("[0-9a-f-]{36}")).toList()) {
        // Allow an in-flight pre-create hook to finish before checking metadata.
        if (Files.isSymbolicLink(file)
            || Files.getLastModifiedTime(file).toMillis() > rooms.now() - 60000) continue;
        String id = file.getFileName().toString();
        if (repository
                    .jdbc()
                    .sql("SELECT COUNT(*) FROM attachments WHERE id=?")
                    .param(id)
                    .query(Long.class)
                    .single()
                == 0
            && tus.terminate(id)) {
          Files.deleteIfExists(path(id));
          Files.deleteIfExists(root.resolve(id + ".info"));
        }
      }
    } catch (java.io.IOException ignored) {
      /* Retry on the next minute pass. */
    }
  }
}
