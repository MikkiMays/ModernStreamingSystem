package dev.mikki.stream.game;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.function.Function;
import java.util.function.ToIntFunction;

/**
 * Итог партии: то, что за столом обсуждают, пока тасуют следующую.
 *
 * <p>ПОЧЕМУ ОТДЕЛЬНО ОТ СТОЛА. {@link Durak} — это правила: кто ходит, чем можно побить, кто
 * остался с картами. Здесь ничего не решается — здесь читается уже посчитанное и складывается в
 * одну запись. Смешав то и это, мы получили бы полторы тысячи строк, в которых правила игры
 * перемешаны с подписями к таблице. Та же граница, что у покера ({@link Standings}).
 */
public final class DurakStandings {
  private DurakStandings() {}

  /** Сколько прикольных строчек показываем. Больше — это уже не «прикольно», а простыня. */
  private static final int HIGHLIGHTS = 6;

  /** Собрать итог сыгранной партии. Зовётся один раз, когда дурак уже назван. */
  public static DurakSummary of(Durak table, long now) {
    var players = players(table);
    return new DurakSummary(
        // Имя записи даёт сама партия и не меняет его: снимок собирается заново на каждый
        // запрос, и новый идентификатор в каждом означал бы мигание списка без причины.
        (table.gameId == null ? UUID.randomUUID().toString() : table.gameId)
            + ":"
            + table.handNumber,
        table.mode,
        table.modeName(),
        table.deckSize,
        table.handStartedAt,
        now,
        table.handNumber,
        table.result == null ? 0 : table.result.bouts,
        table.result != null && table.result.draw,
        table.result == null ? "" : table.result.foolName,
        table.result == null ? List.of() : List.copyOf(table.result.places),
        players,
        highlights(players));
  }

  /**
   * Кто играл и с чем подошёл к концу партии.
   *
   * <p>Порядок — местом выхода: первый вышедший сверху, дурак снизу. Не вышедшие вовсе (встали
   * посреди партии) идут после вышедших, чтобы таблица читалась как финиш, а не как список.
   */
  private static List<DurakSummary.DurakPlayer> players(Durak table) {
    var list = new ArrayList<DurakSummary.DurakPlayer>();
    for (var entry : table.tally.entrySet()) {
      var stats = entry.getValue();
      var seat = table.seatOf(entry.getKey());
      list.add(
          new DurakSummary.DurakPlayer(
              stats.name,
              seat != null && seat.fool,
              seat == null ? 0 : seat.place,
              stats.games,
              stats.fools,
              stats.firsts,
              stats.takes,
              stats.defences,
              stats.thrown,
              stats.trumpsBurned,
              stats.transfers,
              stats.bestStreak));
    }
    list.sort(
        Comparator.comparingInt(
                (DurakSummary.DurakPlayer p) -> p.fool() ? 2 : p.place() > 0 ? 0 : 1)
            .thenComparingInt(DurakSummary.DurakPlayer::place));
    return list;
  }

  /**
   * Прикольные строчки про вечер.
   *
   * <p>Числа в таблице отвечают на «сколько», а это — на «кто». Именно их за столом и произносят
   * вслух: кто чаще всех оставался дураком, кто отбивался, не взяв ни карты, кто сжёг больше всех
   * козырей. Считаются они по тем же полям, что и таблица, поэтому спорить с ней не могут.
   */
  private static List<GameSummary.Highlight> highlights(List<DurakSummary.DurakPlayer> players) {
    var out = new ArrayList<GameSummary.Highlight>();
    if (players.size() < 2) return out;
    add(
        out,
        players,
        "fools",
        "Главный дурак",
        DurakSummary.DurakPlayer::fools,
        "раз",
        "проиграл чаще всех");
    add(
        out,
        players,
        "firsts",
        "Быстрее всех",
        DurakSummary.DurakPlayer::firsts,
        "раз",
        "выходил первым");
    add(
        out,
        players,
        "defences",
        "Стена",
        DurakSummary.DurakPlayer::defences,
        "боёв",
        "отбил, не взяв ни карты");
    add(
        out,
        players,
        "thrown",
        "Подкидывал",
        DurakSummary.DurakPlayer::thrown,
        "карт",
        "отправил под защиту");
    add(
        out,
        players,
        "trumps",
        "Жёг козыри",
        DurakSummary.DurakPlayer::trumpsBurned,
        "козырей",
        "потратил на защиту");
    add(
        out,
        players,
        "streak",
        "Держался",
        DurakSummary.DurakPlayer::bestStreak,
        "партий",
        "подряд не был дураком");
    add(out, players, "takes", "Брал", DurakSummary.DurakPlayer::takes, "раз", "забирал со стола");
    add(
        out,
        players,
        "transfers",
        "Переводил",
        DurakSummary.DurakPlayer::transfers,
        "раз",
        "отдал бой соседу");
    while (out.size() > HIGHLIGHTS) out.remove(out.size() - 1);
    return out;
  }

  /** Строчка появляется только если у неё есть настоящий лидер: ноль ничего не говорит. */
  private static void add(
      List<GameSummary.Highlight> out,
      List<DurakSummary.DurakPlayer> players,
      String id,
      String title,
      ToIntFunction<DurakSummary.DurakPlayer> value,
      String unit,
      String hint) {
    var best = players.stream().max(Comparator.comparingInt(value)).orElse(null);
    if (best == null || value.applyAsInt(best) <= 0) return;
    // Ничья в строчке — не строчка: «оба по разу» никого не выделяет.
    long leaders =
        players.stream().filter(p -> value.applyAsInt(p) == value.applyAsInt(best)).count();
    if (leaders > 1) return;
    Function<DurakSummary.DurakPlayer, String> label = p -> value.applyAsInt(p) + " " + unit;
    out.add(new GameSummary.Highlight(id, title, best.name(), label.apply(best), hint));
  }
}
