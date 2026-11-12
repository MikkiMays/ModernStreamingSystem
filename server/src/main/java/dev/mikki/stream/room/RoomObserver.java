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

  /**
   * Встреча завершилась: {@code reason} — {@code host}, {@code empty}, {@code unused}, {@code
   * maintenance}, …
   */
  default void closed(RoomState room, String reason, long now) {}

  /**
   * Окно технических работ само сменило состояние ({@link MaintenanceWindows}): {@code started} или
   * {@code expired}. Зовётся один раз на весь сервер, сколько бы узлов ни заметили переход.
   */
  default void maintenance(MaintenanceWindows.Window window, String transition, long now) {}

  /**
   * Ведущий что-то сделал с участником: {@code participant.removed}, {@code participant.approved}.
   */
  default void acted(
      RoomState room, RoomState.Member actor, String action, RoomState.Member target, long now) {}

  /**
   * Встреча открыта: создана или открыта заново из избранного. {@code profileHash} — хэш профиля
   * того, кто открыл, или {@code null}.
   */
  default void opened(RoomState room, String profileHash, long now) {}

  /**
   * Встреча переехала на другой медиаузел: {@code reason} — {@code dead} (узел умер) или {@code
   * manual} (перевёл создатель).
   */
  default void moved(RoomState room, String from, String to, String reason, long now) {}

  /**
   * Во встрече началась интеграция {@code kind} (слово из {@link RoomState#integrations}); {@code
   * run} — номер этого запуска ({@link RoomState#runs}).
   */
  default void integrationOpened(RoomState room, String kind, String run, long now) {}

  /**
   * Запуск интеграции кончился: {@code reason} — {@code closed} (убрал человек), {@code replaced}
   * (открыли другое на его месте), {@code ended} (кончилась встреча или вышел срок простоя), {@code
   * error} (интеграция пропала сама).
   */
  default void integrationClosed(
      RoomState room, String kind, String run, String reason, long now) {}

  /** Интеграция отказала: {@code code} — что случилось, словом для статистики. */
  default void integrationFailed(RoomState room, String kind, String run, String code, long now) {}
}
