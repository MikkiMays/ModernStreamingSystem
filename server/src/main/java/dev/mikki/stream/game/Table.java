package dev.mikki.stream.game;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import dev.mikki.stream.shared.Problem;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Set;
import java.util.TreeMap;
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

  /**
   * Сколько вскрытие стоит на столе, когда стол не сдаёт сам.
   *
   * <p>Семи секунд хватает, чтобы заметить, что раздача кончилась, и не хватает, чтобы разобрать
   * чем: чьи карты открылись, что сложилось у соседа, откуда взялся стрит. Поэтому в ручном режиме
   * вскрытие ждёт ведущего стола — а эти три минуты только страховка от ведущего, который ушёл, и
   * ничего не раздают сами: стол просто прибирает карты и возвращается к ожиданию.
   */
  public static final long REVIEW_MS = 180000;

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

  /**
   * Сколько стол ждёт, когда за ним не осталось никого.
   *
   * <p>Десять минут — это «мы отошли», а не «мы разошлись»: за чаем, покурить, ответить на звонок.
   * Если за это время никто не сел и раздача не пошла, игра заканчивается сама и уходит в историю
   * комнаты. Меньше нельзя: случайно завершённая игра — это чужие стеки, которых уже не вернуть.
   */
  public static final long LINGER_MS = 600000;

  /**
   * Сколько отсутствия — и место освобождается для других.
   *
   * <p>Тот же срок, что и у пустого стола, и это не совпадение. Обещание у них одно: десять минут
   * ничего не пропадает. Пока эти числа расходились (место освобождалось через пять минут, а игра
   * кончалась через десять), половину обещанного времени стек ушедшего был уже не его.
   */
  public static final long AWAY_STAND_MS = LINGER_MS;

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

  /** Имя этой игры: с ним она и ложится в историю комнаты. */
  public String gameId;

  public String mode = "friendly";
  public String hostId;
  public String phase = "lobby";
  public long openedAt;
  public long revision;
  public long visualSequence;
  public List<GameVisualEvent> visualEvents = new ArrayList<>();
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

  /**
   * Разрешает ли режим докупаться. Осталось от времён, когда это был единственный вопрос.
   *
   * <p>Читается только как запасной ответ для столов, открытых прежним ядром: живые правила лежат в
   * {@link #rebuys} и {@link #rebuyChips}, а спрашивать о них нужно через {@link #rebuyLimit()}.
   */
  public boolean rebuyAllowed;

  /**
   * Сколько додепов разрешено одному человеку: {@code -1} — сколько угодно, {@code 0} — ни одного.
   *
   * <p>{@code null} означает «стол открыт прежним ядром»: тогда ответ берётся у режима. Поэтому
   * поле и объектное — у {@code int} нет значения «не спрашивали», и ноль был бы неотличим от
   * «додепы запрещены».
   */
  public Integer rebuys;

  /** Сколько фишек даёт один додеп. По умолчанию — столько же, сколько первый вход. */
  public long rebuyChips;

  /** Пускать ли за стол новых. Решение ведущего стола, а не свойство режима. */
  public boolean seatingOpen = true;

  /**
   * Сдавать ли следующую раздачу самим.
   *
   * <p>ПО УМОЛЧАНИЮ — НЕТ, и это решение о том, кто держит темп. Стол, который сдаёт сам, гонит:
   * раздача кончилась, посмотреть на вскрытие не успели, а карты уже летят снова. Каждый круг
   * начинает ведущий стола кнопкой, а кто хочет обратно к автомату — включает «Авто» в настройках
   * игры.
   */
  public boolean autoDeal;

  public boolean paused;

  /** Сколько оставалось на ход, когда нажали паузу, и сколько его уже прошло. */
  public long pausedRemaining;

  public long pausedElapsed;

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

  /** Самый крупный банк игры: тот, что видели все, а не чей-то личный. */
  public long biggestPot;

  /**
   * С каких пор за столом никого.
   *
   * <p>Ноль — значит есть: кто-то сидит и он во встрече, или прямо сейчас идёт раздача. Отсюда и
   * считается срок, после которого игра заканчивается сама ({@link #LINGER_MS}).
   */
  public long idleSince;

  /** Ушла ли игра в историю комнаты. Записывается один раз, чем бы она ни кончилась. */
  public boolean archived;

  /**
   * Что игра насчитала про каждого, кто за ней сидел.
   *
   * <p>Ключ — человек, а не место: он мог встать, сесть на другой стул, переподключиться с новым
   * идентификатором — и все три раза это один и тот же игрок с одной и той же статистикой. Место
   * такой памяти не годится: его освобождают, и вместе с ним исчезло бы всё, что человек сделал.
   */
  public Map<String, Player> tally = new LinkedHashMap<>();

  /**
   * Итог одного человека за всю игру.
   *
   * <p>Копится по ходу дела, а не считается в конце: к концу игры уже нет ни карт, ни ставок, ни
   * половины сидевших — восстановить «сколько раз он пошёл ва-банк» будет неоткуда.
   */
  @JsonIgnoreProperties(ignoreUnknown = true)
  public static class Player {
    public String name;
    public long buyIn;
    public int rebuys;
    public long invested;
    public long won;
    public int hands;
    public int handsWon;
    public int showdowns;
    public int showdownWins;
    public int allIns;
    public int folds;
    public int checks;
    public int calls;
    public int raises;
    public int voluntary;
    public long biggestBet;
    public long biggestPotWon;
    public long peakStack;
    public int knockouts;
    public int streak;
    public int bestStreak;
    public String bestHand;
    public int bestHandScore;

    /** С чем человек остался. Обновляется и когда он встаёт из-за стола, и в конце игры. */
    public long stack;

    public int place;
  }

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

    /** Вложился в эту раздачу сам, а не блайндом: этим и меряется «азартный». */
    public boolean putIn;

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

    /**
     * Сколько ходов подряд человек не сделал.
     *
     * <p>Два пропуска — и место освобождается: стол, который каждый круг ждёт по тридцать секунд
     * того, кто ушёл, перестаёт быть игрой для остальных. Любое действие обнуляет счётчик.
     */
    public int misses;

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
   * глубина — сто больших блайндов у обычной игры, тридцать у блица, — и менять нужно одно число, а
   * не три. Иначе выставить «по десять тысяч» означало бы получить блайнды от пяти тысяч и игру, в
   * которой первая же ставка ничего не решает.
   */
  public static Table open(String hostId, String modeId, long now, long stack) {
    var chosen = mode(modeId);
    var table = new Table();
    table.gameId = java.util.UUID.randomUUID().toString();
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
    // Дружеская игра пускает докупаться сколько угодно, турнир — ни разу. Дальше это решение
    // ведущего стола, а не свойство режима.
    table.rebuys = chosen.rebuy() ? -1 : 0;
    table.rebuyChips = wanted;
    for (int index = 0; index < SEATS; index++) table.seats.add(new Seat());
    table.note(
        now,
        "open",
        -1,
        "",
        0,
        "Стол открыт: "
            + chosen.name()
            + " · по "
            + wanted
            + " фишек, блайнды "
            + table.smallBlind
            + "/"
            + table.bigBlind);
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
  public void sit(String memberId, String name, Integer index, long now) {
    if (index != null && (index < 0 || index >= SEATS))
      throw new Problem(400, "POKER_SEAT", "Такого места за столом нет");
    if (seatOf(memberId) != null) throw Problem.conflict("POKER_SEATED", "Вы уже за столом");
    if (!seatingOpen)
      throw Problem.conflict("POKER_CLOSED", "Ведущий закрыл посадку до конца игры");
    if ("over".equals(phase)) throw Problem.conflict("POKER_OVER", "Игра закончена");
    // This selection runs inside the room command transaction/lock, not from a client snapshot.
    if (index == null) {
      index =
          java.util.stream.IntStream.range(0, SEATS)
              .filter(candidate -> !seats.get(candidate).taken())
              .findFirst()
              .orElseThrow(() -> Problem.conflict("POKER_FULL", "За столом нет свободных мест"));
    }
    var seat = seats.get(index);
    if (seat.taken()) throw Problem.conflict("POKER_TAKEN", "Место уже занято");
    seat.memberId = memberId;
    seat.name = name;
    seat.stack = startingStack;
    seat.buyIn = startingStack;
    seat.timeBankMs = timeBankSeconds * 1000L;
    seat.waiting = playing();
    seat.place = 0;
    var player = player(memberId, name);
    // Второй приход за стол — это те же фишки, взятые заново: человек встал со своим стеком и
    // сел с новым. В счёт докупок это и идёт, иначе «сколько он брал» перестало бы сходиться.
    if (player.buyIn > 0) player.rebuys++;
    player.buyIn += startingStack;
    player.place = 0;
    player.stack = startingStack;
    player.peakStack = Math.max(player.peakStack, startingStack);
    idleSince = 0;
    note(now, "sit", index, name, 0, name + " садится за стол");
    revision++;
  }

  /** Память об этом человеке: заводится, когда он садится, и живёт до конца игры. */
  private Player player(String memberId, String name) {
    var player = tally.computeIfAbsent(memberId, key -> new Player());
    if (name != null && !name.isBlank()) player.name = name;
    return player;
  }

  /** То же, но только если человек и правда играл. Иначе считать нечего. */
  private Player known(String memberId) {
    return memberId == null ? null : tally.get(memberId);
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
    // Стек и место запоминаются до того, как стул опустеет: иначе в итогах игры человек,
    // вставший за пять раздач до конца, остался бы с нулём, которого у него не было.
    var player = known(seat.memberId);
    if (player != null) {
      player.stack = seat.stack;
      if (seat.place > 0) player.place = seat.place;
    }
    var empty = new Seat();
    seats.set(seats.indexOf(seat), empty);
  }

  /** Сколько додепов разрешено одному человеку: -1 — сколько угодно, 0 — ни одного. */
  public int rebuyLimit() {
    return rebuys != null ? rebuys : rebuyAllowed ? -1 : 0;
  }

  /** Сколько фишек даёт один додеп на этом столе. */
  public long rebuySize() {
    return rebuyChips > 0 ? rebuyChips : startingStack;
  }

  /** Сколько додепов осталось у этого человека: -1 — сколько угодно. */
  public int rebuysLeft(String memberId) {
    int limit = rebuyLimit();
    if (limit <= 0) return limit == 0 ? 0 : -1;
    var player = known(memberId);
    return Math.max(0, limit - (player == null ? 0 : player.rebuys));
  }

  /**
   * Может ли этот человек взять фишки заново.
   *
   * <p>ДОДЕП — ЭТО ПРО ПУСТОЙ СТЕК, А НЕ ПРО КОРОТКИЙ. Раньше можно было «дотянуть» любой стек до
   * стартового, и одно нажатие делало это молча: человек ещё играл, а фишки уже добавились. Теперь
   * фишки берут заново там, где их не осталось совсем, — и берут решением, а не случайным нажатием.
   */
  public boolean canRebuy(Seat seat) {
    if (seat == null || !seat.taken()) return false;
    if (rebuyLimit() == 0) return false;
    if (seat.stack > 0) return false;
    if (seat.live() && playing()) return false;
    return rebuysLeft(seat.memberId) != 0;
  }

  /**
   * Может ли этот человек взять фишки когда-нибудь — хоть и не сейчас.
   *
   * <p>Отличается от {@link #canRebuy(Seat)} тем, что не смотрит на текущую раздачу: вопрос здесь
   * не «дать ли кнопку», а «выбыл ли человек из игры». Пока додеп у него есть, он не выбыл.
   */
  private boolean canRebuyLater(Seat seat) {
    if (seat == null || !seat.taken() || seat.stack > 0) return false;
    return rebuyLimit() != 0 && rebuysLeft(seat.memberId) != 0;
  }

  /**
   * Взять фишки заново.
   *
   * <p>Сумму называет тот, кто берёт, — но не больше разрешённой ведущим: «сколько дают» решает
   * стол, «сколько беру» решает человек. Ноль означает «сколько дают».
   */
  public void rebuy(String memberId, long chips, long now) {
    var seat = seatOf(memberId);
    if (seat == null) throw Problem.forbidden();
    if (rebuyLimit() == 0)
      throw Problem.conflict("POKER_NO_REBUY", "За этим столом докупаться нельзя");
    if (rebuysLeft(memberId) == 0)
      throw Problem.conflict("POKER_NO_REBUY", "Додепы за этим столом кончились");
    if (seat.live() && playing())
      throw Problem.conflict("POKER_IN_HAND", "Докупиться можно между раздачами");
    if (seat.stack > 0) throw Problem.conflict("POKER_STACK_FULL", "Фишки ещё есть");
    long added = chips <= 0 ? rebuySize() : Math.min(rebuySize(), Math.max(MIN_STACK, chips));
    seat.stack = added;
    seat.buyIn += added;
    seat.busted = false;
    seat.place = 0;
    var player = player(memberId, seat.name);
    player.rebuys++;
    player.buyIn += added;
    player.stack = seat.stack;
    player.place = 0;
    note(now, "rebuy", seats.indexOf(seat), seat.name, added, seat.name + " берёт " + added);
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
    /*
     Сначала прибрать, потом проверять — и проверять уже то, что получилось.

     «Раздать» прямо со вскрытия означает и «прибери прошлую»: требовать для этого двух нажатий
     подряд незачем. Но уборка меняет стол: последней раздачей кто-то мог вылететь, и игра —
     кончиться. Поэтому все проверки стоят после неё, а не до: иначе человек получал бы
     «нужно хотя бы двое» там, где на самом деле уже определился победитель.
    */
    next(now);
    if ("over".equals(phase)) throw Problem.conflict("POKER_OVER", "Игра закончена");
    if (readyCount() < 2)
      throw Problem.conflict("POKER_NEED_PLAYERS", "Нужно хотя бы двое готовых игроков");
    paused = false;
    begin(now);
  }

  /**
   * Убрать вскрытие со стола, ничего не раздавая.
   *
   * <p>Это и есть «Продолжить»: карты собраны, вылетевшие посчитаны, стол вернулся к ожиданию — а
   * раздаёт по-прежнему тот, кто решит и когда решит.
   */
  public void next(long now) {
    if (!"showdown".equals(phase)) return;
    finish(now);
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
      seat.putIn = false;
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
    for (int index : players) {
      var seat = seats.get(index);
      seat.inHand = true;
      var player = player(seat.memberId, seat.name);
      player.hands++;
    }
    handNumber++;
    idleSince = 0;
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
        int index = (button + step) % SEATS;
        var seat = seats.get(index);
        if (seat.inHand) {
          seat.cards.add(draw());
          visual(now, "deal", null, index, 1, List.of());
        }
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
    if (paused) throw Problem.conflict("POKER_PAUSED", "Игра на паузе");
    if (!playing() || actor != index) throw Problem.conflict("POKER_TURN", "Сейчас не ваш ход");
    seat.misses = 0;
    apply(seat, index, action, chips, now, false);
  }

  private void apply(Seat seat, int index, String action, long chips, long now, boolean automatic) {
    long toCall = Math.min(seat.stack, betToCall - seat.bet);
    switch (action) {
      case "fold" -> {
        seat.folded = true;
        visual(now, "discard", index, null, seat.cards.size(), List.of());
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
    count(seat, action, amount);
    note(
        now,
        "action",
        index,
        seat.name,
        amount,
        seat.name + word + (amount > 0 ? String.valueOf(amount) : ""));
  }

  /**
   * Что человек сделал — в его счёт за игру.
   *
   * <p>Считается здесь, в единственном месте, через которое проходит любое действие: и своё, и
   * сделанное столом за того, кто не успел. Автоматический пас — это тоже пас, и прятать его из
   * статистики значило бы рассказывать о игре не то, что в ней было.
   */
  private void count(Seat seat, String action, long amount) {
    var player = known(seat.memberId);
    if (player == null) return;
    switch (action) {
      case "fold" -> player.folds++;
      case "check" -> player.checks++;
      case "call" -> player.calls++;
      case "bet", "raise" -> player.raises++;
      case "allin" -> player.allIns++;
      default -> {}
    }
    if (amount > 0) player.biggestBet = Math.max(player.biggestBet, amount);
    // Добровольно вложился — то есть заплатил не блайндом, а своим решением. Один раз за
    // раздачу: три повышения на одной улице — это всё ещё одна сыгранная рука.
    if (!seat.putIn && !"fold".equals(action) && !"check".equals(action)) {
      seat.putIn = true;
      player.voluntary++;
    }
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
    int previousCards = board.size();
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
    for (int index = previousCards; index < board.size(); index++)
      visual(now, "draw", null, null, 1, List.of(Cards.text(board.get(index))));
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
    // Вложенное считается здесь: `collect` уже вернул неперекрытую часть ставки, а через
    // несколько строк `finish` обнулит `committed` — позже взять это число будет негде.
    for (var seat : seats) {
      var player = known(seat.memberId);
      if (player != null && seat.committed > 0) player.invested += seat.committed;
    }
    var live = new ArrayList<Integer>();
    for (int index = 0; index < SEATS; index++) if (seats.get(index).live()) live.add(index);
    result = new Result();
    result.at = now;
    result.pot = pot;
    result.showdown = live.size() > 1;
    revealedSeed = seed;
    // Кто какой банк забрал: по этому и считается, чьи фишки кончились у выбывшего.
    var potWinners = new TreeMap<Long, Integer>();
    if (live.size() == 1) {
      var winner = seats.get(live.get(0));
      award(winner, live.get(0), pot, null, false, now);
      potWinners.put(Long.MAX_VALUE, live.get(0));
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
        potWinners.put(threshold, ordered.get(0));
      }
    }
    pot = 0;
    for (var seat : seats) {
      if (seat.inHand && seat.stack == 0 && !seat.folded) seat.allInShowdown = true;
      if (seat.inHand && seat.stack == 0) result.busted.add(seats.indexOf(seat));
    }
    result.drama = drama();
    biggestPot = Math.max(biggestPot, result.pot);
    knockouts(potWinners);
    /*
     Итоги раздачи в счёт каждого играющего.

     Серия — это выигранные подряд раздачи, и обнуляет её любая сыгранная и не выигранная:
     считать её можно только здесь, где известно и кто играл, и кто забрал. Вскрытие считается
     отдельно от победы: дойти до вскрытия шесть раз и выиграть один — это про игрока больше,
     чем любая другая пара чисел в этой таблице.
    */
    for (var seat : seats) {
      var player = known(seat.memberId);
      if (player == null || !seat.inHand) continue;
      if (result.showdown && seat.live()) {
        player.showdowns++;
        if (seat.wonAmount > 0) player.showdownWins++;
      }
      if (seat.wonAmount > 0) {
        player.streak++;
        player.bestStreak = Math.max(player.bestStreak, player.streak);
      } else player.streak = 0;
      player.peakStack = Math.max(player.peakStack, seat.stack);
      player.stack = seat.stack;
    }
    actor = -1;
    phase = "showdown";
    /*
     Сколько держать итог раздачи на столе.

     Автомат отмеряет своё и едет дальше — это его работа: семь секунд на вскрытие, две с
     половиной там, где вскрывать нечего. В ручном режиме ждут ведущего, и ждут **всегда**, а
     не только на вскрытии: банк, взятый без карт, — это ровно тот случай, когда победителя
     просят показать, что у него было, и двух секунд на это не хватает никому. Три минуты —
     страховка от ведущего, который ушёл; она ничего не раздаёт, а только прибирает стол.
    */
    deadline = now + (autoDeal ? (result.showdown ? SHOWDOWN_MS : QUICK_MS) : REVIEW_MS);
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
    var player = known(seat.memberId);
    if (player != null) {
      // Побочных банков в раздаче бывает несколько, и «выиграл раздачу» — это про раздачу, а не
      // про каждый из них: считается один раз, по первому взятому банку.
      if (seat.wonAmount == amount) player.handsWon++;
      player.won += amount;
      player.biggestPotWon = Math.max(player.biggestPotWon, seat.wonAmount);
      if (hand != null && hand.score() > player.bestHandScore) {
        player.bestHandScore = hand.score();
        player.bestHand = hand.name();
      }
    }
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

  /**
   * Кому записать чужой пустой стек.
   *
   * <p>ПО БАНКУ, А НЕ ПО РАЗМЕРУ ВЫИГРЫША. Последние фишки выбывшего лежат в том банке, до уровня
   * которого он доложил, — забрал их тот, кто этот банк и выиграл. На столе с побочными банками это
   * разные люди: короткий олл-ин уходит одному, а главный банк в той же раздаче — другому, и
   * записывать нокаут тому, кто просто взял больше, значило бы врать о том, что все видели.
   *
   * <p>Ключ карты — уровень банка (сколько нужно было вложить, чтобы на него претендовать), и
   * берётся первый уровень не ниже вложенного выбывшим. Разделённый банк отдаёт нокаут первому из
   * победителей: делить одного выбитого на двоих точнее арифметически и бессмысленнее по сути.
   */
  private void knockouts(NavigableMap<Long, Integer> potWinners) {
    if (result == null || result.busted.isEmpty() || potWinners.isEmpty()) return;
    for (int index : result.busted) {
      var loser = seats.get(index);
      var level = potWinners.ceilingEntry(loser.committed);
      if (level == null) level = potWinners.lastEntry();
      int winner = level.getValue();
      if (winner == index) continue;
      var player = known(seats.get(winner).memberId);
      if (player != null) player.knockouts++;
    }
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
      if (seat.taken() && seat.inHand && seat.stack == 0 && !seat.busted && !canRebuyLater(seat))
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
      var player = known(seat.memberId);
      if (player != null) {
        player.place = seat.place;
        player.stack = 0;
      }
      note(
          now,
          "bust",
          seats.indexOf(seat),
          seat.name,
          0,
          seat.name + " выбывает · " + seat.place + " место");
    }
    for (var seat : seats) if (seat.taken() && seat.leaving) free(seat);
    /*
     Игра кончилась, когда фишки остались у одного и вернуться больше некому.

     Второе условие важнее первого: пока у кого-то есть неиспользованный додеп, за столом ещё
     есть игрок — он просто думает, брать ли фишки заново. Объявить победителя в этот момент
     значило бы закончить игру за того, кого не спросили.
    */
    if (seats.stream().filter(seat -> seat.taken() && seat.stack > 0).count() == 1
        && seats.stream().noneMatch(this::canRebuyLater)) {
      var winner =
          seats.stream().filter(seat -> seat.taken() && seat.stack > 0).findFirst().orElseThrow();
      winner.place = 1;
      var champion = known(winner.memberId);
      if (champion != null) {
        champion.place = 1;
        champion.stack = winner.stack;
      }
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
    if (paused || deadline == 0 || now < deadline) return false;
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
          miss(seat, actor, now);
        }
      }
      default -> deadline = 0;
    }
    return true;
  }

  /**
   * Ход, которого не сделали.
   *
   * <p>Первый пропуск — обычное дело: отвлёкся, не успел. Второй подряд означает, что за столом
   * сидит пустой стул, и остальные ждут его по тридцать секунд каждый круг. Место освобождается в
   * конце раздачи, фишки остаются человеку — он может сесть снова.
   */
  private void miss(Seat seat, int index, long now) {
    seat.misses++;
    apply(seat, index, seat.bet >= betToCall ? "check" : "fold", 0, now, true);
    if (seat.misses >= 2 && !seat.leaving) {
      seat.leaving = true;
      note(now, "stand", index, seat.name, 0, seat.name + " не отвечает и уходит в наблюдатели");
    }
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
    if (paused) {
      // На паузе за отсутствующих не ходят: замерло — значит замерло.
      for (var seat : seats)
        if (seat.taken() && !present.contains(seat.memberId) && !seat.away) {
          seat.away = true;
          seat.awaySince = now;
          changed = true;
        }
      if (changed) revision++;
      return changed;
    }
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
        miss(seat, actor, now);
        changed = true;
      }
    }
    if (changed) revision++;
    return changed;
  }

  /**
   * Пуст ли стол прямо сейчас.
   *
   * <p>Три условия, и все три обязательны: никакая раздача не идёт, и ни за одним занятым местом
   * нет человека, который во встрече. Пустой стол — это и «все встали», и «все закрыли вкладку», и
   * «стол принесли, но никто так и не сел».
   */
  public boolean deserted() {
    if (playing()) return false;
    for (var seat : seats) if (seat.taken() && !seat.away) return false;
    return true;
  }

  /**
   * Пора ли заканчивать игру.
   *
   * <p>ЗДЕСЬ ОДНО УСЛОВИЕ, И ЭТО НАМЕРЕННО. Случайно завершённая игра — это чужие стеки, которых
   * уже не вернуть, поэтому срок идёт только пока стол по-настоящему пуст ({@link #deserted()}) и
   * сбрасывается в ноль в тот же миг, как за столом кто-то появился. Ни пауза, ни «отошёл» сами по
   * себе игру не заканчивают: за ними стоит человек, который вернётся.
   *
   * <p>ПАУЗА ИГРУ НЕ ЗАКАНЧИВАЕТ ВОВСЕ. Пауза посреди раздачи оставляет её незаконченной, а
   * незаконченная раздача — это не пустой стол, сколько бы времени ни прошло. Так и задумано:
   * человек, нажавший паузу, сказал «замрите», а не «разберите стол».
   *
   * <p>Считается это на замке комнаты и по часам сервера — там же, где двигаются все остальные
   * сроки стола. Два перевода часов срок не поджигают: назад — потому что начало простоя берётся
   * заново, вперёд через перезапуск ядра — потому что {@code since} (момент, с которого сервер
   * снова работает) отсекает простой, случившийся, пока вернуться было некуда. Десять минут
   * отсчитываются от времени, в которое человек и правда мог сесть за стол.
   *
   * @param since момент, раньше которого простой не считается: запуск этого экземпляра ядра
   */
  public boolean linger(long now, long since) {
    if (!deserted()) {
      if (idleSince != 0) {
        idleSince = 0;
        revision++;
      }
      return false;
    }
    if (idleSince == 0 || idleSince > now || idleSince < since) {
      idleSince = now;
      revision++;
      return false;
    }
    return now - idleSince >= LINGER_MS;
  }

  /**
   * Ждёт ли стол ведущего.
   *
   * <p>Вскрытие в ручном режиме никуда не уходит само: карты лежат, пока их не уберут. Это
   * отдельное состояние стола, и спрашивать о нём должен стол, а не браузер по фазе и настройке —
   * иначе кнопка «Продолжить» показывалась бы и в автоматическом режиме, где она наперегонки с
   * семисекундным сроком.
   */
  public boolean awaiting() {
    return "showdown".equals(phase) && !autoDeal;
  }

  /** Когда стол закроется сам, или 0 — пока за ним кто-то есть. */
  public long closesAt() {
    return idleSince == 0 ? 0 : idleSince + LINGER_MS;
  }

  /** Переименовать и перепривязать место: вернувшийся во встречу получает новый идентификатор. */
  public boolean rebind(String previousId, String memberId, String name) {
    var seat = seatOf(previousId);
    if (seat == null) return false;
    /*
     Статистика идёт за человеком, а не за идентификатором.

     Переподключившийся получает новый идентификатор, и без этого переноса вторая половина его
     игры записалась бы на постороннего. Запись переезжает целиком и безусловно: новый
     идентификатор выдаётся свежим на каждый вход, и та память, что связана с местом, — это
     ровно то, что человек за этим местом и наиграл.
    */
    var player = tally.remove(previousId);
    if (player != null) {
      if (name != null && !name.isBlank()) player.name = name;
      tally.put(memberId, player);
    }
    seat.memberId = memberId;
    seat.name = name;
    seat.away = false;
    seat.awaySince = 0;
    idleSince = 0;
    revision++;
    return true;
  }

  public void host(String memberId) {
    hostId = memberId;
    revision++;
  }

  /** Настройки стола: посадка, автоматическая раздача, пауза, правила додепа. */
  public void configure(String option, long now) {
    configure(option, null, now);
  }

  /** То же, но для настроек, у которых есть число: например, сколько додепов разрешено. */
  public void configure(String option, Long value, long now) {
    switch (option) {
      case "seating-open" -> {
        seatingOpen = true;
        note(now, "settings", -1, "", 0, "Посадка открыта");
      }
      case "seating-locked" -> {
        seatingOpen = false;
        note(now, "settings", -1, "", 0, "Посадка закрыта до конца игры");
      }
      /*
       Пауза останавливает стол, а не «следующую раздачу».

       Сначала она означала «доиграем и встанем», и это выглядело поломкой: на паузе шли часы
       хода и работали кнопки. Человек, нажимающий паузу, имеет в виду ровно одно — замереть,
       — и теперь так и происходит: часы останавливаются там, где стояли, ходить нельзя, за
       отсутствующих никто не ходит. Продолжение возвращает ровно тот остаток времени, который
       был: пауза не должна ни дарить секунды, ни отнимать их.
      */
      case "pause" -> {
        paused = true;
        if (deadline > 0) {
          pausedRemaining = Math.max(0, deadline - now);
          pausedElapsed = Math.max(0, now - actionAt);
        }
        deadline = 0;
        note(now, "settings", -1, "", 0, "Пауза");
      }
      case "resume" -> {
        paused = false;
        if (playing() && actor >= 0 && pausedRemaining > 0) {
          actionAt = now - pausedElapsed;
          deadline = now + pausedRemaining;
        } else if (playing() && pausedRemaining > 0) deadline = now + pausedRemaining;
        else if ("lobby".equals(phase) && readyCount() >= 2) deadline = now + NEXT_HAND_MS;
        pausedRemaining = 0;
        pausedElapsed = 0;
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
      /*
       Правила додепа — решение ведущего стола, а не свойство режима.

       Их задают заранее, при открытии, и меняют по ходу: «по три додепа на человека» или «без
       ограничений», и сколько фишек даёт один. Ноль означает «докупаться нельзя»: это законный
       ответ, а не отсутствие настройки, поэтому он и передаётся числом.
      */
      case "rebuy-limit" -> {
        rebuys = value == null ? -1 : (int) Math.max(-1, Math.min(9, value));
        note(
            now,
            "settings",
            -1,
            "",
            0,
            rebuys < 0
                ? "Додепы без ограничений"
                : rebuys == 0 ? "Додепы запрещены" : "Додепов на человека: " + rebuys);
      }
      case "rebuy-size" -> {
        rebuyChips =
            value == null ? startingStack : Math.max(MIN_STACK, Math.min(MAX_STACK, value));
        note(now, "settings", -1, "", 0, "Додеп даёт " + rebuyChips + " фишек");
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
              seat.revealed,
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
        rebuyLimit() != 0,
        rebuyLimit(),
        rebuySize(),
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
        revealedSeed == null ? "" : revealedSeed,
        awaiting(),
        closesAt(),
        // Итоги считаются только для законченной игры: считать их на каждый снимок посреди
        // раздачи значило бы присылать таблицу из десяти строк на каждое чужое повышение.
        // Время конца берётся у последней раздачи, а не у часов: иначе снимок отличался бы от
        // снимка одним лишь «сколько шла игра», и длительность в открытых итогах росла бы сама.
        "over".equals(phase)
            ? Standings.of(this, "winner", result == null ? now : result.at)
            : null,
        List.copyOf(visualEvents));
  }

  private void visual(
      long at, String type, Integer from, Integer to, int count, List<String> cards) {
    if (count == 0) return;
    long timestamp = visualEvents.isEmpty() ? at : Math.max(at, visualEvents.getLast().at());
    visualEvents.add(
        new GameVisualEvent(++visualSequence, timestamp, type, from, to, count, cards));
    while (visualEvents.size() > 128) visualEvents.removeFirst();
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
    // На паузе ходить нельзя никому: кнопки не показываются, часы стоят.
    boolean turn = playing() && actor == index && !paused;
    return new TableView.YouView(
        index,
        Cards.texts(seat.cards),
        ownHand(seat),
        turn ? actions(seat) : List.of(),
        Math.min(seat.stack, Math.max(0, betToCall - seat.bet)),
        Math.min(seat.bet + seat.stack, betToCall == 0 ? bigBlind : betToCall + lastRaise),
        seat.bet + seat.stack,
        seat.timeBankMs,
        turn,
        canRebuy(seat) ? rebuySize() : 0,
        rebuysLeft(seat.memberId));
  }

  /**
   * Что у этого человека собралось прямо сейчас.
   *
   * <p>Считается по его собственным картам и общему борду — то есть не раскрывает ничего, чего он и
   * так не видит. Нужно это ровно там, где человек иначе складывает две карты с пятью в уме на
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
