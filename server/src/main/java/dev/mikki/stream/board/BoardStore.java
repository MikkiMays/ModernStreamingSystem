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

  /** Записанная сцена: поколение, номер правки и элементы JSON-массивом. */
  public record Saved(long epoch, long seq, String elements) {}

  /** Картинка: тип и байты. */
  public record FileData(String mime, byte[] data) {}

  public BoardStore(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public Optional<Saved> load(String roomId) {
    return jdbc.sql("SELECT scene, seq, epoch FROM room_boards WHERE room_id=?")
        .param(roomId)
        .query(
            (rs, n) ->
                new Saved(rs.getLong("epoch"), rs.getLong("seq"), gunzip(rs.getBytes("scene"))))
        .optional();
  }

  /**
   * Записать сцену. {@code false} — комнаты уже нет (её удалили, пока доска жила в памяти): писать
   * некуда, и доску пора забыть.
   */
  public boolean save(String roomId, long epoch, long seq, String elements, long now) {
    var scene = gzip(elements);
    int updated =
        jdbc.sql("UPDATE room_boards SET scene=?, seq=?, epoch=?, updated_at=? WHERE room_id=?")
            .params(scene, seq, epoch, now, roomId)
            .update();
    if (updated > 0) return true;
    try {
      jdbc.sql("INSERT INTO room_boards(room_id, scene, seq, epoch, updated_at) VALUES(?,?,?,?,?)")
          .params(roomId, scene, seq, epoch, now)
          .update();
      return true;
    } catch (DataIntegrityViolationException e) {
      return false;
    }
  }

  public List<BoardRoom.FileMeta> files(String roomId) {
    return jdbc.sql(
            "SELECT file_id, mime, size_bytes FROM room_board_files WHERE room_id=? ORDER BY created_at, file_id")
        .param(roomId)
        .query(
            (rs, n) ->
                new BoardRoom.FileMeta(
                    rs.getString("file_id"), rs.getString("mime"), rs.getInt("size_bytes")))
        .list();
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
