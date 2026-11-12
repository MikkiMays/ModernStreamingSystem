package dev.mikki.stream.activity;

import dev.mikki.stream.room.RoomState;
import java.util.List;

/** Общие для статистики и метров вопросы к комнате — один ответ на весь пакет. */
final class Activity {
  private Activity() {}

  /**
   * Что сейчас идёт во встрече: {@code watch}, {@code music}, игры. Боты — не люди, но музыка — да.
   */
  static List<String> integrations(RoomState room) {
    return room.integrations();
  }

  /** Сколько людей на связи: ровно то, от чего считаются начало встречи (П7) и человеко-минуты. */
  static int connectedHumans(RoomState room) {
    return (int)
        room.members.values().stream()
            .filter(m -> m.human() && m.status == RoomState.Status.CONNECTED)
            .count();
  }
}
