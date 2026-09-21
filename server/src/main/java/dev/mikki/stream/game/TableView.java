package dev.mikki.stream.game;

import java.util.List;

/**
 * Стол таким, каким его вправе видеть один конкретный человек.
 *
 * <p>ЗДЕСЬ НЕТ ДВУХ ВЕЩЕЙ, И ЭТО ГЛАВНОЕ ПРО ВЕСЬ ФАЙЛ: колоды и зерна тасовки. Они остаются в
 * снимке комнаты на сервере и не уходят в браузер ни одним полем — иначе «посмотреть чужие карты»
 * означало бы открыть инструменты разработчика. Чужие карты приходят закрытыми ({@code cards} пуст,
 * {@code held} говорит, сколько их), и раскрываются только на вскрытии.
 *
 * <p>Зерно ({@code seed}) появляется здесь уже после того, как раздача сыграна: по нему кто угодно
 * повторит тасовку и сверит её с {@code commitment}, объявленным до раздачи ({@link Cards}).
 */
public record TableView(
    String mode,
    String modeName,
    String phase,
    String hostId,
    int handNumber,
    long revision,
    int button,
    long smallBlind,
    long bigBlind,
    long ante,
    int level,
    long levelUpAt,
    int turnSeconds,
    boolean seatingOpen,
    boolean autoDeal,
    boolean paused,
    boolean rebuy,
    /** Сколько додепов разрешено одному человеку: −1 — сколько угодно, 0 — ни одного. */
    int rebuyLimit,
    /** Сколько фишек даёт один додеп. */
    long rebuyChips,
    long startingStack,
    long pot,
    long betToCall,
    int actor,
    long actionAt,
    long deadline,
    long streetAt,
    long handStartedAt,
    List<String> board,
    List<SeatView> seats,
    List<PotView> pots,
    List<NoteView> log,
    ResultView result,
    YouView you,
    String commitment,
    String seed,
    /**
     * Ждёт ли стол ведущего: вскрытие показано, и само оно не уйдёт.
     *
     * <p>Спрашивает об этом стол, а не браузер: «показано вскрытие» и «стол сдаёт сам» — два разных
     * факта, и складывать их в одно решение на стороне кнопки значит рано или поздно сложить
     * неверно.
     */
    boolean awaiting,
    /**
     * Когда стол закроется сам, потому что за ним никого, или 0 — пока кто-то есть.
     *
     * <p>Это не таймер браузера, а срок сервера: он приезжает в снимке, и до него остаётся одно и
     * то же время у всех. Показывать его обязательно — исчезнувший без предупреждения стол выглядит
     * как потерянная игра, а не как уборка.
     */
    long closesAt,
    /** Итоги игры — только когда она кончилась. Всё остальное время {@code null}. */
    GameSummary summary) {

  /** Место за столом. Пустое место — это {@code memberId == null}, остальное в нём не заполнено. */
  public record SeatView(
      int index,
      String memberId,
      String name,
      long stack,
      long bet,
      long committed,
      long buyIn,
      /** Карты видны, только если это ваши карты или их вскрыли. Иначе список пуст. */
      List<String> cards,
      /** Сколько карт на руках — по ним рисуются рубашки. */
      int held,
      /**
       * Открыты ли карты этого места для всех.
       *
       * <p>Нужно одному — кнопке «Показать карты»: без этого она оставалась нажимаемой и после
       * того, как карты уже показаны, и человек нажимал её второй раз, проверяя, сработало ли.
       */
      boolean revealed,
      boolean inHand,
      boolean folded,
      boolean allIn,
      boolean waiting,
      boolean away,
      boolean leaving,
      boolean busted,
      int place,
      String lastAction,
      long lastActionAmount,
      long wonAmount,
      String handName,
      List<String> handCards,
      long timeBankMs) {}

  /** Банк и те, кто на него претендует. Побочные банки идут после главного. */
  public record PotView(long amount, List<Integer> seats) {}

  /** Строка ленты: что произошло и когда. */
  public record NoteView(long at, String kind, int seat, String name, long amount, String text) {}

  /** Чем кончилась раздача — то, вокруг чего строится вся анимация победы. */
  public record ResultView(
      long at,
      boolean showdown,
      long pot,
      /** {@code normal}, {@code big} или {@code huge} — насколько банк велик для этого стола. */
      String drama,
      List<AwardView> awards,
      List<Integer> busted) {}

  public record AwardView(
      int seat, String name, long amount, String handName, List<String> handCards, boolean split) {}

  /** Что этот человек может сделать прямо сейчас. Для зрителя — {@code null}. */
  public record YouView(
      int seat,
      List<String> cards,
      /**
       * Что у вас собралось — словами. Считается только по <b>вашим</b> картам и общему столу,
       * поэтому ничего чужого не раскрывает, а смотреть на свои две карты и складывать их с бордом
       * в уме приходится каждую улицу.
       */
      String hand,
      List<String> actions,
      long callAmount,
      long minRaiseTo,
      long maxRaiseTo,
      long timeBankMs,
      boolean turn,
      /**
       * Сколько фишек можно взять заново прямо сейчас, или 0 — нельзя.
       *
       * <p>Это ответ сервера на вопрос «предлагать ли додеп», а не разрешение считать его в
       * браузере: правило про пустой стек, лимит и идущую раздачу живёт в одном месте.
       */
      long rebuy,
      /** Сколько додепов осталось: −1 — сколько угодно. */
      int rebuysLeft) {}
}
