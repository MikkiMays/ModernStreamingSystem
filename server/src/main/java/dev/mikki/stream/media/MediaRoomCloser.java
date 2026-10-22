package dev.mikki.stream.media;

import dev.mikki.stream.room.RoomObserver;
import dev.mikki.stream.room.RoomState;
import dev.mikki.stream.shared.Problem;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Завершённая встреча распускает и комнату SFU (R97).
 *
 * <p>ЗАЧЕМ. Раньше ядро ставило {@code closedAt} и рассылало снимок, а комната LiveKit жила дальше
 * до своего {@code empty_timeout}: участники узнавали о конце встречи только по снимку ядра, то
 * есть после его доставки по WS и обработки. Удаление комнаты SFU — второй, независимый путь:
 * {@code Disconnected(ROOM_DELETED)} приходит каждому по сигнальному сокету, и клиент заканчивает
 * встречу по первому из двух.
 *
 * <p>КОГДА. Не внутри транзакции и не под замком комнаты: наблюдатель зовётся под ними, а поход в
 * SFU — сеть. Поэтому распуск откладывается до фиксации ({@code afterCommit}) и уходит в свой
 * поток; откатившаяся встреча комнату SFU не трогает. Отказ медиасервера — не отказ действия:
 * встреча уже закрыта в базе, а комнату SFU доберёт его собственный таймер пустой комнаты.
 */
@Component
public class MediaRoomCloser implements RoomObserver {
  private static final Logger log = LoggerFactory.getLogger(MediaRoomCloser.class);
  private final MediaGateway gateway;
  private final Executor executor;

  @org.springframework.beans.factory.annotation.Autowired
  public MediaRoomCloser(MediaGateway gateway) {
    this(
        gateway,
        Executors.newSingleThreadExecutor(
            r -> Thread.ofPlatform().daemon().name("sfu-room-closer").unstarted(r)));
  }

  MediaRoomCloser(MediaGateway gateway, Executor executor) {
    this.gateway = gateway;
    this.executor = executor;
  }

  @Override
  public void closed(RoomState room, String reason, long now) {
    var roomId = room.id;
    Runnable close = () -> executor.execute(() -> delete(roomId));
    if (TransactionSynchronizationManager.isSynchronizationActive())
      TransactionSynchronizationManager.registerSynchronization(
          new TransactionSynchronization() {
            @Override
            public void afterCommit() {
              close.run();
            }
          });
    else close.run();
  }

  private void delete(String roomId) {
    try {
      gateway.close(roomId);
    } catch (Problem e) {
      log.warn("SFU room {} was not deleted after the meeting ended: {}", roomId, e.getMessage());
    } catch (RuntimeException e) {
      log.warn("SFU room {} was not deleted after the meeting ended", roomId, e);
    }
  }
}
