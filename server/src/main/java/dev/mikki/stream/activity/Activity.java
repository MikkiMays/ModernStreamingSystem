package dev.mikki.stream.activity;

import dev.mikki.stream.room.RoomState;
import java.util.ArrayList;
import java.util.List;

/** Общие для статистики и метров вопросы к комнате — один ответ на весь пакет. */
final class Activity {
  private Activity() {}

  /**
   * Что сейчас идёт во встрече: {@code watch}, {@code music}, игры. Боты — не люди, но музыка — да.
   */
  static List<String> integrations(RoomState room) {
    var kinds = new ArrayList<String>(2);
    if (room.watch != null) kinds.add("watch");
    if (room.members.values().stream().anyMatch(m -> "music".equals(m.service) && m.occupiesSeat()))
      kinds.add("music");
    if (room.poker != null) kinds.add("poker");
    if (room.durak != null) kinds.add("durak");
    if (room.chess != null) kinds.add("chess");
    if (room.gartic != null) kinds.add("gartic");
    if (room.board != null) kinds.add("board");
    return kinds;
  }

  /** Сколько людей на связи: ровно то, от чего считаются начало встречи (П7) и человеко-минуты. */
  static int connectedHumans(RoomState room) {
    return (int)
        room.members.values().stream()
            .filter(m -> m.human() && m.status == RoomState.Status.CONNECTED)
            .count();
  }
}
