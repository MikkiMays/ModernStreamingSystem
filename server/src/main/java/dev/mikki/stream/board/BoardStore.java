package dev.mikki.stream.board;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * Доска в базе (R159): сцена одной строкой {@code room_boards} (JSON элементов в gzip) и картинки в
 * {@code room_board_files}. Обе таблицы стоят на {@code ON DELETE CASCADE} к комнате — удалённая
 * встреча уносит доску без отдельной уборки.
 *
 * <p>SQL — общий для PostgreSQL и H2 (режим PostgreSQL): {@code ON CONFLICT … DO UPDATE} H2 не
 * знает, поэтому запись — «обновить, а если строки нет — вставить». Пишет сцену один проход ({@link
 * BoardRooms}), так что гонки двух вставок одной доски нет.
 */
@Repository
public class BoardStore {
  private final JdbcClient jdbc;

  /** Записанная сцена: поколение, номер правки, элементы JSON-массивом и когда записана. */
  public record Saved(long epoch, long seq, String elements, long savedAt) {}

  /** Картинка: тип и байты. */
  public record FileData(String mime, byte[] data) {}

  public BoardStore(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public Optional<Saved> load(String roomId) {
    return jdbc.sql("SELECT scene, seq, epoch, updated_at FROM room_boards WHERE room_id=?")
        .param(roomId)
        .query(
            (rs, n) ->
                new Saved(
                    rs.getLong("epoch"),
                    rs.getLong("seq"),
                    gunzip(rs.getBytes("scene")),
                    rs.getLong("updated_at")))
        .optional();
  }

  /**
   * Записать сцену. {@code oldest} — самое старое на ней ({@link BoardRoom#oldest()}): по нему
   * почасовая очистка находит доски, где есть что убрать. {@code false} — комнаты уже нет (её
   * удалили, пока доска жила в памяти): писать некуда, и доску пора забыть.
   */
  public boolean save(String roomId, long epoch, long seq, String elements, long oldest, long now) {
    var scene = gzip(elements);
    int updated =
        jdbc.sql(
                "UPDATE room_boards SET scene=?, seq=?, epoch=?, updated_at=?, content_at=? WHERE"
                    + " room_id=?")
            .params(scene, seq, epoch, now, oldest, roomId)
            .update();
    if (updated > 0) return true;
    try {
      jdbc.sql(
              "INSERT INTO room_boards(room_id, scene, seq, epoch, updated_at, content_at)"
                  + " VALUES(?,?,?,?,?,?)")
          .params(roomId, scene, seq, epoch, now, oldest)
          .update();
      return true;
    } catch (DataIntegrityViolationException e) {
      return false;
    }
  }

  public List<BoardRoom.FileMeta> files(String roomId) {
    return jdbc.sql(
            "SELECT file_id, mime, size_bytes, created_at FROM room_board_files WHERE room_id=? ORDER BY created_at, file_id")
        .param(roomId)
        .query(
            (rs, n) ->
                new BoardRoom.FileMeta(
                    rs.getString("file_id"),
                    rs.getString("mime"),
                    rs.getInt("size_bytes"),
                    rs.getLong("created_at")))
        .list();
  }

  /**
   * Доски, где в базе есть что-то не новее {@code cutoff} (Р-134): элемент сцены или картинка. У
   * сцен, записанных до этого выпуска, времени нет ({@code content_at IS NULL}) — их проверит
   * первый же проход.
   */
  public List<String> due(long cutoff) {
    return jdbc.sql(
            "SELECT room_id FROM room_boards WHERE content_at IS NULL OR content_at<=? UNION"
                + " SELECT DISTINCT room_id FROM room_board_files WHERE created_at<=?")
        .params(cutoff, cutoff)
        .query(String.class)
        .list();
  }

  /** Проверенная доска, где убирать было нечего: запомнить, когда в ней срок у самого старого. */
  public void checked(String roomId, long oldest) {
    jdbc.sql("UPDATE room_boards SET content_at=? WHERE room_id=?").params(oldest, roomId).update();
  }

  public Optional<FileData> file(String roomId, String fileId) {
    return jdbc.sql("SELECT mime, data FROM room_board_files WHERE room_id=? AND file_id=?")
        .params(roomId, fileId)
        .query((rs, n) -> new FileData(rs.getString("mime"), rs.getBytes("data")))
        .optional();
  }

  /**
   * Положить картинку. {@code false} — такая уже есть (картинки названы по содержимому) или нет
   * комнаты.
   */
  public boolean putFile(String roomId, String fileId, String mime, byte[] data, long now) {
    try {
      jdbc.sql(
              "INSERT INTO room_board_files(room_id, file_id, mime, size_bytes, data, created_at) VALUES(?,?,?,?,?,?)")
          .params(roomId, fileId, mime, data.length, data, now)
          .update();
      return true;
    } catch (DataIntegrityViolationException e) {
      return false;
    }
  }

  public void deleteFiles(String roomId, List<String> fileIds) {
    for (var id : fileIds)
      jdbc.sql("DELETE FROM room_board_files WHERE room_id=? AND file_id=?")
          .params(roomId, id)
          .update();
  }

  public void deleteAllFiles(String roomId) {
    jdbc.sql("DELETE FROM room_board_files WHERE room_id=?").param(roomId).update();
  }

  static byte[] gzip(String text) {
    var out = new ByteArrayOutputStream(Math.max(64, text.length() / 4));
    try (var zip = new GZIPOutputStream(out)) {
      zip.write(text.getBytes(StandardCharsets.UTF_8));
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
    return out.toByteArray();
  }

  static String gunzip(byte[] data) {
    try (var zip = new GZIPInputStream(new ByteArrayInputStream(data))) {
      return new String(zip.readAllBytes(), StandardCharsets.UTF_8);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }
}
