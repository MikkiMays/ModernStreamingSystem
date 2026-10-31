package dev.mikki.stream.events;

import dev.mikki.stream.board.BoardRooms;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Часы доски (R159): раз в секунду — запись сцен с новым и выгрузка пустых, раз в две — права
 * сокетов и зависшие отправки. Отдельно от сокета, чтобы тесты (`stream.scheduling-enabled=false`)
 * звали проходы сами и в своём порядке.
 */
@Component
@ConditionalOnProperty(
    name = "stream.scheduling-enabled",
    havingValue = "true",
    matchIfMissing = true)
public class BoardSchedule {
  private final BoardRooms boards;
  private final BoardSocket socket;

  public BoardSchedule(BoardRooms boards, BoardSocket socket) {
    this.boards = boards;
    this.socket = socket;
  }

  @Scheduled(fixedDelay = 1000)
  public void flush() {
    boards.flushDue();
  }

  @Scheduled(fixedDelay = 2000)
  public void recheck() {
    socket.recheck();
  }
}
