package dev.mikki.stream.api;

import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.board.BoardRoom;
import dev.mikki.stream.board.BoardRooms;
import dev.mikki.stream.board.BoardStore;
import dev.mikki.stream.room.Permissions;
import dev.mikki.stream.room.Permissions.Action;
import dev.mikki.stream.room.RoomService;
import dev.mikki.stream.shared.Problem;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.Arrays;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * Картинки доски (R159): {@code PUT/GET /api/v1/rooms/{id}/board/files/{fileId}}.
 *
 * <p>Картинка на доске — элемент сцены со ссылкой {@code fileId}, а сами байты едут отдельно: в
 * правке штриха им не место (сокет режет сообщения на 96 КиБ, а картинка — до 4 МиБ). Браузер,
 * вставивший картинку, кладёт её сюда до того, как разослать элемент; остальные берут её отсюда,
 * когда элемент до них доехал.
 *
 * <p>ПРОВЕРКИ. Класть может тот, кому можно рисовать ({@code board.draw}), брать — любой участник.
 * Тип — только растровые PNG, JPEG, WebP и GIF, и не по заголовку, а по сигнатуре содержимого: SVG
 * и всё остальное, что браузер мог бы исполнить, не принимается. Предел — 32 картинки по 4 МиБ на
 * доску; полная доска сначала освобождает место от картинок, которых нет ни у одного видимого
 * элемента.
 */
@RestController
@RequestMapping("/api/v1/rooms/{id}/board/files")
public class BoardController {
  private static final Pattern FILE_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");

  private final RoomService rooms;
  private final BoardRooms boards;
  private final BoardStore store;
  private final RateLimits limits;

  public BoardController(
      RoomService rooms, BoardRooms boards, BoardStore store, RateLimits limits) {
    this.rooms = rooms;
    this.boards = boards;
    this.store = store;
    this.limits = limits;
  }

  @PutMapping("/{fileId}")
  public ResponseEntity<Void> put(
      @PathVariable UUID id,
      @PathVariable String fileId,
      @RequestHeader("Authorization") String credential,
      @RequestHeader(value = HttpHeaders.CONTENT_TYPE, required = false) String type,
      HttpServletRequest request)
      throws IOException {
    var roomId = id.toString();
    if (!FILE_ID.matcher(fileId).matches()) throw invalid();
    var room = rooms.read(roomId);
    var member = rooms.authenticate(room, credential);
    rooms.requireActive(room, member);
    if (room.board == null) throw Problem.conflict("BOARD_CLOSED", "Доска уже закрыта");
    if (!Permissions.allows(room, member, Action.BOARD_DRAW)) throw Problem.forbidden();
    limits.check("board-file:" + member.id, 60);
    var mime = mime(type);
    int max = boards.limits().maxFileBytes();
    if (request.getContentLengthLong() > max) throw tooLarge();
    byte[] data = request.getInputStream().readNBytes(max + 1);
    if (data.length > max) throw tooLarge();
    if (data.length == 0) throw invalid();
    if (!signed(mime, data))
      throw new Problem(415, "BOARD_FILE_TYPE", "На доску можно положить PNG, JPEG, WebP или GIF");
    var hub = boards.hub(roomId);
    if (hub.room().hasFile(fileId)) return ResponseEntity.noContent().build();
    var freed = hub.room().makeRoomForFile();
    if (freed == null)
      throw Problem.conflict(
          "BOARD_FILES_FULL", "На доске уже слишком много картинок. Удалите ненужные");
    store.deleteFiles(roomId, freed);
    store.putFile(roomId, fileId, mime, data, rooms.now());
    hub.room().addFile(new BoardRoom.FileMeta(fileId, mime, data.length));
    return ResponseEntity.noContent().build();
  }

  @GetMapping("/{fileId}")
  public ResponseEntity<byte[]> get(
      @PathVariable UUID id,
      @PathVariable String fileId,
      @RequestHeader("Authorization") String credential) {
    var roomId = id.toString();
    if (!FILE_ID.matcher(fileId).matches()) throw invalid();
    var room = rooms.read(roomId);
    var member = rooms.authenticate(room, credential);
    rooms.requireActive(room, member);
    limits.check("board-file-read:" + member.id, 600);
    var file =
        store
            .file(roomId, fileId)
            .orElseThrow(
                () -> new Problem(404, "BOARD_FILE_NOT_FOUND", "Картинки уже нет на доске"));
    return ResponseEntity.ok()
        .contentType(MediaType.parseMediaType(file.mime()))
        .contentLength(file.data().length)
        .header("X-Content-Type-Options", "nosniff")
        .header(HttpHeaders.CONTENT_DISPOSITION, "inline")
        .body(file.data());
  }

  private static Problem invalid() {
    return new Problem(400, "BOARD_FILE_INVALID", "Не удалось прочитать картинку");
  }

  private static Problem tooLarge() {
    return new Problem(413, "BOARD_FILE_TOO_LARGE", "Картинка для доски — не больше 4 МиБ");
  }

  /** Тип из заголовка — только из списка; параметры ({@code ; charset}) отбрасываются. */
  private static String mime(String type) {
    var value = type == null ? "" : type.split(";", 2)[0].strip().toLowerCase();
    return switch (value) {
      case "image/png", "image/jpeg", "image/webp", "image/gif" -> value;
      default ->
          throw new Problem(
              415, "BOARD_FILE_TYPE", "На доску можно положить PNG, JPEG, WebP или GIF");
    };
  }

  /** Содержимое того типа, что назван: по первым байтам файла. */
  static boolean signed(String mime, byte[] data) {
    return switch (mime) {
      case "image/png" ->
          starts(data, new byte[] {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'});
      case "image/jpeg" -> starts(data, new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff});
      case "image/gif" -> starts(data, "GIF87a".getBytes()) || starts(data, "GIF89a".getBytes());
      case "image/webp" ->
          data.length >= 12
              && starts(data, "RIFF".getBytes())
              && Arrays.equals(Arrays.copyOfRange(data, 8, 12), "WEBP".getBytes());
      default -> false;
    };
  }

  private static boolean starts(byte[] data, byte[] prefix) {
    return data.length >= prefix.length
        && Arrays.equals(Arrays.copyOfRange(data, 0, prefix.length), prefix);
  }
}
