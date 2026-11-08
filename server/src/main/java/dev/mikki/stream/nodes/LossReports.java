package dev.mikki.stream.nodes;

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
 * <p>Клиент говорит ядру о беде двумя командами: {@code media.stall} — подсказка: входящее молчание
 * по STUN-счётчикам при живом по мнению SDK соединении ({@code silence-watch.ts}, ≈ 5 с), участник
 * остаётся CONNECTED; и {@code media.lost} — SDK объявил переподключение (≈ 9 с), участник
 * RECOVERING. Здесь помнится, с какого момента каждый участник узла в беде. {@code NodeHealth}
 * сверяет это с промахами опроса: промахи без жалоб — магистраль, жалобы без промахов — чей-то
 * Wi-Fi, и только оба признака вместе — мёртвый узел. Состояние комнат здесь не трогается.
 *
 * <p>КОГДА ОТМЕТКА СНИМАЕТСЯ. Участника снова видно здоровым: {@code media.restored}, вход в SFU
 * заново ({@code participant_joined}) или сверка с SFU вернула его в CONNECTED ({@code
 * MediaService}) — {@link #restored}. Но {@code media.restored} клиент шлёт без повторов, и
 * потерянный возврат оставлял бы отметку висеть до {@link #FORGET_MS}. Поэтому подсказка {@code
 * media.stall} живёт сама только {@link #STALL_MS}: настоящая потеря за это время доходит до {@code
 * media.lost} (SDK объявляет переподключение через ≈ 4 с после подсказки) и продолжает тот же
 * эпизод — его начало остаётся временем подсказки; не дошла — путь ожил, а возврат потерялся, или
 * подсказку прислали нарочно. Повтор подсказки срок не продлевает.
 *
 * <p>Класс сам по себе ничего не решает и ни от кого не зависит: {@code RoomService} и {@code
 * MediaService} пишут сюда, {@code NodeHealth} читает и слушает ({@link #subscribe}), чтобы оценить
 * узел сразу по жалобе, а не ждать следующего опроса.
 */
@Component
public class LossReports {
  /**
   * Правило C ({@code NodeHealth}): столько в беде без возврата при отвечающем узле — узел мёртв
   * для людей. Окно восстановления — 20 с от {@code media.lost}, а первая отметка ({@code
   * media.stall}) приходит на ≈ 5 с раньше него, так что порог успевает сработать до того, как люди
   * выпадут из комнаты.
   */
  public static final long STUCK_MS = 20_000;

  /**
   * Столько живёт подсказка {@code media.stall}, если за ней не пришёл {@code media.lost}. Между
   * ними у настоящей потери ≈ 4 с (подсказка в 5–7 с, переподключение SDK в ≈ 9,4 с) — запас больше
   * чем вдвое.
   */
  public static final long STALL_MS = 10_000;

  /** Отметка старше этого забывается: окно восстановления давно вышло, человек уже не в комнате. */
  static final long FORGET_MS = 120_000;

  /** Начало беды и было ли {@code media.lost} (иначе — только подсказка {@code media.stall}). */
  private record Mark(long at, boolean lost) {
    boolean live(long now) {
      long age = now - at;
      return age <= FORGET_MS && (lost || age <= STALL_MS);
    }
  }

  /** Узел → участник → отметка. */
  private final Map<String, Map<String, Mark>> byNode = new ConcurrentHashMap<>();

  private final List<Consumer<String>> listeners = new CopyOnWriteArrayList<>();

  /** Подсказка {@code media.stall}: участник на связи, а входящего нет. */
  public void stall(String node, String participant, long now) {
    mark(node, participant, now, false);
  }

  /** {@code media.lost}: SDK участника переподключается. */
  public void lost(String node, String participant, long now) {
    mark(node, participant, now, true);
  }

  /**
   * Живая отметка времени не сдвигает: {@code media.lost} после свежей подсказки — тот же эпизод с
   * её началом. Отжившая заменяется новой. Отметка на другом узле (комната переехала) снимается.
   */
  private void mark(String node, String participant, long now, boolean lost) {
    if (node == null || participant == null) return;
    for (var entry : byNode.entrySet())
      if (!entry.getKey().equals(node)) entry.getValue().remove(participant);
    byNode
        .computeIfAbsent(node, k -> new ConcurrentHashMap<>())
        .compute(
            participant,
            (k, old) -> {
              if (old == null || !old.live(now)) return new Mark(now, lost);
              return lost && !old.lost() ? new Mark(old.at(), true) : old;
            });
    for (var listener : listeners) listener.accept(node);
  }

  /** Участника снова видно здоровым — на каком бы узле он ни жаловался. */
  public void restored(String participant) {
    if (participant == null) return;
    for (var reports : byNode.values()) reports.remove(participant);
  }

  /** Все отметки узла — после эвакуации его комнат они ничего не значат. */
  public void clear(String node) {
    byNode.remove(node);
  }

  /**
   * Сколько живых отметок узла началось не раньше {@code from} (правило A: жалобы этой полосы
   * промахов) — среди {@code among} или, если {@code null}, всех. Пересечение с людьми узла держит
   * числитель внутри знаменателя: ушедший из комнаты не считается, даже если отметка ещё жива.
   */
  public int since(String node, Set<String> among, long from, long now) {
    return count(node, among, now, mark -> mark.at() >= from);
  }

  /**
   * Сколько живых отметок узла в беде не меньше {@code atLeastMs} (правило C) — среди {@code among}
   * или, если {@code null}, всех.
   */
  public int stuck(String node, Set<String> among, long atLeastMs, long now) {
    return count(node, among, now, mark -> now - mark.at() >= atLeastMs);
  }

  private int count(
      String node, Set<String> among, long now, java.util.function.Predicate<Mark> counts) {
    var reports = byNode.get(node);
    if (reports == null || (among != null && among.isEmpty())) return 0;
    int count = 0;
    for (var entry : reports.entrySet()) {
      var mark = entry.getValue();
      if (!mark.live(now)) {
        reports.remove(entry.getKey(), mark);
        continue;
      }
      if ((among == null || among.contains(entry.getKey())) && counts.test(mark)) count++;
    }
    return count;
  }

  /** Сколько отметок хранится на узле (живых и ещё не убранных) — для журнала и тестов. */
  public int reported(String node) {
    var reports = byNode.get(node);
    return reports == null ? 0 : reports.size();
  }

  /** Слушатель вызывается на каждую новую жалобу с именем узла — в потоке того, кто жаловался. */
  public void subscribe(Consumer<String> listener) {
    listeners.add(listener);
  }
}
