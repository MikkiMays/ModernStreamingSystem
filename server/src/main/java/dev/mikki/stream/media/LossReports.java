package dev.mikki.stream.media;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import org.springframework.stereotype.Component;

/**
 * Жалобы клиентов на медиа по узлам — второй, независимый от опроса признак отказа узла (R200 §5.2,
 * Р-105).
 *
 * <p>Клиент говорит ядру о беде двумя командами: {@code media.stall} — входящее молчание по
 * STUN-счётчикам при живом по мнению SDK соединении ({@code silence-watch.ts}, ≈ 5 с), и {@code
 * media.lost} — SDK объявил переподключение (≈ 9 с). Здесь помнится, с какого момента каждый
 * участник узла в беде; возврат ({@code media.restored}) снимает отметку. {@link NodeHealth}
 * сверяет это с промахами опроса: промахи без жалоб — магистраль, жалобы без промахов — чей-то
 * Wi-Fi, и только оба признака вместе — мёртвый узел. Состояние комнат здесь не трогается.
 *
 * <p>Класс сам по себе ничего не решает и ни от кого не зависит: {@code RoomService} пишет сюда,
 * {@code NodeHealth} читает и слушает ({@link #subscribe}), чтобы оценить узел сразу по жалобе, а
 * не ждать следующего опроса.
 */
@Component
public class LossReports {
  /**
   * Правило C ({@link NodeHealth}): столько в беде без возврата при отвечающем узле — узел мёртв
   * для людей. Окно восстановления — 20 с от {@code media.lost}, а первая отметка ({@code
   * media.stall}) приходит на ≈ 5 с раньше него, так что порог успевает сработать до того, как люди
   * выпадут из комнаты.
   */
  public static final long STUCK_MS = 20_000;

  /** Отметка старше этого забывается: окно восстановления давно вышло, человек уже не в комнате. */
  static final long FORGET_MS = 120_000;

  /** Узел → участник → когда впервые пожаловался (первая из {@code stall}/{@code lost}). */
  private final Map<String, Map<String, Long>> byNode = new ConcurrentHashMap<>();

  private final List<Consumer<String>> listeners = new CopyOnWriteArrayList<>();

  /**
   * Участник {@code participant} на узле {@code node} сообщил о потере медиа. Повтор времени не
   * сдвигает; отметка на другом узле (комната переехала) снимается.
   */
  public void lost(String node, String participant, long now) {
    if (node == null || participant == null) return;
    for (var entry : byNode.entrySet())
      if (!entry.getKey().equals(node)) entry.getValue().remove(participant);
    byNode.computeIfAbsent(node, k -> new ConcurrentHashMap<>()).putIfAbsent(participant, now);
    for (var listener : listeners) listener.accept(node);
  }

  /** Медиа у участника вернулось — на каком бы узле он ни жаловался. */
  public void restored(String participant) {
    if (participant == null) return;
    for (var reports : byNode.values()) reports.remove(participant);
  }

  /** Все отметки узла — после эвакуации его комнат они ничего не значат. */
  public void clear(String node) {
    byNode.remove(node);
  }

  /**
   * Кто из {@code people} (подключённые к узлу по снимкам комнат) в беде дольше {@code atLeastMs}.
   * Пересечение с {@code people} держит числитель внутри знаменателя: ушедший из комнаты не
   * считается, даже если его отметка ещё не забыта.
   */
  public int lostAmong(String node, Set<String> people, long now, long atLeastMs) {
    var reports = byNode.get(node);
    if (reports == null || people.isEmpty()) return 0;
    int count = 0;
    for (var entry : reports.entrySet()) {
      if (now - entry.getValue() > FORGET_MS) {
        reports.remove(entry.getKey());
        continue;
      }
      if (people.contains(entry.getKey()) && now - entry.getValue() >= atLeastMs) count++;
    }
    return count;
  }

  /** Сколько отметок висит на узле — для журнала и тестов. */
  public int reported(String node) {
    var reports = byNode.get(node);
    return reports == null ? 0 : reports.size();
  }

  /** Слушатель вызывается на каждую новую жалобу с именем узла — в потоке того, кто жаловался. */
  public void subscribe(Consumer<String> listener) {
    listeners.add(listener);
  }
}
