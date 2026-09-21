package dev.mikki.stream.room;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * Какие комнаты ждут своего срока.
 *
 * <p>ЗАЧЕМ ОТДЕЛЬНЫЕ ЧАСЫ, ЕСЛИ ЕСТЬ ОБЩИЙ ПРОХОД. Общий проход {@link Lifecycle} ходит по всем
 * комнатам раз в секунду и каждую перечитывает под замком — он прекрасно годится для сроков,
 * которые меряются минутами, и никуда не годится для тех, что меряются кадрами. Конец хода,
 * доигрывание борда и пауза перед следующей раздачей — это то, что все видят одновременно, и
 * секунда разброса здесь читается как «подвисло».
 *
 * <p>Поэтому сроки игры лежат здесь: маленькая карта «комната → когда её трогать». Часы её
 * просматривают пять раз в секунду и будят только те комнаты, чей срок настал, — остальные не
 * читаются и не блокируются вовсе.
 *
 * <p>Карта живёт в памяти и переживать перезапуск не обязана: секундный проход находит забытый срок
 * сам и кладёт его обратно. Отсюда же и правило: срок отдаётся ровно один раз, а поставить его
 * заново — дело того, кто двинул стол.
 */
@Component
public class GameClock {
  private final Map<String, Long> due = new ConcurrentHashMap<>();

  public void schedule(String roomId, long at) {
    if (at <= 0) due.remove(roomId);
    else due.put(roomId, at);
  }

  public void forget(String roomId) {
    due.remove(roomId);
  }

  /** Чей срок настал. Каждая комната отдаётся один раз: дальше её ставит обратно сам стол. */
  public List<String> ripe(long now) {
    var ready = new ArrayList<String>();
    for (var entry : due.entrySet())
      if (entry.getValue() <= now && due.remove(entry.getKey(), entry.getValue()))
        ready.add(entry.getKey());
    return ready;
  }
}
