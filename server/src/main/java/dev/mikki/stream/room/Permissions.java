package dev.mikki.stream.room;

import dev.mikki.stream.shared.Problem;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * Кто что может во встрече — одной таблицей.
 *
 * <p>РАНЬШЕ ПРАВИЛО ЖИЛО В ЧЕТЫРЁХ МЕСТАХ: здесь, в ядре, — методами {@code owner()}, {@code
 * integrations()}, {@code dealer()}, {@code fool()} и {@code gameHost()}; в службе — своей копией
 * по полям снимка; в Telegram-боте — ещё одной; в браузере — десятком строк {@code self.owner ||
 * integrationsAllowed}. Копии разошлись: убрать музыку служба разрешала только создателю, хотя
 * добавить её мог каждый, кому разрешены интеграции (T14). Теперь правило одно: ядро применяет его
 * к командам и кладёт готовый ответ в снимок участника ({@code you.can}), служба и браузер читают
 * этот ответ по имени действия. Таблица с объяснением каждой клетки — {@code
 * docs/superpowers/specs/2026-10-19-permissions.md}.
 *
 * <p>ДЕЙСТВОВАТЬ МОЖЕТ ТОЛЬКО ЖИВОЙ УЧАСТНИК ОТКРЫТОЙ ВСТРЕЧИ. Ожидающий в дверях, ушедший, бот и
 * кто угодно в закрытой встрече не могут ничего из этой таблицы. Состояние сессии (истёк ли срок
 * восстановления) — не право, а жизненный цикл: его по-прежнему проверяет {@code requireActive} со
 * своим кодом 410, и стоит он перед проверкой права там же, где стоял.
 */
public final class Permissions {
  private Permissions() {}

  /** Роль участника во встрече — то, от чего зависит ответ, кроме флага и столов. */
  public enum Role {
    /** Тот, кто создал встречу: {@code owner}. Право не передаётся. */
    CREATOR,
    /** Допущенный участник, не бот. */
    PARTICIPANT,
    /** Ждёт подтверждения в дверях. */
    WAITING,
    /** Место службы (музыка): им распоряжается служба, сам он не действует. */
    BOT,
    /** Вышел, исключён, сессия истекла — или участника нет вовсе. */
    NONE
  }

  /**
   * Правило клетки. Флаг «интеграции всем» и столы игр берутся из комнаты, роль — из участника.
   *
   * <p>Ведущий игры — не роль встречи, а контекст стола: тот, кто его принёс или унаследовал.
   * Создатель встречи распоряжается любым столом — как запасной выход, если принёсший закрыл
   * вкладку.
   */
  private enum Rule {
    CREATOR,
    INTEGRATIONS,
    PARTICIPANT,
    POKER_HOST(room -> room.poker == null ? null : room.poker.hostId),
    DURAK_HOST(room -> room.durak == null ? null : room.durak.hostId),
    CHESS_HOST(room -> room.chess == null ? null : room.chess.hostId),
    GARTIC_HOST(room -> room.gartic == null ? null : room.gartic.hostId),
    /**
     * Рисовать на доске (R159): любой участник, а когда доска «рисует ведущий» — только создатель
     * встречи. Без открытой доски рисовать нечего.
     */
    BOARD_DRAW,
    /**
     * Очистить доску и сменить, кто рисует: класс интеграций, пока рисуют все; при «рисует ведущий»
     * — только создатель, иначе участник вернул бы себе перо той же кнопкой.
     */
    BOARD_MANAGE,
    /** Закрыть доску: кто её открыл и создатель встречи — запасной выход, если открывший ушёл. */
    BOARD_CLOSE;

    private final Function<RoomState, String> host;

    Rule() {
      this(null);
    }

    Rule(Function<RoomState, String> host) {
      this.host = host;
    }

    boolean test(RoomState room, Role role, String memberId) {
      if (host != null) {
        var hostId = host.apply(room);
        return hostId != null && (role == Role.CREATOR || hostId.equals(memberId));
      }
      return switch (this) {
        case CREATOR -> role == Role.CREATOR;
        case INTEGRATIONS -> role == Role.CREATOR || room.integrationsAllowed;
        case BOARD_DRAW -> room.board != null && (role == Role.CREATOR || !room.board.hostOnly());
        case BOARD_MANAGE ->
            room.board != null
                && (role == Role.CREATOR || (!room.board.hostOnly() && room.integrationsAllowed));
        case BOARD_CLOSE ->
            room.board != null
                && (role == Role.CREATOR
                    || (memberId != null && memberId.equals(room.board.openedBy)));
        default -> true;
      };
    }
  }

  private static Problem forbidden() {
    return Problem.forbidden();
  }

  private static Problem gameHostOnly() {
    return Problem.conflict("GAME_HOST_ONLY", "Это действие доступно ведущему игры");
  }

  private static Problem boardOwnerOnly() {
    return Problem.conflict(
        "BOARD_OWNER_ONLY", "Закрыть доску может тот, кто её открыл, или создатель встречи");
  }

  /**
   * Действие и его имя на проводе. Имена стабильны: их читают служба и браузер.
   *
   * <p>Отказ у каждого свой ровно настолько, насколько он был своим раньше: почти везде 403, а у
   * шахмат и Gartic — 409 {@code GAME_HOST_ONLY}, который браузер показывает словами.
   */
  public enum Action {
    ROOM_CLOSE("room.close", Rule.CREATOR),
    ROOM_SETTINGS("room.settings", Rule.CREATOR),
    ROOM_INTEGRATIONS("room.integrations", Rule.CREATOR),
    INVITE_MANAGE("invite.manage", Rule.CREATOR),
    PARTICIPANT_APPROVE("participant.approve", Rule.CREATOR),
    PARTICIPANT_REMOVE("participant.remove", Rule.CREATOR),
    PARTICIPANT_MUTE("participant.mute", Rule.CREATOR),
    /** Привязка беседы Telegram открывает ей встречу — это решение создателя, а не гостя (T30). */
    TELEGRAM_LINK("telegram.link", Rule.CREATOR),
    /** «Может ли трогать интеграции вообще» — для интерфейса, у которого нет одной команды. */
    INTEGRATIONS_USE("integrations.use", Rule.INTEGRATIONS),
    MUSIC_VIEW("music.view", Rule.PARTICIPANT),
    MUSIC_ENABLE("music.enable", Rule.INTEGRATIONS),
    MUSIC_CONTROL("music.control", Rule.INTEGRATIONS),
    MUSIC_UPLOAD("music.upload", Rule.INTEGRATIONS),
    /** Убрать — то же право, что добавить (T14): раньше служба пускала сюда только создателя. */
    MUSIC_REMOVE("music.remove", Rule.INTEGRATIONS),
    /** Поиск по площадкам без аккаунта (YouTube, SoundCloud) — как поиск Яндекса (T18). */
    MUSIC_SEARCH("music.search", Rule.INTEGRATIONS),
    /** Трек по ссылке или из найденного — как трек из Яндекса: в общую очередь (T18). */
    MUSIC_LINK("music.link", Rule.INTEGRATIONS),
    YANDEX_CONNECT("yandex.connect", Rule.INTEGRATIONS),
    YANDEX_SEARCH("yandex.search", Rule.INTEGRATIONS),
    YANDEX_QUEUE("yandex.queue", Rule.INTEGRATIONS),
    YANDEX_DISCONNECT("yandex.disconnect", Rule.INTEGRATIONS),
    /** Листать каталог — личное занятие: комнату это не меняет. */
    CINEMA_BROWSE("cinema.browse", Rule.PARTICIPANT),
    /** Поток для своего плеера нужен каждому зрителю открытого ролика. */
    CINEMA_RESOLVE("cinema.resolve", Rule.PARTICIPANT),
    WATCH_OPEN("watch.open", Rule.INTEGRATIONS),
    /** Пауза общая — и право на неё то же, что на «принести» (см. {@code watch.play}). */
    WATCH_CONTROL("watch.control", Rule.INTEGRATIONS),
    WATCH_CLOSE("watch.close", Rule.INTEGRATIONS),
    POKER_OPEN("poker.open", Rule.INTEGRATIONS),
    POKER_MANAGE("poker.manage", Rule.POKER_HOST),
    DURAK_OPEN("durak.open", Rule.INTEGRATIONS),
    DURAK_MANAGE("durak.manage", Rule.DURAK_HOST),
    CHESS_OPEN("chess.open", Rule.INTEGRATIONS),
    CHESS_MANAGE("chess.manage", Rule.CHESS_HOST, Permissions::gameHostOnly),
    GARTIC_OPEN("gartic.open", Rule.INTEGRATIONS),
    GARTIC_MANAGE("gartic.manage", Rule.GARTIC_HOST, Permissions::gameHostOnly),
    /** Принести доску на сцену — как стол или кинозал (R159). */
    BOARD_OPEN("board.open", Rule.INTEGRATIONS),
    /** Рисовать: правки сцены по сокету доски. Кому нельзя — смотрит доску без пера. */
    BOARD_DRAW("board.draw", Rule.BOARD_DRAW),
    /** Кто рисует: все или только создатель встречи. */
    BOARD_SETTINGS("board.settings", Rule.BOARD_MANAGE),
    /** Очистить доску у всех — и «Заменить доску» файлом. */
    BOARD_CLEAR("board.clear", Rule.BOARD_MANAGE),
    BOARD_CLOSE("board.close", Rule.BOARD_CLOSE, Permissions::boardOwnerOnly);

    private final String wire;
    private final Rule rule;
    private final Supplier<Problem> refusal;

    Action(String wire, Rule rule) {
      this(wire, rule, Permissions::forbidden);
    }

    Action(String wire, Rule rule, Supplier<Problem> refusal) {
      this.wire = wire;
      this.rule = rule;
      this.refusal = refusal;
    }

    /** Имя на проводе: {@code music.remove}. */
    public String wire() {
      return wire;
    }

    public static Optional<Action> of(String wire) {
      return Arrays.stream(values()).filter(a -> a.wire.equals(wire)).findFirst();
    }
  }

  /** Роль участника сейчас. {@code null} — посторонний. */
  public static Role role(RoomState.Member member) {
    if (member == null) return Role.NONE;
    if (member.service != null) return Role.BOT;
    if (member.status == RoomState.Status.WAITING) return Role.WAITING;
    if (!member.mediaAllowed()) return Role.NONE;
    return member.owner ? Role.CREATOR : Role.PARTICIPANT;
  }

  public static boolean allows(RoomState room, RoomState.Member member, Action action) {
    return allows(room, role(member), member == null ? null : member.id, action);
  }

  private static boolean allows(RoomState room, Role role, String memberId, Action action) {
    if (room.closedAt != null) return false;
    if (role != Role.CREATOR && role != Role.PARTICIPANT) return false;
    return action.rule.test(room, role, memberId);
  }

  /** Бросает отказ этого действия, если участнику его нельзя. */
  public static void require(RoomState room, RoomState.Member member, Action action) {
    if (!allows(room, member, action)) throw action.refusal.get();
  }

  /** Всё, что участник может прямо сейчас, — именами на проводе, в порядке таблицы. */
  public static List<String> granted(RoomState room, RoomState.Member member) {
    var role = role(member);
    var id = member == null ? null : member.id;
    return Arrays.stream(Action.values())
        .filter(a -> allows(room, role, id, a))
        .map(Action::wire)
        .toList();
  }

  /**
   * Что может обычный участник этой встречи, не создатель и не ведущий стола.
   *
   * <p>Это ответ для людей из привязанной беседы Telegram: они не участники встречи, и снимка
   * «глазами» каждого из них нет, а решать за них службе своей копией правила больше нельзя.
   */
  public static List<String> participant(RoomState room) {
    return Arrays.stream(Action.values())
        .filter(a -> allows(room, Role.PARTICIPANT, null, a))
        .map(Action::wire)
        .toList();
  }
}
