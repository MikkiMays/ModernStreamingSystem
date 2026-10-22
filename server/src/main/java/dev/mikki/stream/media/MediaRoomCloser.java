package dev.mikki.stream.media;

import dev.mikki.stream.room.RoomObserver;
import dev.mikki.stream.room.RoomState;
import dev.mikki.stream.shared.Problem;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Завершённая встреча распускает и комнату SFU (R97).
 *
 * <p>ЗАЧЕМ. Раньше ядро ставило {@code closedAt} и рассылало снимок, а комната LiveKit жила дальше
 * до своего {@code empty_timeout}: участники узнавали о конце встречи только по снимку ядра, то
 * есть после его доставки по WS и обработки. Удаление комнаты SFU — второй, независимый путь:
 * {@code Disconnected(ROOM_DELETED)} приходит каждому по сигнальному сокету, и клиент заканчивает
 * встречу по первому из двух.
 *
 * <p>Отказ медиасервера здесь не отказ действия: встреча уже закрыта в базе, а комнату SFU доберёт
 * его собственный таймер пустой комнаты.
 */
@Component
public class MediaRoomCloser implements RoomObserver {
  private static final Logger log = LoggerFactory.getLogger(MediaRoomCloser.class);
  private final MediaGateway gateway;

  public MediaRoomCloser(MediaGateway gateway) {
    this.gateway = gateway;
  }

  @Override
  public void closed(RoomState room, String reason, long now) {
    try {
      gateway.close(room.id);
    } catch (Problem e) {
      log.warn("SFU room {} was not deleted after the meeting ended: {}", room.id, e.getMessage());
    }
  }
}
