package dev.mikki.stream.game;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import dev.mikki.stream.shared.Problem;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Дурак во встрече: правила целиком.
 *
 * <p>ПОЧЕМУ ОТДЕЛЬНЫЙ КЛАСС, А НЕ РОДСТВЕННИК {@link Table}. Общего у покера и дурака только
 * колода. В покере ходят фишками и кругами ставок, здесь — картами и боями; там выигрывает
 * сильнейшая рука, здесь проигрывает последний оставшийся. Наследование связало бы две игры
 * названиями полей и ничем больше.
 *
 * <p>ТРИДЦАТЬ ШЕСТЬ КАРТ — ЭТО ПОДМНОЖЕСТВО ПЯТИДЕСЯТИ ДВУХ. Карта здесь то же число, что и в
 * покере ({@link Cards}): {@code rank = card / 4}, {@code suit = card % 4}. Колода на 36 — это
 * карты от шестёрки и выше, и больше ничего не меняется: ни сравнение номиналов, ни запись в
 * провод, ни тасовка.
 *
 * <p>ЧЕСТНОСТЬ ПРОВЕРЯЕМА ТАК ЖЕ, КАК В ПОКЕРЕ. До раздачи стол объявляет отпечаток зерна ({@code
 * commitment}), после партии раскрывает само зерно. Кто угодно повторит тасовку и убедится, что
 * карты легли именно так. Ни колода, ни зерно до конца партии из ядра не выходят.
 *
 * <p>Состояние лежит в снимке комнаты, как и покерный стол: своего хранилища у игры нет, и
 * переживает она перезапуск ядра, но не саму встречу.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class Durak {

  /** Мест за столом. Шесть — предел самой игры: седьмому не хватит карт в колоде на 36. */
  public static final int SEATS = 6;

  /** До скольких карт добирают после боя. */
  public static final int HAND = 6;

  /** Предел боя: больше шести карт не подкидывают, сколько бы их ни было на руках. */
  public static final int MAX_ATTACKS = 6;

  /** Тот же предел для первого боя партии, когда включена такая настройка. */
  public static final int FIRST_ATTACKS = 5;

  /** Сколько длится полёт карт при раздаче. То же число знает браузер. */
  public static final long DEAL_MS = 1400;

  /** Сколько закончившийся бой ещё лежит на столе, прежде чем уехать в отбой или в руку. */
  public static final long BOUT_MS = 1300;

  /** Сколько стол стоит пустым, прежде чем уйти со сцены. Столько же у покера. */
  public static final long LINGER_MS = 600000;

  /** Сколько ждём хода от того, кого во встрече уже нет. */
  public static final long AWAY_ACT_MS = 3000;

  /** Сколько ждём его самого, прежде чем освободить место. */
  public static final long AWAY_STAND_MS = LINGER_MS;

  /** Границы раздумья: меньше пятнадцати секунд — не игра, больше двух минут — не встреча. */
  public static final int MIN_TURN = 15;

  public static final int MAX_TURN = 120;

  private static final int LOG_LIMIT = 30;

  /** Сколько карт бывает в колоде. Джокеров нет ни в одной. */
  public static final List<Integer> DECKS = List.of(36, 52);

  // --- Состояние --------------------------------------------------------------------------

  public String gameId;

  /** {@code podkidnoy} — отбиться или взять; {@code perevodnoy} — ещё и перевести. */
  public String mode = "podkidnoy";

  public String hostId;

  /** {@code lobby} — стол стоит, {@code bout} — идёт партия, {@code over} — дурак найден. */
  public String phase = "lobby";

  public long openedAt;
  public long revision;

  /** 36 или 52. Меняется только между партиями. */
  public int deckSize = 36;

  public int turnSeconds = 40;

  /**
   * Подкидывают только соседи защитника.
   *
   * <p>Вариант для пяти-шести человек: за большим столом «подкидывает кто хочет» превращает бой в
   * свалку, из которой защитнику не выбраться. Слева и справа — те, кого он и видит.
   */
  public boolean neighbours;

  /** Первый бой партии — не больше пяти карт. Распространённая домашняя поблажка заходящему. */
  public boolean firstFive;

  public boolean seatingOpen = true;

  /** Сколько партий сыграли за этим столом. */
  public int handNumber;

  public List<Seat> seats = new ArrayList<>();

  /** Остаток колоды. Первая карта списка — верхняя, последняя — козырная. */
  public List<Integer> deck = new ArrayList<>();

  /** Козырная карта: та, что лежит под колодой лицом вверх. Она же раздаётся последней. */
  public int trump = -1;

  public int trumpSuit = -1;

  /** Сколько карт ушло в отбой. Сами карты не хранятся: доставать их оттуда некому. */
  public int discarded;

  public String seed;
  public String commitment;
  public String revealedSeed;

  /** Главный атакующий — тот, кто заходит. */
  public int attacker = -1;

  public int defender = -1;

  /** Карты атаки в том порядке, в каком их положили. */
  public List<Integer> attacks = new ArrayList<>();

  /** Чем побита каждая атака; {@code -1} — ещё не побита. Список идёт рядом с {@link #attacks}. */
  public List<Integer> beats = new ArrayList<>();

  /** Сколько карт всего можно положить в этот бой. Считается на его начале и не меняется. */
  public int limit;

  /** Который это бой в партии: по нему работает поблажка первого боя. */
  public int boutNumber;

  /** Защитник сказал «беру». Карты уже его, но подкинуть ещё можно. */
  public boolean taking;

  /** Кто сказал «бито» и в этот бой больше не подкидывает. */
  public List<Integer> passed = new ArrayList<>();

  /** Чем кончился бой, который ещё лежит на столе, или null. */
  public String boutEnd;

  public long boutAt;

  /** Когда началось текущее ожидание: от него идёт кольцо хода. */
  public long actionAt;

  /** Когда ожидание кончится само. Этот же срок ставится в {@code GameClock}. */
  public long deadline;

  /** Когда начали раздавать: от этой метки браузер считает полёт карт. */
  public long dealtAt;

  public List<Note> log = new ArrayList<>();

  /** Кто и как играл за этим столом, ключ — идентификатор человека. */
  public Map<String, Player> tally = new LinkedHashMap<>();

  /**
   * Записана ли сыгранная партия в историю беседы.
   *
   * <p>Отметка стоит на самом столе, поэтому второй проход уборки ничего не дублирует. Сбрасывается
   * раздачей: следующая партия — это следующая запись.
   */
  public boolean archived;

  /** Когда партия началась: в записи истории это её начало. */
  public long handStartedAt;

  public Result result;

  /** С какого момента за столом никого. Ноль — есть кто-то. */
  public long idleSince;

  @JsonIgnoreProperties(ignoreUnknown = true)
  public static class Seat {
    public String memberId;
    public String name;

    /** Рука. Наружу уходит только своя. */
    public List<Integer> hand = new ArrayList<>();

    /** Вышел из партии: карты кончились, а колода уже пуста. */
    public boolean out;

    /** Каким по счёту вышел, или 0 — ещё играет. */
    public int place;

    /** Тот самый. Ставится, когда партия кончилась. */
    public boolean fool;

    /** Сел посреди партии и ждёт следующей раздачи. */
    public boolean waiting;

    public boolean away;
    public long awaySince;

    public boolean taken() {
      return memberId != null;
    }

    /** Участвует в идущей партии. */
    public boolean playing() {
      return taken() && !waiting && !out;
    }
  }

  @JsonIgnoreProperties(ignoreUnknown = true)
  public static class Note {
    public long at;
    public String kind = "";
    public int seat = -1;
    public String name = "";
    public String text = "";
  }

  /**
   * Память об игроке за всё время, пока стоит стол.
   *
   * <p>КЛЮЧ ЗДЕСЬ — ЧЕЛОВЕК, А НЕ МЕСТО. Он мог встать, сесть на другой стул и вернуться после
   * переподключения с новым идентификатором — все три раза это один и тот же игрок, и счёт «сколько
   * раз был дураком» обязан ехать за ним (см. {@link #rebind}).
   *
   * <p>Копится это по ходу партий, а не собирается в конце: в конце партии нет ни карт, ни половины
   * сидевших.
   */
  @JsonIgnoreProperties(ignoreUnknown = true)
  public static class Player {
    public String name = "";
    public int games;

    /** Сколько раз оказался дураком. Это и есть счёт беседы. */
    public int fools;

    /** Сколько раз вышел из партии первым. */
    public int firsts;

    /** Сколько раз брал карты. */
    public int takes;

    /** Сколько боёв отбил целиком, ни разу не взяв. */
    public int defences;

    /** Сколько карт подкинул за все партии. */
    public int thrown;

    /** Сколько козырей потратил на защиту: этим и меряется «отбивался дорого». */
    public int trumpsBurned;

    /** Сколько раз перевёл бой на соседа. */
    public int transfers;

    /** Сколько партий подряд не был дураком — сейчас и лучшая за игру. */
    public int streak;

    public int bestStreak;
  }

  @JsonIgnoreProperties(ignoreUnknown = true)
  public static class Result {
    public long at;
    public int foolSeat = -1;
    public String foolName = "";

    /** Последний бой опустошил руки всем разом: проигравшего нет. */
    public boolean draw;

    public int bouts;

    /** Кто вышел и в каком порядке — от первого до дурака. */
    public List<String> places = new ArrayList<>();
  }

  // --- Стол -------------------------------------------------------------------------------

  /** Новый стол в комнате: места пустые, раздавать нечего, все решения впереди. */
  public static Durak open(String hostId, String modeId, long now, int deckSize) {
    var table = new Durak();
    table.gameId = java.util.UUID.randomUUID().toString();
    table.mode = "perevodnoy".equals(modeId) ? "perevodnoy" : "podkidnoy";
    table.hostId = hostId;
    table.openedAt = now;
    table.revision = 1;
    table.deckSize = DECKS.contains(deckSize) ? deckSize : 36;
    for (int index = 0; index < SEATS; index++) table.seats.add(new Seat());
    table.note(now, "open", -1, "", "Стол дурака открыт");
    return table;
  }

  public String modeName() {
    return "perevodnoy".equals(mode) ? "Переводной" : "Подкидной";
  }

  public boolean transferAllowed() {
    return "perevodnoy".equals(mode);
  }

  /** Идёт ли партия прямо сейчас. */
  public boolean playing() {
    return "bout".equals(phase);
  }

  // --- Места ------------------------------------------------------------------------------

  /** Сесть на свободное место. Посреди партии это место в следующей раздаче. */
  public void sit(String memberId, String name, int index, long now) {
    if (index < 0 || index >= SEATS)
      throw new Problem(400, "DURAK_SEAT", "Такого места за столом нет");
    if (seatOf(memberId) != null) throw Problem.conflict("DURAK_SEATED", "Вы уже за столом");
    if (!seatingOpen) throw Problem.conflict("DURAK_CLOSED", "Ведущий закрыл посадку");
    var seat = seats.get(index);
    if (seat.taken()) throw Problem.conflict("DURAK_TAKEN", "Место уже занято");
    seat.memberId = memberId;
    seat.name = name;
    seat.hand = new ArrayList<>();
    seat.out = false;
    seat.place = 0;
    seat.fool = false;
    // Партию не пересдают ради опоздавшего: он смотрит бой и играет со следующей раздачи.
    seat.waiting = playing();
    player(memberId, name);
    idleSince = 0;
    note(now, "sit", index, name, name + " садится за стол");
    revision++;
  }

  /**
   * Встать из-за стола.
   *
   * <p>Карты ушедшего уходят в отбой сразу же: ждать хода от того, кого нет, значит остановить
   * партию на пустом стуле. Если он был в бою, роли переезжают на соседей, а бой продолжается — за
   * столом в этот момент ещё есть кому играть.
   */
  public void stand(String memberId, long now) {
    var seat = seatOf(memberId);
    if (seat == null) return;
    int index = seats.indexOf(seat);
    boolean inGame = playing() && seat.playing();
    note(now, "stand", index, seat.name, seat.name + " выходит из игры");
    if (inGame) {
      discarded += seat.hand.size();
      seat.hand.clear();
      seat.out = true;
    }
    seats.set(index, new Seat());
    revision++;
    if (inGame) regroup(now);
  }

  /** Освободить место и пересобрать бой, если игравших стало меньше. */
  private void regroup(long now) {
    if (!playing()) return;
    var alive = stillIn(-1);
    if (alive.size() <= 1) {
      // Играть больше не с кем. Проигравшего в такой партии нет: он не проиграл, за ним просто
      // перестали сидеть. Стол возвращается к ожиданию раздачи.
      note(now, "abort", -1, "", "Игроков не осталось — партия прервана");
      phase = "lobby";
      clearBout();
      revealedSeed = seed;
      deadline = 0;
      revision++;
      return;
    }
    if (!seats.get(defender).playing() || !seats.get(attacker).playing()) {
      // Ушёл кто-то из двоих, вокруг кого шёл бой. Бой в таком виде не доигрывается: карты со
      // стола уходят в отбой, и следующий заходит с чистого сукна.
      discarded += attacks.size() + (int) beats.stream().filter(card -> card >= 0).count();
      if (seats.get(defender).playing()) {
        // Защитник на месте — заходит он: карты, которые под него положили, он не брал.
        attacker = defender;
      } else {
        attacker = nextPlaying(defender);
      }
      clearBout();
      refill();
      if (finish(now)) return;
      attacker = alive(attacker);
      defender = nextPlaying(attacker);
      startBout(now);
      return;
    }
    passed.removeIf(index -> !seats.get(index).playing());
    reschedule(now);
  }

  /** Память об этом человеке: заводится, когда он садится, и живёт, пока стоит стол. */
  private Player player(String memberId, String name) {
    var player = tally.computeIfAbsent(memberId, key -> new Player());
    if (name != null && !name.isBlank()) player.name = name;
    return player;
  }

  /** То же, но только если человек и правда играл за этим столом. */
  private Player known(String memberId) {
    return memberId == null ? null : tally.get(memberId);
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

  /** Переименовать и перепривязать место: вернувшийся во встречу получает новый идентификатор. */
  public boolean rebind(String previousId, String memberId, String name) {
    var seat = seatOf(previousId);
    if (seat == null) return false;
    /*
     Счёт идёт за человеком, а не за идентификатором: переподключившийся получает новый, и без
     этого переноса вторая половина вечера записалась бы на постороннего.
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

  // --- Настройки --------------------------------------------------------------------------

  /**
   * Что ведущий может поменять у стола.
   *
   * <p>Колода и правила перевода меняются только между партиями: сдвинуть их посреди боя значит
   * поменять карты, которые уже на руках. Остальное — в любой момент.
   */
  public void configure(String option, Long value, long now) {
    switch (option == null ? "" : option) {
      case "deck" -> {
        requireIdle();
        int wanted = value == null ? 36 : value.intValue();
        if (!DECKS.contains(wanted))
          throw new Problem(400, "DURAK_DECK", "Колода бывает на 36 или 52 карты");
        deckSize = wanted;
        note(now, "settings", -1, "", "Колода: " + wanted + " карт");
      }
      case "rules" -> {
        requireIdle();
        mode = value != null && value == 1 ? "perevodnoy" : "podkidnoy";
        note(now, "settings", -1, "", modeName() + " дурак");
      }
      case "neighbours" -> {
        neighbours = !neighbours;
        note(now, "settings", -1, "", neighbours ? "Подкидывают только соседи" : "Подкидывают все");
      }
      case "first-five" -> {
        firstFive = !firstFive;
        note(now, "settings", -1, "", firstFive ? "Первый бой — пять карт" : "Первый бой — шесть");
      }
      case "turn" -> {
        int wanted = value == null ? 40 : value.intValue();
        turnSeconds = Math.max(MIN_TURN, Math.min(MAX_TURN, wanted));
        note(now, "settings", -1, "", turnSeconds + " секунд на ход");
        reschedule(now);
      }
      case "seating" -> {
        seatingOpen = !seatingOpen;
        note(now, "settings", -1, "", seatingOpen ? "Посадка открыта" : "Посадка закрыта");
      }
      default -> throw new Problem(400, "DURAK_SETTING", "Неизвестная настройка стола");
    }
    revision++;
  }

  private void requireIdle() {
    if (playing()) throw Problem.conflict("DURAK_IN_HAND", "Это меняют между партиями");
  }

  // --- Раздача ----------------------------------------------------------------------------

  /**
   * Раздать партию.
   *
   * <p>ПОРЯДОК РАЗДАЧИ ЗАФИКСИРОВАН, И ЭТО ЧАСТЬ ПРОВЕРЯЕМОСТИ. Карты идут по одной по кругу,
   * начиная с первого занятого места: игрок с порядковым номером {@code p} получает карты {@code
   * p}, {@code p + n}, {@code p + 2n} … Повторить это по зерну — десять строк в браузере; раздай мы
   * «по шесть сразу», проверка зависела бы от того, в каком порядке сервер обошёл места.
   *
   * <p>Козырь — последняя карта колоды. Он лежит под ней лицом вверх, виден всем и уходит в игру
   * последним: его вытянет тот, кому не хватит карт в самом конце.
   */
  public void deal(long now) {
    if (playing()) throw Problem.conflict("DURAK_IN_HAND", "Партия уже идёт");
    var players = new ArrayList<Integer>();
    for (int index = 0; index < SEATS; index++) if (seats.get(index).taken()) players.add(index);
    if (players.size() < 2)
      throw Problem.conflict("DURAK_NEED_PLAYERS", "Нужно хотя бы двое за столом");
    if ((long) players.size() * HAND > deckSize)
      throw Problem.conflict("DURAK_SMALL_DECK", "Для стольких игроков нужна колода побольше");
    seed = Cards.seed();
    commitment = Cards.commitment(seed);
    revealedSeed = null;
    var shuffled = new ArrayList<>(Cards.shuffle(seed, Cards.deck(deckSize)));
    for (int index = 0; index < SEATS; index++) {
      var seat = seats.get(index);
      seat.hand = new ArrayList<>();
      seat.out = !seat.taken();
      seat.place = 0;
      seat.fool = false;
      seat.waiting = false;
    }
    /*
     Козырь — нижняя карта колоды, и объявляется он до раздачи, а не после.

     Разница видна ровно в одном случае, зато он законный: шестеро на колоде в тридцать шесть
     карт разбирают её целиком, и «последняя оставшаяся» карта — это карта, уже уехавшая кому-то
     в руку. За настоящим столом так и бывает: козырь показали, он ушёл шестому, и все об этом
     знают. Считай мы козырь остатком колоды, такая раздача падала бы на пустом списке.
    */
    trump = shuffled.get(shuffled.size() - 1);
    trumpSuit = Cards.suit(trump);
    int people = players.size();
    for (int card = 0; card < HAND; card++)
      for (int place = 0; place < people; place++)
        seats.get(players.get(place)).hand.add(shuffled.get(place + card * people));
    deck = new ArrayList<>(shuffled.subList(people * HAND, shuffled.size()));
    for (var index : players) sortHand(seats.get(index));
    discarded = 0;
    handNumber++;
    archived = false;
    handStartedAt = now;
    for (var index : players) {
      var seat = seats.get(index);
      player(seat.memberId, seat.name).games++;
    }
    boutNumber = 0;
    result = null;
    phase = "bout";
    dealtAt = now;
    attacker = opener(players);
    defender = nextPlaying(attacker);
    note(now, "deal", -1, "", "Раздача " + handNumber);
    startBout(now + DEAL_MS);
    revision++;
  }

  /**
   * Кто заходит первым.
   *
   * <p>Младший козырь — правило, о котором за столом и спрашивают: «у кого шестёрка?». Козырей не
   * оказалось ни у кого (бывает и в колоде на 52) — заходит младшая карта; поровну и это — первое
   * занятое место, чтобы раздача не зависла на монетке.
   */
  private int opener(List<Integer> players) {
    int best = -1;
    int bestCard = Integer.MAX_VALUE;
    for (var index : players)
      for (var card : seats.get(index).hand)
        if (Cards.suit(card) == trumpSuit && card < bestCard) {
          bestCard = card;
          best = index;
        }
    if (best >= 0) return best;
    for (var index : players)
      for (var card : seats.get(index).hand)
        if (Cards.rank(card) * 4 < bestCard) {
          bestCard = Cards.rank(card) * 4;
          best = index;
        }
    return best >= 0 ? best : players.get(0);
  }

  /** Карты в руке: по мастям, козыри последними — так их и держат. */
  private void sortHand(Seat seat) {
    seat.hand.sort(
        Comparator.<Integer, Integer>comparing(card -> Cards.suit(card) == trumpSuit ? 1 : 0)
            .thenComparing(Cards::suit)
            .thenComparing(Cards::rank));
  }

  // --- Бой --------------------------------------------------------------------------------

  private void startBout(long at) {
    clearBout();
    boutNumber++;
    int cap = firstFive && boutNumber == 1 ? FIRST_ATTACKS : MAX_ATTACKS;
    limit = Math.min(cap, seats.get(defender).hand.size());
    actionAt = at;
    deadline = at + turnSeconds * 1000L;
    revision++;
  }

  private void clearBout() {
    attacks = new ArrayList<>();
    beats = new ArrayList<>();
    passed = new ArrayList<>();
    taking = false;
    boutEnd = null;
    boutAt = 0;
  }

  /**
   * Ход.
   *
   * @param option {@code attack}, {@code beat}, {@code take}, {@code pass} или {@code transfer}
   * @param card чем ходим, в записи провода ({@code As}); для {@code take} и {@code pass} не нужна
   * @param under какую карту бьём; только для {@code beat}
   */
  public void act(String memberId, String option, String card, String under, long now) {
    int index = indexOf(memberId);
    if (index < 0) throw Problem.forbidden();
    if (!playing()) throw Problem.conflict("DURAK_IDLE", "Партия не идёт");
    if (boutEnd != null) throw Problem.conflict("DURAK_BOUT_OVER", "Бой уже закончился");
    if (!seats.get(index).playing()) throw Problem.conflict("DURAK_WAITING", "Вы не в этой партии");
    if (now < dealtAt + DEAL_MS) now = dealtAt + DEAL_MS;
    switch (option == null ? "" : option) {
      case "attack" -> attack(index, card(card), now);
      case "beat" -> beat(index, card(card), card(under), now);
      case "take" -> take(index, now);
      case "pass" -> pass(index, now);
      case "transfer" -> transfer(index, card(card), now);
      default -> throw new Problem(400, "DURAK_ACTION", "Так не ходят");
    }
    revision++;
  }

  private static int card(String text) {
    if (text == null || text.isBlank()) throw new Problem(400, "DURAK_CARD", "Не выбрана карта");
    for (int card = 0; card < Cards.DECK; card++) if (Cards.text(card).equals(text)) return card;
    throw new Problem(400, "DURAK_CARD", "Такой карты не бывает");
  }

  private void attack(int index, int card, long now) {
    if (index == defender) throw Problem.conflict("DURAK_DEFENDER", "Вы отбиваетесь");
    if (attacks.isEmpty() && index != attacker)
      throw Problem.conflict("DURAK_TURN", "Заходит тот, чей ход");
    if (!attacks.isEmpty() && !mayThrow(index))
      throw Problem.conflict("DURAK_TURN", "Подкидывать могут только соседи защитника");
    if (attacks.size() >= limit)
      throw Problem.conflict("DURAK_LIMIT", "Больше в этот бой не подкинуть");
    var seat = seats.get(index);
    if (!seat.hand.contains(card)) throw Problem.forbidden();
    if (!attacks.isEmpty() && !ranksOnTable().contains(Cards.rank(card)))
      throw Problem.conflict("DURAK_RANK", "Такого номинала на столе нет");
    seat.hand.remove((Integer) card);
    attacks.add(card);
    beats.add(-1);
    // Подкинутая карта снова открывает бой для всех: спасовавший мог придержать вторую такую же.
    passed.clear();
    if (attacks.size() > 1) player(seat.memberId, seat.name).thrown++;
    /*
      В ленте — кто и что сделал, а не какой картой.

      Карты лежат на столе перед глазами: повторять их в ленте значит писать «8h» рядом с
      нарисованной восьмёркой червей. Лента отвечает на другой вопрос — кто ходил, пока я
      отвернулся.
    */
    note(
        now,
        attacks.size() == 1 ? "attack" : "throw",
        index,
        seat.name,
        seat.name + (attacks.size() == 1 ? " ходит" : " подкидывает"));
    if (seat.hand.isEmpty() && deck.isEmpty()) passed.add(index);
    reschedule(now);
  }

  private void beat(int index, int card, int under, long now) {
    if (index != defender) throw Problem.conflict("DURAK_TURN", "Отбивается не тот");
    if (taking) throw Problem.conflict("DURAK_TAKING", "Вы уже взяли карты");
    int slot = attacks.indexOf(under);
    if (slot < 0 || beats.get(slot) >= 0)
      throw Problem.conflict("DURAK_TARGET", "Эта карта не ждёт защиты");
    var seat = seats.get(index);
    if (!seat.hand.contains(card)) throw Problem.forbidden();
    if (!beatsCard(card, under))
      throw Problem.conflict("DURAK_WEAK", Cards.text(card) + " не бьёт " + Cards.text(under));
    seat.hand.remove((Integer) card);
    beats.set(slot, card);
    if (Cards.suit(card) == trumpSuit) player(seat.memberId, seat.name).trumpsBurned++;
    note(now, "beat", index, seat.name, seat.name + " отбивается");
    reschedule(now);
  }

  /** Бьёт ли одна карта другую: старшая той же масти или любой козырь по некозырю. */
  public boolean beatsCard(int card, int under) {
    boolean cardTrump = Cards.suit(card) == trumpSuit;
    boolean underTrump = Cards.suit(under) == trumpSuit;
    if (cardTrump && !underTrump) return true;
    if (!cardTrump && underTrump) return false;
    return Cards.suit(card) == Cards.suit(under) && Cards.rank(card) > Cards.rank(under);
  }

  private void take(int index, long now) {
    if (index != defender) throw Problem.conflict("DURAK_TURN", "Берёт тот, кто отбивается");
    if (taking) throw Problem.conflict("DURAK_TAKING", "Вы уже взяли карты");
    if (attacks.isEmpty()) throw Problem.conflict("DURAK_EMPTY", "Брать пока нечего");
    taking = true;
    player(seats.get(index).memberId, seats.get(index).name).takes++;
    // Взял — значит, можно докинуть «вдогонку»: спасовавшие снова в игре.
    passed.clear();
    note(now, "take", index, seats.get(index).name, seats.get(index).name + " берёт");
    reschedule(now);
  }

  private void pass(int index, long now) {
    if (index == defender) throw Problem.conflict("DURAK_DEFENDER", "Вы отбиваетесь");
    if (attacks.isEmpty()) throw Problem.conflict("DURAK_EMPTY", "Сначала надо зайти");
    if (!taking && beats.contains(-1))
      throw Problem.conflict("DURAK_UNBEATEN", "На столе есть неотбитая карта");
    if (!passed.contains(index)) passed.add(index);
    reschedule(now);
  }

  private void transfer(int index, int card, long now) {
    if (!transferAllowed()) throw Problem.conflict("DURAK_NO_TRANSFER", "Этот стол без перевода");
    if (index != defender) throw Problem.conflict("DURAK_TURN", "Переводит тот, кто отбивается");
    if (taking) throw Problem.conflict("DURAK_TAKING", "Вы уже взяли карты");
    if (attacks.isEmpty()) throw Problem.conflict("DURAK_EMPTY", "Переводить пока нечего");
    /*
     Первый кон не переводят.

     Заход в партии один, и он достаётся младшему козырю не просто так: это единственный ход,
     который не выбирают. Перевести его дальше по кругу значит отдать соседу бой, к которому его
     привела чужая шестёрка, — за столом это и не принято.
    */
    if (boutNumber <= 1) throw Problem.conflict("DURAK_FIRST_BOUT", "Первый кон не переводят");
    if (beats.stream().anyMatch(beat -> beat >= 0))
      throw Problem.conflict("DURAK_BEATEN", "Переводят до того, как начали отбиваться");
    /*
     Перевод — это ещё одна карта в бой, и предел боя он не обходит.

     Расхождение, найденное сверкой с чужими движками: у проверенного перевода стоит тот же
     потолок, что у подкидывания. Без него шестикарточный бой можно было продлить переводом.
    */
    if (attacks.size() >= limit)
      throw Problem.conflict("DURAK_LIMIT", "В этот бой больше не положить");
    var seat = seats.get(index);
    if (!seat.hand.contains(card)) throw Problem.forbidden();
    if (Cards.rank(card) != Cards.rank(attacks.get(0)))
      throw Problem.conflict("DURAK_RANK", "Переводят картой того же номинала");
    int next = nextPlaying(index);
    if (next == index) throw Problem.conflict("DURAK_TRANSFER", "Переводить некому");
    if (seats.get(next).hand.size() < attacks.size() + 1)
      throw Problem.conflict("DURAK_TRANSFER", "У следующего не хватит карт, чтобы отбиться");
    seat.hand.remove((Integer) card);
    attacks.add(card);
    beats.add(-1);
    passed.clear();
    player(seat.memberId, seat.name).transfers++;
    attacker = index;
    defender = next;
    int cap = firstFive && boutNumber == 1 ? FIRST_ATTACKS : MAX_ATTACKS;
    limit = Math.min(cap, attacks.size() + seats.get(next).hand.size());
    note(now, "transfer", index, seat.name, seat.name + " переводит на " + seats.get(next).name);
    reschedule(now);
  }

  // --- Кто сейчас ходит ---------------------------------------------------------------------

  /** Номиналы, которые уже лежат на столе: только ими и подкидывают. */
  public Set<Integer> ranksOnTable() {
    var ranks = new LinkedHashSet<Integer>();
    for (var card : attacks) ranks.add(Cards.rank(card));
    for (var card : beats) if (card >= 0) ranks.add(Cards.rank(card));
    return ranks;
  }

  /** Вправе ли это место подкидывать: не защитник, в партии, и сосед — если так настроено. */
  public boolean mayThrow(int index) {
    if (index < 0 || index == defender) return false;
    if (!seats.get(index).playing()) return false;
    if (!neighbours) return true;
    return index == attacker || index == nextPlaying(defender);
  }

  /** Может ли это место положить хоть одну карту в текущий бой. */
  private boolean canThrow(int index) {
    if (!mayThrow(index) || attacks.size() >= limit) return false;
    if (attacks.isEmpty()) return index == attacker;
    var ranks = ranksOnTable();
    return seats.get(index).hand.stream().anyMatch(card -> ranks.contains(Cards.rank(card)));
  }

  /**
   * От кого стол ждёт хода.
   *
   * <p>Пока на столе есть неотбитая карта и защитник не взял — ждут его одного. Иначе ждут всех
   * нападающих разом: подкинуть или сказать «бито». Спасовавшие и те, кому класть нечего, в
   * ожидании не участвуют — иначе бой стоял бы полную минуту ради людей без единой подходящей
   * карты.
   */
  public List<Integer> acting() {
    if (!playing() || boutEnd != null) return List.of();
    if (!taking && !attacks.isEmpty() && beats.contains(-1)) return List.of(defender);
    var waiting = new ArrayList<Integer>();
    for (int index = 0; index < SEATS; index++)
      if (!passed.contains(index) && canThrow(index)) waiting.add(index);
    return waiting;
  }

  /** Пересчитать, кого ждём, и закрыть бой, если ждать больше некого. */
  private void reschedule(long now) {
    if (!playing() || boutEnd != null) return;
    var waiting = acting();
    if (waiting.isEmpty()) {
      closeBout(now);
      return;
    }
    actionAt = now;
    deadline = now + turnSeconds * 1000L;
  }

  /** Бой кончился. Карты ещё полторы секунды лежат на столе — этим и видно, чем он кончился. */
  private void closeBout(long now) {
    boutEnd = taking ? "taken" : "beaten";
    boutAt = now;
    deadline = now + BOUT_MS;
    var seat = seats.get(defender);
    note(
        now,
        boutEnd,
        defender,
        seat.name,
        taking ? seat.name + " забирает " + played() + " карт" : "Бито");
  }

  private int played() {
    return attacks.size() + (int) beats.stream().filter(card -> card >= 0).count();
  }

  /** Разобрать закончившийся бой: карты по местам, добор, выбывшие, следующий заход. */
  private void settleBout(long now) {
    boolean taken = "taken".equals(boutEnd);
    var loser = seats.get(defender);
    if (taken) {
      loser.hand.addAll(attacks);
      for (var card : beats) if (card >= 0) loser.hand.add(card);
      sortHand(loser);
    } else {
      discarded += played();
      // Отбился целиком и ничего не взял — это то, чем в дураке и хвастаются.
      player(loser.memberId, loser.name).defences++;
    }
    int nextAttacker = taken ? nextPlaying(defender) : defender;
    clearBout();
    refill();
    if (finish(now)) return;
    attacker = alive(nextAttacker);
    defender = nextPlaying(attacker);
    if (attacker == defender) {
      finishNow(now);
      return;
    }
    startBout(now);
  }

  /**
   * Добор до шести.
   *
   * <p>Порядок не украшение: колода кончается посреди добора, и кому достанется козырная карта —
   * следствие именно этого порядка. Главный атакующий, потом остальные нападающие по кругу,
   * последним защитник — так за столом и тянут.
   */
  private void refill() {
    var order = new ArrayList<Integer>();
    int at = attacker;
    for (int step = 0; step < SEATS; step++) {
      if (at != defender && seats.get(at).playing() && !order.contains(at)) order.add(at);
      at = next(at);
    }
    if (seats.get(defender).playing()) order.add(defender);
    for (var index : order) {
      var seat = seats.get(index);
      while (seat.hand.size() < HAND && !deck.isEmpty()) seat.hand.add(deck.remove(0));
      sortHand(seat);
    }
  }

  /**
   * Кончилась ли партия.
   *
   * <p>Выбывают все разом, а не по одному: последний бой может опустошить руки сразу двоим, и
   * объявлять одного из них дураком за то, что его место дальше по кругу, — это не правило, а
   * побочный эффект обхода.
   */
  private boolean finish(long now) {
    int gone = (int) seats.stream().filter(seat -> seat.out && seat.place > 0).count();
    for (int index = 0; index < SEATS; index++) {
      var seat = seats.get(index);
      if (!seat.playing() || !seat.hand.isEmpty() || !deck.isEmpty()) continue;
      seat.out = true;
      seat.place = ++gone;
      note(now, "out", index, seat.name, seat.name + " выходит из партии");
    }
    var left = stillIn(-1);
    if (left.size() > 1) return false;
    finishNow(now);
    return true;
  }

  private void finishNow(long now) {
    var left = stillIn(-1);
    result = new Result();
    result.at = now;
    result.bouts = boutNumber;
    result.draw = left.isEmpty();
    if (!left.isEmpty()) {
      int fool = left.get(0);
      var seat = seats.get(fool);
      seat.fool = true;
      result.foolSeat = fool;
      result.foolName = seat.name;
      note(now, "fool", fool, seat.name, seat.name + " — дурак");
    } else {
      note(now, "draw", -1, "", "Ничья: карт не осталось ни у кого");
    }
    result.places =
        seats.stream()
            .filter(seat -> seat.taken() && seat.place > 0)
            .sorted(Comparator.comparingInt(seat -> seat.place))
            .map(seat -> seat.name)
            .toList();
    /*
     Счёт беседы обновляется здесь, а не при записи в историю.

     Историю пишет комната — она же может и не успеть (стол убрали в ту же секунду). А счёт
     «сколько раз кто был дураком» виден на сцене сразу, как только партия кончилась, и
     зависеть от уборки он не должен.
    */
    for (var seat : seats) {
      if (!seat.taken()) continue;
      var player = player(seat.memberId, seat.name);
      if (seat.fool) {
        player.fools++;
        player.streak = 0;
      } else {
        player.streak++;
        player.bestStreak = Math.max(player.bestStreak, player.streak);
      }
      if (seat.place == 1) player.firsts++;
    }
    phase = "over";
    revealedSeed = seed;
    clearBout();
    attacker = -1;
    defender = -1;
    deadline = 0;
    revision++;
  }

  /** Места, которые ещё в партии. {@code skip} исключается, или −1. */
  private List<Integer> stillIn(int skip) {
    var live = new ArrayList<Integer>();
    for (int index = 0; index < SEATS; index++)
      if (index != skip && seats.get(index).playing()) live.add(index);
    return live;
  }

  private int next(int index) {
    return (index + 1) % SEATS;
  }

  /** Следующее по кругу место, которое ещё в партии. Сам {@code from} — последний кандидат. */
  public int nextPlaying(int from) {
    for (int step = 1; step <= SEATS; step++) {
      int at = (from + step) % SEATS;
      if (seats.get(at).playing()) return at;
    }
    return from;
  }

  /** Это место, если оно ещё в партии, иначе следующее за ним. */
  private int alive(int index) {
    return seats.get(index).playing() ? index : nextPlaying(index);
  }

  // --- Сроки ------------------------------------------------------------------------------

  /**
   * Двинуть стол, если его срок настал.
   *
   * <p>Три срока, и все три двигают партию вперёд: полторы секунды на разбор закончившегося боя,
   * время на ход защитника (вышло — он берёт) и то же время нападающим (вышло — «бито»). Раздача
   * при этом не считается сроком: карты летят, но стол уже ждёт первого хода.
   */
  public boolean tick(long now) {
    if (!playing() || deadline == 0 || now < deadline) return false;
    if (boutEnd != null) {
      settleBout(now);
      revision++;
      return true;
    }
    var waiting = acting();
    if (waiting.isEmpty()) {
      closeBout(now);
      revision++;
      return true;
    }
    if (waiting.size() == 1 && waiting.get(0) == defender && !taking) {
      take(defender, now);
    } else {
      for (var index : waiting) if (!passed.contains(index)) passed.add(index);
      reschedule(now);
    }
    revision++;
    return true;
  }

  /**
   * Кого из сидящих во встрече больше нет.
   *
   * <p>За ушедшего стол ходит сам через три секунды: один закрытый браузер иначе держал бы бой всю
   * минуту. Место освобождается только когда партия не идёт — выдёргивать из боя чужие карты значит
   * менять партию тем, кто остался.
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
      if (seat.away && !(playing() && seat.playing()) && now - seat.awaySince > AWAY_STAND_MS) {
        note(now, "stand", seats.indexOf(seat), seat.name, seat.name + " покидает стол");
        seats.set(seats.indexOf(seat), new Seat());
        changed = true;
      }
    }
    if (playing() && boutEnd == null) {
      for (var index : acting()) {
        var seat = seats.get(index);
        if (!seat.away || now - seat.awaySince <= AWAY_ACT_MS) continue;
        if (index == defender && !taking && beats.contains(-1)) take(index, now);
        else if (!passed.contains(index)) {
          passed.add(index);
          reschedule(now);
        }
        changed = true;
      }
    }
    if (changed) revision++;
    return changed;
  }

  /** Совсем ли стол пуст: ни идущей партии, ни присутствующего за занятым местом. */
  private boolean deserted() {
    if (playing()) return false;
    return seats.stream().noneMatch(seat -> seat.taken() && !seat.away);
  }

  /**
   * Пора ли убрать стол со сцены.
   *
   * <p>То же правило и тот же срок, что у покера: десять минут без единого живого человека за
   * столом. {@code since} — момент, раньше которого простой не считается (запуск этого экземпляра
   * ядра): иначе перезапуск после ночи сжёг бы стол в первую же секунду.
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

  public long closesAt() {
    return idleSince == 0 ? 0 : idleSince + LINGER_MS;
  }

  private void note(long at, String kind, int seat, String name, String text) {
    var entry = new Note();
    entry.at = at;
    entry.kind = kind;
    entry.seat = seat;
    entry.name = name == null ? "" : name;
    entry.text = text;
    log.add(entry);
    while (log.size() > LOG_LIMIT) log.remove(0);
  }

  // --- Снимок -----------------------------------------------------------------------------

  /**
   * Стол глазами одного человека. Единственная дверь наружу: колода и чужие руки в неё не лезут.
   */
  public DurakView view(String viewerId, long now) {
    var me = seatOf(viewerId);
    int mine = me == null ? -1 : seats.indexOf(me);
    var board = new ArrayList<DurakView.CardPair>();
    for (int slot = 0; slot < attacks.size(); slot++) {
      int beat = slot < beats.size() ? beats.get(slot) : -1;
      board.add(
          new DurakView.CardPair(
              Cards.text(attacks.get(slot)), beat < 0 ? null : Cards.text(beat)));
    }
    var waiting = acting();
    var places = new ArrayList<DurakView.DurakSeat>();
    for (int index = 0; index < SEATS; index++) {
      var seat = seats.get(index);
      places.add(
          new DurakView.DurakSeat(
              index,
              seat.memberId,
              seat.name,
              seat.hand.size(),
              playing() && index == attacker,
              playing() && index == defender,
              passed.contains(index),
              seat.out && seat.place > 0,
              seat.place,
              seat.away,
              seat.fool));
    }
    var notes =
        log.stream()
            .map(n -> new DurakView.DurakNote(n.at, n.kind, n.seat, n.name, n.text))
            .toList();
    return new DurakView(
        mode,
        modeName(),
        phase,
        hostId,
        deckSize,
        transferAllowed(),
        neighbours,
        firstFive,
        turnSeconds,
        seatingOpen,
        revision,
        handNumber,
        trump < 0 ? null : Cards.text(trump),
        trumpSuit < 0 ? null : String.valueOf(Cards.text(trump).charAt(1)),
        deck.size(),
        discarded,
        attacker,
        defender,
        waiting,
        actionAt,
        deadline,
        taking,
        limit,
        boutEnd,
        boutAt,
        dealtAt,
        board,
        places,
        notes,
        you(mine, waiting),
        score(),
        result(),
        commitment,
        revealedSeed,
        closesAt());
  }

  private DurakView.DurakResult result() {
    if (result == null) return null;
    return new DurakView.DurakResult(
        result.at,
        result.foolSeat,
        result.foolName,
        result.draw,
        result.bouts,
        result.places == null ? List.of() : result.places);
  }

  /**
   * Что этот человек может сделать — вместе с картами, которыми это законно.
   *
   * <p>Здесь и живёт обещание «в браузере нет правил». Список слов отвечает, какие кнопки показать;
   * три списка карт — какие карты поднимутся с руки. Посчитано это одним и тем же кодом, которым
   * ход и проверяется, поэтому «кнопка есть, а ход не проходит» здесь невозможно.
   */
  private DurakView.DurakYou you(int index, List<Integer> waiting) {
    if (index < 0) return null;
    var seat = seats.get(index);
    var cards = seat.hand.stream().map(Cards::text).toList();
    var actions = new ArrayList<String>();
    boolean live = playing() && boutEnd == null && seat.playing();
    /*
     Две кнопки, и обе — про то, чего нельзя сделать картой.

     «Беру» и «Бито» — это отказ ходить, и отказ нажимают. Всё остальное — зайти, подкинуть,
     отбиться, перевести — это движение карты на стол, и кнопки у него нет. Законность самого
     движения сюда не приезжает вовсе: её узнают, положив карту.
    */
    if (live && index != defender && !attacks.isEmpty() && (taking || !beats.contains(-1)))
      if (!passed.contains(index) && mayThrow(index)) actions.add("pass");
    if (live && index == defender && !taking && !attacks.isEmpty()) actions.add("take");
    return new DurakView.DurakYou(index, cards, actions, waiting.contains(index));
  }

  /**
   * Счёт беседы.
   *
   * <p>Сначала те, кто чаще был дураком: за столом спрашивают именно «у кого больше», а не «кто
   * молодец». Люди без единой сыгранной партии в счёт не идут — они ещё не играли.
   */
  private List<DurakView.DurakScore> score() {
    return tally.values().stream()
        .filter(player -> player.games > 0)
        .sorted(
            Comparator.comparingInt((Player player) -> -player.fools)
                .thenComparing(player -> player.name))
        .map(
            player ->
                new DurakView.DurakScore(
                    player.name, player.games, player.fools, player.bestStreak))
        .toList();
  }
}
