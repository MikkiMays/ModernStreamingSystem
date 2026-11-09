package dev.mikki.stream.room;

import dev.mikki.stream.board.BoardRooms;
import dev.mikki.stream.config.StreamProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Почасовая очистка содержимого (Р-134, {@code docs/architecture/data-retention.md} §4): всё, что
 * люди принесли во встречу, уходит не позже {@code stream.retention.content} (сутки) от добавления.
 *
 * <p>Это не отдельный механизм, а час {@link Lifecycle}: секундный проход уборки ({@link
 * Lifecycle#sweepLedger}) по-прежнему уносит сообщения, события и расписки по их сроку, минутный
 * проход вложений — файлы на диске; здесь — то, у чего срока в строке нет:
 *
 * <ul>
 *   <li>снимок каждой комнаты — итоги игр, кино и столы, картинки профиля ушедших ({@link
 *       Lifecycle#expireContent}), в том числе у сохранённой встречи: она остаётся, но приходит
 *       пустой;
 *   <li>доски — каждый элемент не дольше суток от добавления или правки, картинка — от загрузки
 *       ({@link BoardRooms#expire});
 *   <li>замер: сколько лет самому старому содержимому каждого вида ({@link RetentionMeter}) — по
 *       нему оповещение, если очистка не справилась.
 * </ul>
 *
 * <p>Текст обращений в поддержку уходит своим часовым проходом ({@code SupportJanitor}), метаданные
 * — проходом итогов ({@code ActivityRollup}): у них свои сроки и свои таблицы.
 */
@Service
public class Retention {
  private static final Logger log = LoggerFactory.getLogger(Retention.class);

  private final RoomRepository rooms;
  private final Lifecycle lifecycle;
  private final BoardRooms boards;
  private final StreamProperties config;
  private final RoomService service;
  private final RetentionMeter meter;

  /** Что убрал проход: записи снимков комнат, элементы и картинки досок. */
  public record Report(int roomContent, int boardElements, int boardFiles) {}

  public Retention(
      RoomRepository rooms,
      Lifecycle lifecycle,
      BoardRooms boards,
      StreamProperties config,
      RoomService service,
      RetentionMeter meter) {
    this.rooms = rooms;
    this.lifecycle = lifecycle;
    this.boards = boards;
    this.config = config;
    this.service = service;
    this.meter = meter;
  }

  /** Порог: всё, добавленное не позже него, уходит. */
  public long cutoff(long now) {
    return now - config.retention().content().toMillis();
  }

  public Report sweep() {
    long now = service.now();
    long cutoff = cutoff(now);
    int roomContent = 0;
    for (var id : rooms.ids()) {
      try {
        roomContent += lifecycle.expireContent(id, cutoff);
      } catch (RuntimeException e) {
        // Одна комната, которую не прочитать, не останавливает очистку остальных.
        log.warn("Очистка по сроку: комната {} пропущена: {}", id, e.toString());
      }
    }
    var swept = boards.expire(cutoff);
    meter.deleted("board_element", swept.elements());
    meter.deleted("board_file", swept.files());
    measure(now);
    meter.swept(now);
    if (roomContent + swept.elements() + swept.files() > 0)
      log.info(
          "Очистка по сроку: снимки комнат — {}, доски — {} (элементов {}, картинок {})",
          roomContent,
          swept.boards(),
          swept.elements(),
          swept.files());
    return new Report(roomContent, swept.elements(), swept.files());
  }

  /** Сколько лет самому старому содержимому каждого вида — после прохода. */
  private void measure(long now) {
    var jdbc = rooms.jdbc();
    meter.oldest("message", min(jdbc, "SELECT MIN(created_at) FROM messages"), now);
    meter.oldest("attachment", min(jdbc, "SELECT MIN(created_at) FROM attachments"), now);
    meter.oldest(
        "board_element",
        Math.min(
            boards.oldestInMemory(),
            min(jdbc, "SELECT MIN(content_at) FROM room_boards WHERE content_at IS NOT NULL")),
        now);
    meter.oldest("board_file", min(jdbc, "SELECT MIN(created_at) FROM room_board_files"), now);
    // Текст обращения живёт до решения и ещё сутки: «возраст» — от решения.
    meter.oldest(
        "support_text",
        min(
            jdbc,
            "SELECT MIN(COALESCE(resolved_at, archived_at, status_at)) FROM support_tickets WHERE"
                + " status IN ('done','archived') AND content_cleared_at IS NULL"),
        now);
  }

  private static long min(org.springframework.jdbc.core.simple.JdbcClient jdbc, String sql) {
    var values = jdbc.sql(sql).query(Long.class).list();
    return values.isEmpty() || values.getFirst() == null ? Long.MAX_VALUE : values.getFirst();
  }
}
