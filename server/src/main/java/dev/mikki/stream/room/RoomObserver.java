package dev.mikki.stream.room;

/**
 * Кто следит за жизнью встречи, не вмешиваясь в неё: статистика и журнал аудита (E10-B).
 *
 * <p>ЗАЧЕМ ИНТЕРФЕЙС. Встреча меняется в десятке мест {@link RoomService}, {@link Lifecycle} и
 * {@code MediaService}, и все они кончаются одним — {@link RoomService#emit}. Считать минуты, пики
 * и исходы там, где это происходит, значило бы научить комнату статистике. Вместо этого комната
 * сообщает, что изменилось, а наблюдатели живут в своём пакете ({@code activity}) и зависят от
 * комнаты, а не наоборот.
 *
 * <p>Всё вызывается внутри транзакции комнаты и под её замком: наблюдатель пишет в ту же
 * транзакцию, и откат встречи откатывает и его запись. Отказ наблюдателя — отказ действия, поэтому
 * наблюдатель не бросает ничего, кроме сбоя базы.
 */
public interface RoomObserver {
  /** После каждого события комнаты ({@code room.changed}, {@code message.created}, …). */
  default void changed(RoomState room, String event, long now) {}

  /** Встреча завершилась: {@code reason} — {@code host}, {@code empty}, {@code unused}, … */
  default void closed(RoomState room, String reason, long now) {}

  /**
   * Ведущий что-то сделал с участником: {@code participant.removed}, {@code participant.approved}.
   */
  default void acted(
      RoomState room, RoomState.Member actor, String action, RoomState.Member target, long now) {}
}
