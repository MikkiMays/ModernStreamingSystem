package dev.mikki.stream.game;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import dev.mikki.stream.shared.Problem;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.IntPredicate;

/**
 * Стол безлимитного холдема: состояние и все правила разом.
 *
 * <p>ПОЧЕМУ ПРАВИЛА ЖИВУТ НА СЕРВЕРЕ. Карты — это то, что один участник не должен знать о другом, а
 * банк — то, о чём никто не должен иметь собственного мнения. И то и другое возможно ровно в одном
 * месте: там, где лежит комната и берётся её замок. Браузер здесь только показывает и просит;
 * решает стол.
 *
 * <p>ПОЧЕМУ ЭТО ОБЫЧНЫЙ ОБЪЕКТ С ПОЛЯМИ. Он целиком ложится в тот же JSON комнаты, что и участники
 * с перепиской, и переживает перезапуск ядра вместе с ней. Отдельного хранилища у игры нет, и
 * заводить его ради десяти стопок фишек было бы дороже, чем сама игра.
 *
 * <p>ВРЕМЯ. Стол никуда не «тикает» сам: у каждого ожидания есть {@code deadline} по часам сервера,
 * и снаружи его двигает тот, кто заметил, что срок вышел ({@code tick}). Поэтому у всех за столом
 * одно и то же время на ход и одна и та же пауза перед следующей раздачей — не «примерно одна», а
 * буквально одно число, приехавшее в снимке.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class Table {
  /** Мест за столом. Столько же, сколько людей помещается во встречу. */
  public static final int SEATS = 10;

  /** Сколько показываем вскрытые карты, прежде чем собрать банк. */
  public static final long SHOWDOWN_MS = 7000;

  /** То же, но когда вскрывать нечего: все спасовали, и рука кончилась в одно движение. */
  public static final long QUICK_MS = 2800;

  /** Пауза между улицами, когда ставить уже некому: карты доигрываются «на вылет». */
  public static final long RUNOUT_MS = 1800;

  /**
   * Сколько летят карты в начале раздачи. Столько же ждёт первый ход — чтобы часы не шли вслепую.
   */
  public static final long DEAL_MS = 1600;

  /** Пауза перед следующей раздачей. */
  public static final long NEXT_HAND_MS = 3200;

  /** Сколько ждать того, кто ушёл из встречи, прежде чем ходить за него. */
  public static final long AWAY_ACT_MS = 3000;

  /** Сколько отсутствия — и место освобождается для других. */
  public static final long AWAY_STAND_MS = 300000;

  /** Сколько строк ленты храним: она про «что сейчас было», а не архив. */
  private static final int LOG_LIMIT = 40;

  /** Лестница блайндов: во сколько раз малый блайнд больше начального на каждом уровне. */
  private static final long[] LADDER = {
    1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256
  };

  /** Режим игры: не «сложность», а другой договор о том, чем кончается пустой стек. */
  public record Mode(
      String id,
      String name,
      String hint,
      long stack,
      long smallBlind,
      long bigBlind,
      int levelSeconds,
      int turnSeconds,
      int timeBankSeconds,
      boolean rebuy) {}

  private static final Map<String, Mode> MODES = new LinkedHashMap<>();

  static {
    MODES.put(
        "friendly",
        new Mode(
            "friendly",
            "Дружеская игра",
            "Блайнды стоят на месте, докупиться можно между раздачами. Никто не вылетает насовсем.",
            5000,
            25,
            50,
            0,
            45,
            60,
            true));
    MODES.put(
        "tournament",
        new Mode(
            "tournament",
            "Турнир",
            "Один стек на всю игру, блайнды растут каждые восемь минут. Проиграл — выбыл, и стол"
                + " считает места.",
            10000,
            50,
            100,
            480,
            30,
            60,
            false));
    MODES.put(
        "turbo",
        new Mode(
            "turbo",
            "Блиц",
            "Тот же турнир, только быстрее: пятнадцать секунд на ход и блайнды каждые три минуты.",
            3000,
            50,
            100,
            180,
            15,
            30,
            false));
  }

  public static List<Mode> modes() {
    return List.copyOf(MODES.values());
  }

  public static Mode mode(String id) {
    var mode = MODES.get(id == null ? "friendly" : id);
    if (mode == null) throw new Problem(400, "POKER_MODE", "Такого режима игры нет");
    return mode;
  }

  public String mode = "friendly";
  public String hostId;
  public String phase = "lobby";
  public long openedAt;
  public long revision;
  public int handNumber;
  public int button = -1;
  public long smallBlind;
  public long bigBlind;

  /** С чего блайнды начинались: по нему растёт лестница уровней. */
  public long baseBigBlind;

  public long ante;
  public int level = 1;
  public long levelUpAt;
  public int turnSeconds;
  public int timeBankSeconds;
  public long startingStack;
  public boolean rebuyAllowed;

  /** Пускать ли за стол новых. Решение ведущего стола, а не свойство режима. */
  public boolean seatingOpen = true;

  /** Сдавать ли следующую раздачу самим. Выключается кнопкой «Пауза». */
  public boolean autoDeal = true;

  public boolean paused;
  public List<Seat> seats = new ArrayList<>();

  /** Колода: то, что ещё не роздано. Ни одним полем не уходит в браузер. */
  public List<Integer> deck = new ArrayList<>();

  /** Сожжённые карты — как за настоящим столом, по одной перед каждой улицей. */
  public List<Integer> burned = new ArrayList<>();

  public List<Integer> board = new ArrayList<>();

  /** Зерно тасовки. Раскрывается только когда раздача сыграна. */
  public String seed;

  public String commitment;
  public String revealedSeed;
  public long pot;
  public long betToCall;
  public long lastRaise;
  public int actor = -1;
  public long actionAt;
  public long deadline;
  public long streetAt;
  public long handStartedAt;

  /** Средний стек на начало раздачи: по нему меряется, крупный ли банк выиграли. */
  public long handAverageStack;

  public List<Note> log = new ArrayList<>();
  public Result result;

  @JsonIgnoreProperties(ignoreUnknown = true)
  public static class Seat {
    public String memberId;
    public String name;
    public long stack;
    public long bet;
    public long committed;
    public long buyIn;
    public List<Integer> cards = new ArrayList<>();
    public boolean inHand;
    public boolean folded;
    public boolean allIn;

    /** Сел, пока раздача шла: играет со следующей. */
    public boolean waiting;

    /** Нажал «встать»: место освободится, когда раздача кончится. */
    public boolean leaving;

    /** Ходил ли с последнего полного повышения — по этому и кончается круг торговли. */
    public boolean acted;

    /**
     * Может только уравнять.
     *
     * <p>Короткий олл-ин, который меньше полного повышения, торговлю не открывает заново: тот, кто
     * уже сходил, обязан доложить разницу, но повышать в ответ на неё не вправе.
     */
    public boolean capped;

    public boolean allInShowdown;
    public boolean revealed;
    public boolean busted;
    public int place;
    public boolean away;
    public long awaySince;
    public long timeBankMs;
    public boolean usingBank;
    public String lastAction;
    public long lastActionAmount;
    public long lastActionAt;
    public long wonAmount;
    public String handName;
    public List<Integer> handCards = new ArrayList<>();

    public boolean taken() {
      return memberId != null;
    }

    /** Играет прямо сейчас: карты на руках и они не сброшены. */
    public boolean live() {
      return inHand && !folded;
    }

    /** Может ещё ставить: не спасовал и не в олл-ине. */
    public boolean acting() {
      return live() && !allIn;
    }
  }

  @JsonIgnoreProperties(ignoreUnknown = true)
  public static class Note {
    public long at;
    public String kind;
    public int seat = -1;
    public String name = "";
    public long amount;
    public String text = "";
  }

  @JsonIgnoreProperties(ignoreUnknown = true)
  public static class Result {
    public long at;
    public boolean showdown;
    public long pot;
    public String drama = "normal";
    public List<Award> awards = new ArrayList<>();
    public List<Integer> busted = new ArrayList<>();
  }

  @JsonIgnoreProperties(ignoreUnknown = true)
  public static class Award {
    public int seat;
    public String name = "";
    public long amount;
    public String handName = "";
    public List<Integer> handCards = new ArrayList<>();
    public boolean split;
  }

  /** Сколько фишек можно попросить на старте: ниже не сыграешь, выше — уже не счёт. */
  public static final long MIN_STACK = 200;

  public static final long MAX_STACK = 1_000_000;

  /**
   * Ровное число.
   *
   * <p>Блайнды считаются от стека, и деление даёт то 37, то 143 — числа, которыми за столом не
   * говорят. Здесь они приводятся к ближайшему «человеческому»: 1, 2, 5 и их десятки.
   */
  static long nice(long value) {
    if (value <= 1) return 1;
    long power = 1;
    while (power * 10 <= value) power *= 10;
    long lead = value / power;
    long rounded = lead >= 7 ? 10 : lead >= 4 ? 5 : lead >= 2 ? 2 : 1;
    return rounded * power;
  }

  /** Новый стол в комнате: места пустые, раздавать нечего, все решения впереди. */
  public static Table open(String hostId, String modeId, long now) {
    return open(hostId, modeId, now, 0);
  }

  /**
   * То же, но с выбранным стартовым стеком.
   *
   * <p>Блайнды при этом не назначаются отдельно, а <b>считаются от стека</b>: у режима есть своя
   * глубина — сто больших блайндов у обычной игры, тридцать у блица, — и менять нужно одно
   * число, а не три. Иначе выставить «по десять тысяч» означало бы получить блайнды от пяти
   * тысяч и игру, в которой первая же ставка ничего не решает.
   */
  public static Table open(String hostId, String modeId, long now, long stack) {
    var chosen = mode(modeId);
    var table = new Table();
    table.mode = chosen.id();
    table.hostId = hostId;
    table.openedAt = now;
    table.revision = 1;
    long wanted = stack <= 0 ? chosen.stack() : Math.max(MIN_STACK, Math.min(MAX_STACK, stack));
    long depth = Math.max(1, chosen.stack() / chosen.bigBlind());
    table.bigBlind = Math.max(2, nice(wanted / depth));
    table.smallBlind = Math.max(1, table.bigBlind / 2);
    table.baseBigBlind = table.bigBlind;
    table.turnSeconds = chosen.turnSeconds();
    table.timeBankSeconds = chosen.timeBankSeconds();
    table.startingStack = wanted;
    table.rebuyAllowed = chosen.rebuy();
    for (int index = 0; index < SEATS; index++) table.seats.add(new Seat());
    table.note(
        now,
        "open",
        -1,
        "",
        0,
        "Стол открыт: " + chosen.name() + " · по " + wanted + " фишек, блайнды "
            + table.smallBlind + "/" + table.bigBlind);
    return table;
  }

  public Mode settings() {
    return mode(mode);
  }

  public boolean playing() {
    return switch (phase) {
      case "preflop", "flop", "turn", "river" -> true;
      default -> false;
    };
  }

  // --- Места ------------------------------------------------------------------------------

  /** Сесть на свободное место. До первой раздачи это просто выбор стула. */
  public void sit(String memberId, String name, int index, long now) {
    if (index < 0 || index >= SEATS)
      throw new Problem(400, "POKER_SEAT", "Такого места за столом нет");
    if (seatOf(memberId) != null) throw Problem.conflict("POKER_SEATED", "Вы уже за столом");
    if (!seatingOpen)
      throw Problem.conflict("POKER_CLOSED", "Ведущий закрыл посадку до конца игры");
    if ("over".equals(phase)) throw Problem.conflict("POKER_OVER", "Игра закончена");
    var seat = seats.get(index);
    if (seat.taken()) throw Problem.conflict("POKER_TAKEN", "Место уже занято");
    seat.memberId = memberId;
    seat.name = name;
    seat.stack = startingStack;
    seat.buyIn = startingStack;
    seat.timeBankMs = timeBankSeconds * 1000L;
    seat.waiting = playing();
    seat.place = 0;
    note(now, "sit", index, name, 0, name + " садится за стол");
    revision++;
  }

  /**
   * Встать из-за стола.
   *
   * <p>Карты при этом сбрасываются сразу: ушедший не может ни ответить, ни вскрыться, и держать его
   * руку живой значило бы остановить раздачу на человеке, которого уже нет. Само место
   * освобождается после раздачи — его фишки ещё разыгрываются в банке.
   */
  public void stand(String memberId, long now) {
    var seat = seatOf(memberId);
    if (seat == null) return;
    int index = seats.indexOf(seat);
    if (seat.live() && playing()) {
      seat.leaving = true;
      note(now, "stand", index, seat.name, 0, seat.name + " выходит из игры");
      if (actor == index) {
        apply(seat, index, "fold", 0, now, true);
        return;
      }
      seat.folded = true;
      revision++;
      if (seats.stream().filter(Seat::live).count() <= 1) settle(now);
      return;
    }
    note(now, "stand", index, seat.name, 0, seat.name + " выходит из игры");
    free(seat);
    revision++;
  }

  /** Освободить место от того, кто сидел. Фишки уходят вместе с ним. */
  private void free(Seat seat) {
    var empty = new Seat();
    seats.set(seats.indexOf(seat), empty);
  }

  /** Докупиться до стартового стека. Только там, где режим это позволяет. */
  public void rebuy(String memberId, long now) {
    if (!rebuyAllowed) throw Problem.conflict("POKER_NO_REBUY", "В этом режиме докупаться нельзя");
    var seat = seatOf(memberId);
    if (seat == null) throw Problem.forbidden();
    if (seat.live() && playing())
      throw Problem.conflict("POKER_IN_HAND", "Докупиться можно между раздачами");
    if (seat.stack >= startingStack)
      throw Problem.conflict("POKER_STACK_FULL", "У вас и так полный стек");
    long added = startingStack - seat.stack;
    seat.stack = startingStack;
    seat.buyIn += added;
    seat.busted = false;
    seat.place = 0;
    note(now, "rebuy", seats.indexOf(seat), seat.name, added, seat.name + " докупается");
    revision++;
  }

  public Seat seatOf(String memberId) {
    if (memberId == null) return null;
    for (var seat : seats) if (memberId.equals(seat.memberId)) return seat;
    return null;
  }

  public int indexOf(String memberId) {
    var seat = seatOf(memberId);
    return seat == null ? -1 : seats.indexOf(seat);
  }

  // --- Ход игры ---------------------------------------------------------------------------

  /** Кто готов играть следующую раздачу: сидит, при фишках, здесь и не собирается уходить. */
  private boolean ready(Seat seat) {
    return seat.taken() && seat.stack > 0 && !seat.away && !seat.leaving && !seat.busted;
  }

  public long readyCount() {
    return seats.stream().filter(this::ready).count();
  }

  /** Раздать. Это делает ведущий стола — и дальше стол продолжает сам, пока его не остановят. */
  public void deal(long now) {
    if (playing()) throw Problem.conflict("POKER_IN_HAND", "Раздача уже идёт");
    if ("over".equals(phase)) throw Problem.conflict("POKER_OVER", "Игра закончена");
    if (readyCount() < 2)
      throw Problem.conflict("POKER_NEED_PLAYERS", "Нужно хотя бы двое готовых игроков");
    paused = false;
    begin(now);
  }

  private void begin(long now) {
    // Блайнды растут по времени, а не по раздачам: иначе быстрый стол проскакивал бы уровни.
    var preset = settings();
    if (preset.levelSeconds() > 0) {
      if (levelUpAt == 0) levelUpAt = now + preset.levelSeconds() * 1000L;
      else
        while (now >= levelUpAt && level < LADDER.length) {
          level++;
          levelUpAt += preset.levelSeconds() * 1000L;
          applyLevel(preset);
          note(now, "level", -1, "", bigBlind, "Блайнды выросли: " + smallBlind + "/" + bigBlind);
        }
    }
    for (var seat : seats) {
      seat.waiting = false;
      seat.bet = 0;
      seat.committed = 0;
      seat.cards = new ArrayList<>();
      seat.handCards = new ArrayList<>();
      seat.handName = null;
      seat.inHand = false;
      seat.folded = false;
      seat.allIn = false;
      seat.allInShowdown = false;
      seat.acted = false;
      seat.capped = false;
      seat.revealed = false;
      seat.lastAction = null;
      seat.lastActionAmount = 0;
      seat.wonAmount = 0;
      seat.usingBank = false;
    }
    result = null;
    var players = new ArrayList<Integer>();
    for (int index = 0; index < SEATS; index++) if (ready(seats.get(index))) players.add(index);
    if (players.size() < 2) {
      phase = "lobby";
      deadline = 0;
      actor = -1;
      return;
    }
    for (int index : players) seats.get(index).inHand = true;
    handNumber++;
    button = next(button, index -> seats.get(index).inHand);
    long total = 0;
    for (int index : players) total += seats.get(index).stack;
    handAverageStack = total / players.size();
    seed = Cards.seed();
    commitment = Cards.commitment(seed);
    revealedSeed = null;
    deck = new ArrayList<>(Cards.shuffle(seed));
    burned = new ArrayList<>();
    board = new ArrayList<>();
    pot = 0;
    betToCall = 0;
    lastRaise = bigBlind;
    handStartedAt = now;
    streetAt = now;
    phase = "preflop";
    note(
        now,
        "hand",
        -1,
        "",
        0,
        "Раздача №" + handNumber + " · блайнды " + smallBlind + "/" + bigBlind);
    if (ante > 0) for (int index : players) post(seats.get(index), ante, now, "ante");
    boolean headsUp = players.size() == 2;
    int small = headsUp ? button : next(button, index -> seats.get(index).inHand);
    int big = next(small, index -> seats.get(index).inHand);
    post(seats.get(small), smallBlind, now, "blind");
    post(seats.get(big), bigBlind, now, "blind");
    // Блайнд — это ставка, а не взнос: даже если малый блайнд оказался всем стеком, уравнивать
    // остальным всё равно большой. Лишнее вернётся через побочные банки само.
    betToCall = bigBlind;
    for (var seat : seats) seat.acted = false;
    actor = next(big, index -> seats.get(index).acting());
    actionAt = now;
    deadline = now + DEAL_MS + turnSeconds * 1000L;
    for (int round = 0; round < 2; round++)
      for (int step = 1; step <= SEATS; step++) {
        var seat = seats.get((button + step) % SEATS);
        if (seat.inHand) seat.cards.add(draw());
      }
    revision++;
  }

  private void applyLevel(Mode preset) {
    long factor = LADDER[Math.min(level, LADDER.length) - 1];
    // Лестница умножает блайнды **этого стола**, а не режима: стек выбирает ведущий, и блайнды
    // посчитаны от него. Иначе стол на тысячу фишек рос бы по расписанию стола на десять тысяч.
    long baseBig = baseBigBlind > 0 ? baseBigBlind : preset.bigBlind();
    smallBlind = Math.max(1, (baseBig * factor) / 2);
    bigBlind = baseBig * factor;
    // Анте появляется не сразу: на первых уровнях оно только мешает считать.
    ante = level >= 5 ? Math.max(1, bigBlind / 10) : 0;
  }

  private int draw() {
    return deck.remove(0);
  }

  private void post(Seat seat, long amount, long now, String kind) {
    long put = Math.min(seat.stack, amount);
    seat.stack -= put;
    seat.bet += put;
    seat.committed += put;
    if (seat.stack == 0) seat.allIn = true;
    if (put > 0)
      note(
          now,
          kind,
          seats.indexOf(seat),
          seat.name,
          put,
          seat.name + ("ante".equals(kind) ? " ставит анте " : " ставит блайнд ") + put);
  }

  /** Ход игрока. Единственная дверь, через которую человек меняет ход раздачи. */
  public void act(String memberId, String action, long chips, long now) {
    var seat = seatOf(memberId);
    if (seat == null) throw Problem.forbidden();
    int index = seats.indexOf(seat);
    if (!playing() || actor != index) throw Problem.conflict("POKER_TURN", "Сейчас не ваш ход");
    apply(seat, index, action, chips, now, false);
  }

  private void apply(Seat seat, int index, String action, long chips, long now, boolean automatic) {
    long toCall = Math.min(seat.stack, betToCall - seat.bet);
    switch (action) {
      case "fold" -> {
        seat.folded = true;
        say(seat, index, "fold", 0, now, automatic ? " не успевает и сбрасывает" : " сбрасывает");
      }
      case "check" -> {
        if (toCall > 0) throw Problem.conflict("POKER_CHECK", "Нельзя чекнуть: есть ставка");
        say(seat, index, "check", 0, now, " проверяет");
      }
      case "call" -> call(seat, index, toCall, now);
      case "bet", "raise", "allin" -> raise(seat, index, action, chips, toCall, now);
      default -> throw new Problem(400, "POKER_ACTION", "Неизвестное действие");
    }
    seat.acted = true;
    seat.usingBank = false;
    revision++;
    advance(now);
  }

  private void call(Seat seat, int index, long toCall, long now) {
    if (toCall <= 0) {
      say(seat, index, "check", 0, now, " проверяет");
      return;
    }
    take(seat, toCall);
    if (seat.allIn) say(seat, index, "allin", seat.bet, now, " идёт ва-банк ");
    else say(seat, index, "call", toCall, now, " уравнивает ");
  }

  /**
   * Ставка, повышение и ва-банк — одно действие с разными именами.
   *
   * <p>Размер называется <b>итоговой</b> ставкой («повысить до»), а не добавкой: за столом говорят
   * именно так, и в этих числах невозможно ошибиться на собственную предыдущую ставку.
   */
  private void raise(Seat seat, int index, String action, long chips, long toCall, long now) {
    long max = seat.bet + seat.stack;
    long target = "allin".equals(action) ? max : Math.min(chips, max);
    if (target <= betToCall) {
      // Всего стека не хватает даже на уравнивание: это не повышение, а ва-банк вдогонку.
      if (target < max) throw Problem.conflict("POKER_RAISE", "Ставка должна быть больше текущей");
      take(seat, seat.stack);
      say(seat, index, "allin", seat.bet, now, " идёт ва-банк ");
      return;
    }
    long minimum = Math.min(max, betToCall == 0 ? bigBlind : betToCall + lastRaise);
    if (target < minimum && target < max)
      throw Problem.conflict("POKER_MIN_RAISE", "Минимум — " + minimum);
    if (seat.capped && betToCall > 0)
      throw Problem.conflict("POKER_CAPPED", "На короткий ва-банк можно только ответить");
    long increment = target - betToCall;
    take(seat, target - seat.bet);
    if (increment >= lastRaise) {
      lastRaise = increment;
      for (var other : seats)
        if (other != seat && other.acting()) {
          other.acted = false;
          other.capped = false;
        }
    } else {
      // Короткий ва-банк торговлю заново не открывает: кто уже сходил, обязан доложить
      // разницу, но повышать в ответ на неё не вправе.
      for (var other : seats)
        if (other != seat && other.acting() && other.acted) other.capped = true;
    }
    betToCall = target;
    String kind = seat.allIn ? "allin" : toCall == 0 ? "bet" : "raise";
    String word = seat.allIn ? " идёт ва-банк " : toCall == 0 ? " ставит " : " повышает до ";
    say(seat, index, kind, target, now, word);
  }

  private void take(Seat seat, long amount) {
    long put = Math.max(0, Math.min(seat.stack, amount));
    seat.stack -= put;
    seat.bet += put;
    seat.committed += put;
    if (seat.stack == 0) seat.allIn = true;
  }

  private void say(Seat seat, int index, String action, long amount, long now, String word) {
    seat.lastAction = action;
    seat.lastActionAmount = amount;
    seat.lastActionAt = now;
    note(
        now,
        "action",
        index,
        seat.name,
        amount,
        seat.name + word + (amount > 0 ? String.valueOf(amount) : ""));
  }

  /** Кто ходит следующим, или конец круга. */
  private void advance(long now) {
    if (seats.stream().filter(Seat::live).count() <= 1) {
      settle(now);
      return;
    }
    int from = actor < 0 ? button : actor;
    int nextActor =
        next(
            from,
            index ->
                seats.get(index).acting()
                    && (!seats.get(index).acted || seats.get(index).bet < betToCall));
    if (nextActor >= 0) {
      actor = nextActor;
      actionAt = now;
      deadline = now + turnSeconds * 1000L;
      return;
    }
    collect();
    if ("river".equals(phase)) {
      settle(now);
      return;
    }
    // Ставить больше некому: карты просто доигрываются, и между улицами нужна пауза, иначе
    // борд появляется целиком за один кадр и смотреть не на что.
    if (seats.stream().filter(Seat::acting).count() <= 1) {
      for (var seat : seats) if (seat.live()) seat.allInShowdown = true;
      actor = -1;
      deadline = now + RUNOUT_MS;
      return;
    }
    street(now);
  }

  /**
   * Ставки круга уходят в банк: дальше они уже не «на столе», а «в банке».
   *
   * <p>Сначала возвращается <b>неперекрытая</b> часть: если ва-банк на тысячу уравняли только
   * двумястами, восемьсот принадлежат тому, кто их поставил, — их никто не разыгрывал. Без этого
   * возврата человек «выигрывал» собственные фишки, и цифра победы врала бы каждый раз, когда
   * соперник оказывался короче.
   */
  private void collect() {
    Seat highest = null;
    long first = 0;
    long second = 0;
    for (var seat : seats) {
      if (seat.bet > first) {
        second = first;
        first = seat.bet;
        highest = seat;
      } else if (seat.bet > second) second = seat.bet;
    }
    if (highest != null && first > second) {
      long back = first - second;
      highest.stack += back;
      highest.bet -= back;
      highest.committed -= back;
      if (highest.stack > 0) highest.allIn = false;
    }
    for (var seat : seats) {
      pot += seat.bet;
      seat.bet = 0;
      seat.acted = false;
      seat.capped = false;
    }
    betToCall = 0;
    lastRaise = bigBlind;
  }

  private void street(long now) {
    burned.add(draw());
    switch (phase) {
      case "preflop" -> {
        board.add(draw());
        board.add(draw());
        board.add(draw());
        phase = "flop";
        note(now, "street", -1, "", 0, "Флоп");
      }
      case "flop" -> {
        board.add(draw());
        phase = "turn";
        note(now, "street", -1, "", 0, "Тёрн");
      }
      case "turn" -> {
        board.add(draw());
        phase = "river";
        note(now, "street", -1, "", 0, "Ривер");
      }
      default -> throw new IllegalStateException("Улица после ривера: " + phase);
    }
    streetAt = now;
    revision++;
    if (seats.stream().filter(Seat::acting).count() <= 1) {
      actor = -1;
      deadline = now + RUNOUT_MS;
      return;
    }
    actor = next(button, index -> seats.get(index).acting());
    actionAt = now;
    deadline = now + turnSeconds * 1000L;
  }

  // --- Итог раздачи -----------------------------------------------------------------------

  /**
   * Побочные банки.
   *
   * <p>Считаются по вложенному за всю раздачу, а не по последнему кругу: тот, кто пошёл ва-банк на
   * двести, не может выиграть больше двухсот с каждого — остальное разыгрывают между собой те, кто
   * доставил. Деньги спасовавших в банк входят, а сами они — нет.
   */
  public List<long[]> potLevels() {
    var levels = new ArrayList<Long>();
    for (var seat : seats)
      if (seat.committed > 0 && !levels.contains(seat.committed)) levels.add(seat.committed);
    levels.sort(Long::compare);
    var pots = new ArrayList<long[]>();
    long previous = 0;
    for (long level : levels) {
      long amount = 0;
      for (var seat : seats)
        amount += Math.max(0, Math.min(seat.committed, level) - Math.min(seat.committed, previous));
      long eligible = seats.stream().filter(seat -> seat.live() && seat.committed >= level).count();
      if (amount > 0 && eligible > 0) pots.add(new long[] {amount, level});
      else if (amount > 0 && !pots.isEmpty()) pots.get(pots.size() - 1)[0] += amount;
      previous = level;
    }
    return pots;
  }

  private void settle(long now) {
    collect();
    var live = new ArrayList<Integer>();
    for (int index = 0; index < SEATS; index++) if (seats.get(index).live()) live.add(index);
    result = new Result();
    result.at = now;
    result.pot = pot;
    result.showdown = live.size() > 1;
    revealedSeed = seed;
    if (live.size() == 1) {
      var winner = seats.get(live.get(0));
      award(winner, live.get(0), pot, null, false, now);
    } else {
      var hands = new LinkedHashMap<Integer, Hands.Hand>();
      for (int index : live) {
        var cards = new ArrayList<>(seats.get(index).cards);
        cards.addAll(board);
        var hand = Hands.best(cards);
        hands.put(index, hand);
        var seat = seats.get(index);
        seat.revealed = true;
        seat.handName = hand.name();
        seat.handCards = hand.cards();
      }
      for (long[] level : potLevels()) {
        long amount = level[0];
        long threshold = level[1];
        var eligible =
            live.stream().filter(index -> seats.get(index).committed >= threshold).toList();
        if (eligible.isEmpty()) continue;
        int best = eligible.stream().mapToInt(index -> hands.get(index).score()).max().orElse(0);
        var winners = eligible.stream().filter(index -> hands.get(index).score() == best).toList();
        long share = amount / winners.size();
        long odd = amount - share * winners.size();
        // Лишняя фишка — тому, кто ближе к кнопке слева: так её отдают за настоящим столом.
        var ordered = new ArrayList<>(winners);
        ordered.sort(
            (a, b) ->
                Integer.compare(
                    (a - button + SEATS - 1) % SEATS, (b - button + SEATS - 1) % SEATS));
        for (int i = 0; i < ordered.size(); i++) {
          int index = ordered.get(i);
          long amountFor = share + (i < odd ? 1 : 0);
          award(seats.get(index), index, amountFor, hands.get(index), winners.size() > 1, now);
        }
      }
    }
    pot = 0;
    for (var seat : seats) {
      if (seat.inHand && seat.stack == 0 && !seat.folded) seat.allInShowdown = true;
      if (seat.inHand && seat.stack == 0) result.busted.add(seats.indexOf(seat));
    }
    result.drama = drama();
    actor = -1;
    phase = "showdown";
    deadline = now + (result.showdown ? SHOWDOWN_MS : QUICK_MS);
    revision++;
  }

  private void award(Seat seat, int index, long amount, Hands.Hand hand, boolean split, long now) {
    seat.stack += amount;
    seat.wonAmount += amount;
    var entry = new Award();
    entry.seat = index;
    entry.name = seat.name;
    entry.amount = amount;
    entry.handName = hand == null ? "" : hand.name();
    entry.handCards = hand == null ? List.of() : hand.cards();
    entry.split = split;
    result.awards.add(entry);
    note(
        now,
        "win",
        index,
        seat.name,
        amount,
        seat.name + " забирает " + amount + (hand == null ? "" : " · " + hand.name()));
  }

  /**
   * Насколько громко праздновать.
   *
   * <p>Банк сам по себе ничего не говорит: две тысячи — это всё, если у стола по три тысячи, и
   * мелочь, если по тридцать. Поэтому мерилом взят средний стек на начало раздачи, а не число
   * фишек. Вылет громче любого банка: кого-то из-за стола только что не стало.
   */
  private String drama() {
    if (!result.busted.isEmpty()) return "huge";
    long measure = Math.max(handAverageStack, bigBlind * 10);
    double scale = measure <= 0 ? 0 : (double) result.pot / measure;
    long allIn = seats.stream().filter(seat -> seat.allInShowdown).count();
    if (scale >= 1.0 || (result.showdown && allIn >= 3)) return "huge";
    if (scale >= 0.45 || (result.showdown && allIn >= 2)) return "big";
    return "normal";
  }

  private void finish(long now) {
    /*
     Кто вылетел этой раздачей — считается до того, как стол приберут.
     Двое могут вылететь в одной раздаче, и место между ними делит вложенное: у кого стек
     был больше, тот и продержался дольше. Эти числа через строчку обнулятся, поэтому
     порядок берётся сейчас.
    */
    var falling = new ArrayList<Seat>();
    for (var seat : seats)
      if (seat.taken() && seat.inHand && seat.stack == 0 && !seat.busted && !rebuyAllowed)
        falling.add(seat);
    falling.sort((a, b) -> Long.compare(b.committed, a.committed));
    for (var seat : seats) {
      seat.inHand = false;
      seat.allIn = false;
      seat.cards = new ArrayList<>();
      seat.bet = 0;
      seat.committed = 0;
    }
    int place = (int) seats.stream().filter(seat -> seat.taken() && seat.stack > 0).count() + 1;
    for (var seat : falling) {
      seat.busted = true;
      seat.place = place++;
      note(
          now,
          "bust",
          seats.indexOf(seat),
          seat.name,
          0,
          seat.name + " выбывает · " + seat.place + " место");
    }
    for (var seat : seats) if (seat.taken() && seat.leaving) free(seat);
    if (!rebuyAllowed
        && seats.stream().filter(seat -> seat.taken() && seat.stack > 0).count() == 1) {
      var winner =
          seats.stream().filter(seat -> seat.taken() && seat.stack > 0).findFirst().orElseThrow();
      winner.place = 1;
      phase = "over";
      actor = -1;
      deadline = 0;
      note(
          now,
          "over",
          seats.indexOf(winner),
          winner.name,
          winner.stack,
          winner.name + " выигрывает игру");
      revision++;
      return;
    }
    phase = "lobby";
    actor = -1;
    deadline = autoDeal && !paused && readyCount() >= 2 ? now + NEXT_HAND_MS : 0;
    revision++;
  }

  // --- Время ------------------------------------------------------------------------------

  /**
   * Двинуть стол, если его срок вышел. Возвращает {@code true}, если что-то изменилось.
   *
   * <p>Всё, что происходит «само» — конец хода, доигрывание борда, следующая раздача, — случается
   * здесь, и только по часам сервера.
   */
  public boolean tick(long now) {
    if (deadline == 0 || now < deadline) return false;
    switch (phase) {
      case "showdown" -> finish(now);
      case "lobby" -> {
        if (autoDeal && !paused && readyCount() >= 2) begin(now);
        else deadline = 0;
      }
      case "preflop", "flop", "turn", "river" -> {
        // Ставить некому: борд доигрывается сам, а после ривера сразу считается итог.
        if (actor < 0 && "river".equals(phase)) settle(now);
        else if (actor < 0) street(now);
        else {
          var seat = seats.get(actor);
          // Банк времени — это не поблажка, а страховка от «отвернулся на минуту»: он выдаётся
          // раз на посадку и тратится целиком, когда обычные секунды кончились.
          if (!seat.usingBank && seat.timeBankMs > 0 && !seat.away) {
            seat.usingBank = true;
            deadline = now + seat.timeBankMs;
            seat.timeBankMs = 0;
            revision++;
            return true;
          }
          apply(seat, actor, seat.bet >= betToCall ? "check" : "fold", 0, now, true);
        }
      }
      default -> deadline = 0;
    }
    return true;
  }

  /**
   * Кто из сидящих сейчас во встрече, а кто ушёл.
   *
   * <p>За ушедшего стол ходит сам — иначе один закрытый браузер останавливал бы игру на все
   * тридцать секунд каждого круга. Его место держится пять минут: человек мог просто потерять
   * связь, и отдавать его стул другому через секунду было бы грубо.
   */
  public boolean presence(Set<String> present, long now) {
    boolean changed = false;
    for (var seat : seats) {
      if (!seat.taken()) continue;
      boolean away = !present.contains(seat.memberId);
      if (away != seat.away) {
        seat.away = away;
        seat.awaySince = away ? now : 0;
        changed = true;
      }
      if (seat.away && !seat.live() && now - seat.awaySince > AWAY_STAND_MS) {
        note(now, "stand", seats.indexOf(seat), seat.name, 0, seat.name + " покидает стол");
        free(seat);
        changed = true;
      }
    }
    if (playing() && actor >= 0) {
      var seat = seats.get(actor);
      if (seat.away && now - seat.awaySince > AWAY_ACT_MS) {
        apply(seat, actor, seat.bet >= betToCall ? "check" : "fold", 0, now, true);
        changed = true;
      }
    }
    if (changed) revision++;
    return changed;
  }

  /** Переименовать и перепривязать место: вернувшийся во встречу получает новый идентификатор. */
  public boolean rebind(String previousId, String memberId, String name) {
    var seat = seatOf(previousId);
    if (seat == null) return false;
    seat.memberId = memberId;
    seat.name = name;
    seat.away = false;
    seat.awaySince = 0;
    revision++;
    return true;
  }

  public void host(String memberId) {
    hostId = memberId;
    revision++;
  }

  /** Настройки стола: посадка, автоматическая раздача, пауза. */
  public void configure(String option, long now) {
    switch (option) {
      case "seating-open" -> {
        seatingOpen = true;
        note(now, "settings", -1, "", 0, "Посадка открыта");
      }
      case "seating-locked" -> {
        seatingOpen = false;
        note(now, "settings", -1, "", 0, "Посадка закрыта до конца игры");
      }
      case "pause" -> {
        paused = true;
        if ("lobby".equals(phase)) deadline = 0;
        note(now, "settings", -1, "", 0, "Игра встанет после этой раздачи");
      }
      case "resume" -> {
        paused = false;
        if ("lobby".equals(phase) && readyCount() >= 2) deadline = now + NEXT_HAND_MS;
        note(now, "settings", -1, "", 0, "Игра продолжается");
      }
      case "auto-deal" -> {
        autoDeal = !autoDeal;
        if (autoDeal && "lobby".equals(phase) && !paused && readyCount() >= 2)
          deadline = now + NEXT_HAND_MS;
        note(
            now,
            "settings",
            -1,
            "",
            0,
            autoDeal ? "Раздачи идут подряд" : "Каждую раздачу сдаёт ведущий");
      }
      default -> throw new Problem(400, "POKER_OPTION", "Неизвестная настройка стола");
    }
    revision++;
  }

  /** Показать свои карты, когда показывать не обязан. Право, а не обязанность. */
  public void reveal(String memberId, long now) {
    var seat = seatOf(memberId);
    if (seat == null || seat.cards.isEmpty()) throw Problem.forbidden();
    if (seat.revealed) return;
    seat.revealed = true;
    note(now, "reveal", seats.indexOf(seat), seat.name, 0, seat.name + " показывает карты");
    revision++;
  }

  private int next(int from, IntPredicate ok) {
    for (int step = 1; step <= SEATS; step++) {
      int index = (from + step + SEATS) % SEATS;
      if (ok.test(index)) return index;
    }
    return -1;
  }

  private void note(long at, String kind, int seat, String name, long amount, String text) {
    var entry = new Note();
    entry.at = at;
    entry.kind = kind;
    entry.seat = seat;
    entry.name = name == null ? "" : name;
    entry.amount = amount;
    entry.text = text;
    log.add(entry);
    while (log.size() > LOG_LIMIT) log.remove(0);
  }

  // --- Что видно снаружи ------------------------------------------------------------------

  /** Стол глазами одного человека. {@code viewerId == null} — глазами того, кто не играет. */
  public TableView view(String viewerId, long now) {
    var preset = settings();
    var seatViews = new ArrayList<TableView.SeatView>(SEATS);
    for (int index = 0; index < SEATS; index++) {
      var seat = seats.get(index);
      boolean own = seat.taken() && seat.memberId.equals(viewerId);
      boolean open = seat.revealed || own;
      seatViews.add(
          new TableView.SeatView(
              index,
              seat.memberId,
              seat.name == null ? "" : seat.name,
              seat.stack,
              seat.bet,
              seat.committed,
              seat.buyIn,
              open ? Cards.texts(seat.cards) : List.of(),
              seat.cards.size(),
              seat.inHand,
              seat.folded,
              seat.allIn,
              seat.waiting,
              seat.away,
              seat.leaving,
              seat.busted,
              seat.place,
              seat.lastAction == null ? "" : seat.lastAction,
              seat.lastActionAmount,
              seat.wonAmount,
              seat.handName == null ? "" : seat.handName,
              Cards.texts(seat.handCards),
              seat.timeBankMs));
    }
    var pots = new ArrayList<TableView.PotView>();
    for (long[] level : potLevels()) {
      long threshold = level[1];
      var eligible = new ArrayList<Integer>();
      for (int index = 0; index < SEATS; index++)
        if (seats.get(index).live() && seats.get(index).committed >= threshold) eligible.add(index);
      pots.add(new TableView.PotView(level[0], eligible));
    }
    var notes =
        log.stream()
            .map(
                entry ->
                    new TableView.NoteView(
                        entry.at, entry.kind, entry.seat, entry.name, entry.amount, entry.text))
            .toList();
    return new TableView(
        mode,
        preset.name(),
        phase,
        hostId,
        handNumber,
        revision,
        button,
        smallBlind,
        bigBlind,
        ante,
        level,
        levelUpAt,
        turnSeconds,
        seatingOpen,
        autoDeal,
        paused,
        rebuyAllowed,
        startingStack,
        pot,
        betToCall,
        actor,
        actionAt,
        deadline,
        streetAt,
        handStartedAt,
        Cards.texts(board),
        seatViews,
        pots,
        notes,
        resultView(),
        you(viewerId),
        commitment == null ? "" : commitment,
        revealedSeed == null ? "" : revealedSeed);
  }

  private TableView.ResultView resultView() {
    if (result == null) return null;
    return new TableView.ResultView(
        result.at,
        result.showdown,
        result.pot,
        result.drama,
        result.awards.stream()
            .map(
                award ->
                    new TableView.AwardView(
                        award.seat,
                        award.name,
                        award.amount,
                        award.handName,
                        Cards.texts(award.handCards),
                        award.split))
            .toList(),
        List.copyOf(result.busted));
  }

  private TableView.YouView you(String viewerId) {
    var seat = seatOf(viewerId);
    if (seat == null) return null;
    int index = seats.indexOf(seat);
    boolean turn = playing() && actor == index;
    return new TableView.YouView(
        index,
        Cards.texts(seat.cards),
        ownHand(seat),
        turn ? actions(seat) : List.of(),
        Math.min(seat.stack, Math.max(0, betToCall - seat.bet)),
        Math.min(seat.bet + seat.stack, betToCall == 0 ? bigBlind : betToCall + lastRaise),
        seat.bet + seat.stack,
        seat.timeBankMs,
        turn);
  }

  /**
   * Что у этого человека собралось прямо сейчас.
   *
   * <p>Считается по его собственным картам и общему борду — то есть не раскрывает ничего, чего он
   * и так не видит. Нужно это ровно там, где человек иначе складывает две карты с пятью в уме на
   * каждой улице, а заодно избавляет от вопроса «у меня вообще стрит или нет».
   */
  private String ownHand(Seat seat) {
    if (seat.cards.size() < 2) return "";
    if (board.size() < 3) return Hands.pocket(seat.cards.get(0), seat.cards.get(1));
    var cards = new ArrayList<>(seat.cards);
    cards.addAll(board);
    return Hands.best(cards).name();
  }

  /** Что законно нажать. Считает сервер — чтобы кнопка и правило не могли разойтись. */
  private List<String> actions(Seat seat) {
    var actions = new ArrayList<String>();
    long toCall = betToCall - seat.bet;
    if (toCall > 0) actions.add("fold");
    if (toCall <= 0) actions.add("check");
    if (toCall > 0 && seat.stack > 0) actions.add("call");
    boolean canRaise = seat.stack > toCall && !(seat.capped && betToCall > 0);
    if (canRaise) actions.add(betToCall == 0 ? "bet" : "raise");
    if (seat.stack > 0) actions.add("allin");
    return actions;
  }
}
