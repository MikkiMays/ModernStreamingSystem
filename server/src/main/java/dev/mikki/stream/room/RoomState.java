package dev.mikki.stream.room;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.*;

/**
 * A room is the transaction boundary; at most {@code stream.max-participants} people may hold a
 * seat — bots do not take one ({@link Member#human()}).
 *
 * <p>Снимок читается тем же ядром, которое его писало, — но не обязательно той же его версией:
 * между записью и чтением помещается выкатка, а иногда и откат. Поэтому неизвестные поля здесь
 * пропускаются, а не роняют комнату: иначе вернуть предыдущий образ значило бы сделать нечитаемыми
 * все комнаты, которые успел тронуть новый.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class RoomState {
  public String id;
  public String title;
  public String code;
  public long createdAt;
  public Long closedAt;
  public Long emptySince;
  public boolean everConnected;

  /**
   * Когда встреча началась: в ней впервые двое живых людей на связи (T35, П7), или null.
   *
   * <p>Ставится один раз ({@link #markStarted}) и не сдвигается, пока встреча идёт: вышел и
   * вернулся второй человек — это та же встреча. Повторное открытие сохранённой встречи начинает её
   * заново. По этой метке и часам сервера в снимке браузер показывает, сколько встреча идёт.
   *
   * <p>{@code NON_NULL} — чтобы комната без неё записывалась ровно как раньше: откат образа ядра
   * читает такие комнаты без потерь.
   */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public Long startedAt;

  /**
   * С какого адреса и каким профилем встреча создана (A1 модели угроз): HMAC ключа адреса секретом
   * сервера и хэш профиля. По ним считается, сколько встреч одного адреса и профиля сейчас занимают
   * место на сервере. Наружу не отдаются; у встреч служб и тестов их нет.
   *
   * <p>{@code NON_NULL} — комната без них пишется как раньше, и откат образа читает её без потерь.
   */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public String createdFrom;

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public String createdBy;

  /**
   * Когда встреча открыта в последний раз: создана или открыта заново из избранного. От этой метки
   * считается потолок длительности ({@code stream.meeting.max-duration}, A2); null — с создания.
   */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public Long openedAt;

  /**
   * Когда встреча завершится по потолку длительности — ставится в тот момент, когда всем ушло
   * предупреждение ({@code meeting.warning}), и попадает в снимок. До предупреждения — null.
   */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public Long endsAt;

  /**
   * Какую долю потолка трафика кинозала встреча выбрала, в процентах (A8): служба сообщает порог
   * {@code CINEMA_TRAFFIC_WARN_AT} (80) и сам потолок (100), снимок показывает плашку. Только
   * растёт; null — встреча до порога не дошла. Новая встреча (открыта заново) считает заново.
   */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public Integer cinemaTraffic;

  /**
   * Встречу завершил владелец сервера («Активность», {@code docs/abuse-model.md} §5): до этого
   * момента (мс) её не открыть из избранного — ни создателю, ни кому-то ещё. null — завершена не
   * владельцем или срок вышел. {@code NON_NULL} — комната без метки пишется как раньше: откат.
   */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public Long closedByServer;

  public boolean mediaDrained;
  public boolean approvalRequired;
  public boolean integrationsAllowed = true;
  public long sequence;
  public Map<String, Member> members = new LinkedHashMap<>();

  /**
   * Профиль устройства каждого вошедшего: участник → хэш секрета {@code X-Cord-Profile} (T52, П13).
   *
   * <p>ОТДЕЛЬНОЙ КАРТОЙ, А НЕ ПОЛЕМ УЧАСТНИКА — ради отката. Участник ({@link Member}) у прежнего
   * образа ядра читается без {@code ignoreUnknown}, и новое поле в нём сделало бы нечитаемой каждую
   * комнату, куда вошёл новый клиент. Карту же прежний образ просто пропустит: неизвестное в самой
   * комнате он игнорирует. У ботов и старых клиентов записи нет.
   *
   * <p>Наружу — ни в снимок, ни в список участников — не отдаётся никогда.
   */
  @JsonInclude(JsonInclude.Include.NON_EMPTY)
  public Map<String, String> profiles = new LinkedHashMap<>();

  /**
   * Когда каждый человек на связи последний раз дал знать, что он здесь (A2, «Вы ещё здесь?»):
   * участник → мс. Нет записи — отсчёт от входа. Браузер сам шлёт {@code presence.confirm}, когда
   * человек говорит, двигает мышь, жмёт клавиши или держит камеру; молчание дольше {@code
   * stream.meeting.presence-check} — вопрос, а без ответа за {@code presence-answer} — обычный
   * выход.
   *
   * <p>Рядом, а не в {@link Member}, по той же причине, что {@link #profiles}: откат образа ядра.
   * {@code NON_EMPTY} — комната без этого пишется ровно как раньше.
   */
  @JsonInclude(JsonInclude.Include.NON_EMPTY)
  public Map<String, Long> presence = new LinkedHashMap<>();

  /**
   * Откуда пришёл каждый, кто ждёт допуска: участник → отпечаток адреса ({@code Secrets.address},
   * П8). По нему у двери одной встречи не больше {@code per-ip.waiting-per-room} заявок с адреса
   * (A5). Запись живёт, пока человек ждёт; карта рядом, а не в {@link Member} — ради отката.
   */
  @JsonInclude(JsonInclude.Include.NON_EMPTY)
  public Map<String, String> waitingFrom = new LinkedHashMap<>();

  /** Кого уже спросили «Вы ещё здесь?» — чтобы спросить один раз и сказать об этом один раз. */
  @JsonInclude(JsonInclude.Include.NON_EMPTY)
  public Set<String> presenceAsked = new LinkedHashSet<>();

  /**
   * С какого момента кино или музыка идут, а ни одного человека на связи нет (A2, {@code
   * stream.meeting.idle-integrations}); null — кто-то на связи или играть нечему.
   */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public Long idleSince;

  public Map<String, Invite> invites = new LinkedHashMap<>();

  /** Приглашение, которое раздаёт бот Telegram, — одно на комнату, пока живо (A11). */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public String botInvite;

  public List<Message> messages = new ArrayList<>();

  /** Что комната смотрит вместе прямо сейчас, или null. Живёт и умирает вместе с комнатой. */
  public Watch watch;

  /**
   * Покерный стол комнаты, или null.
   *
   * <p>Лежит здесь же, в снимке комнаты, — вместе с фишками, колодой и чужими картами. Из этого и
   * следует главное свойство игры: она переживает перезапуск ядра, но не переживает саму встречу, и
   * никакого отдельного хранилища у неё нет.
   *
   * <p>Наружу это поле не отдаётся никогда. Браузер получает {@link
   * dev.mikki.stream.game.TableView} — то же самое, но без колоды и без чужих карт.
   *
   * <p>{@code NON_NULL} здесь не украшение: комната без стола обязана записываться ровно так же,
   * как записывалась до появления игры. Тогда предыдущий образ ядра, не знающий про покер,
   * продолжает читать такие комнаты — то есть откат остаётся возможным.
   */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public dev.mikki.stream.game.Table poker;

  /**
   * Стол дурака, или null. Живёт по тем же правилам, что и покерный.
   *
   * <p>Отдельное поле, а не «игра» с типом внутри: у двух игр нет ни одного общего поля состояния,
   * и объединять их пришлось бы картой без типов. Сцена всё равно одна — за этим следит {@code
   * RoomService}, а не форма снимка.
   *
   * <p>{@code NON_NULL} здесь по той же причине, что и у покера: комната без дурака обязана
   * записываться ровно так же, как записывалась до его появления, иначе откат ядра сделает
   * нечитаемой каждую комнату, где успели сыграть.
   */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public dev.mikki.stream.game.Durak durak;

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public dev.mikki.stream.game.Chess chess;

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public dev.mikki.stream.game.Gartic gartic;

  /**
   * Чем кончились игры этой беседы.
   *
   * <p>ЭТО ИТОГИ, А НЕ ЛОГ. Кто играл, сколько докупался, сколько поставил, кто сорвал самый
   * крупный банк — то, что за столом обсуждают, вставая. Ход раздач не хранится вовсе: он живёт,
   * пока идёт игра, и повторно его никто не читает.
   *
   * <p>Список ограничен ({@link #POKER_HISTORY}) и по той же причине, по которой ограничена
   * переписка: снимок комнаты — это не архив. Старые записи уходят первыми.
   *
   * <p>{@code NON_NULL} и {@code null} по умолчанию — не украшение: комната, в которой не доиграли
   * ни одной игры, обязана записываться ровно так же, как записывалась до появления истории.
   */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public List<dev.mikki.stream.game.GameSummary> pokerGames;

  /**
   * Чем кончились партии дурака этой беседы.
   *
   * <p>Партия дурака короткая, и за вечер их набирается больше, чем покерных игр, — но правило то
   * же: снимок комнаты не архив, старые записи уходят первыми. Каждая запись несёт и счёт вечера на
   * свой момент, поэтому «сколько у кого» читается из последней, а не складывается заново.
   *
   * <p>{@code NON_NULL} и {@code null} по умолчанию — не украшение: комната, в которой не доиграли
   * ни одной партии, обязана записываться ровно так же, как записывалась до появления истории.
   */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public List<dev.mikki.stream.game.DurakSummary> durakGames;

  /** Сколько игр помнит комната. */
  public static final int POKER_HISTORY = 20;

  /** Сколько партий дурака помнит комната. Они короче, поэтому их влезает больше. */
  public static final int DURAK_HISTORY = 30;

  /**
   * Когда в комнате последний раз был человек.
   *
   * <p>Это единственное определение «встречей пользуются» на весь проект: по нему считается срок
   * хранения ({@code stream.room-retention-seconds}), и оно же ложится в столбец {@code
   * rooms.last_seen_at}, чтобы забытые комнаты можно было увидеть запросом, а не разбором JSON.
   *
   * <p>Берётся самое позднее из четырёх: создание, закрытие, момент, когда комната опустела, и вход
   * любого из участников. Четыре, а не одно, потому что ни одного из них не хватает: у комнаты, где
   * сидят прямо сейчас, нет ни закрытия, ни пустоты; у закрытой ведущим нет {@code emptySince}; а
   * {@code joinedAt} у трёхдневной встречи остаётся в первом дне.
   *
   * <p>Служебные участники не считаются. Музыкальный бот — не человек, и комната, в которой он
   * остался один, не «используется»: он и сам уходит, не услышав людей минуту. Иначе достаточно
   * было бы раз в неделю включать в комнате музыку, чтобы она не удалялась никогда.
   */
  public long lastSeenAt(long now) {
    if (members.values().stream().anyMatch(m -> m.human() && m.occupiesSeat())) return now;
    long seen = createdAt;
    if (closedAt != null) seen = Math.max(seen, closedAt);
    if (emptySince != null) seen = Math.max(seen, emptySince);
    for (var member : members.values()) if (member.human()) seen = Math.max(seen, member.joinedAt);
    return seen;
  }

  /**
   * Сколько людей занимают места — ровно то, что ограничивает {@code stream.max-participants}.
   *
   * <p>Ожидающие допуска (WAITING) мест не занимают (A5 модели угроз): раньше десяток заявок с
   * одного адреса держал встречу полной пять минут даже при включённом допуске. У двери свой
   * потолок — {@code stream.meeting.waiting}, — а ведущий впускает, только пока есть место.
   */
  public long seatedHumans() {
    return members.values().stream().filter(m -> m.human() && m.mediaAllowed()).count();
  }

  /** Сколько людей ждут допуска у двери ({@code stream.meeting.waiting}). */
  public long waitingHumans() {
    return members.values().stream().filter(m -> m.human() && m.status == Status.WAITING).count();
  }

  /** Сколько встреча считается новой и занимает место на сервере, даже если на связи никого. */
  public static final long FRESH_MS = 30_000;

  /**
   * Занимает ли встреча место на сервере ({@code stream.max-rooms}).
   *
   * <p>Считается открытая встреча, где хотя бы один человек на связи, или совсем новая — моложе
   * {@link #FRESH_MS}: создатель ещё подключается. Раньше считалась любая встреча с занятым местом,
   * и пять запросов «создать» без единого подключения держали сервер закрытым две минуты, пока не
   * выйдет срок входа (A1 модели угроз). Бот на связи без людей встречу не держит.
   */
  public boolean busy(long now) {
    return closedAt == null
        && (now - createdAt < FRESH_MS
            || members.values().stream().anyMatch(m -> m.human() && m.status == Status.CONNECTED));
  }

  /**
   * Поставить начало встречи, если на связи впервые двое людей. Возвращает, поставлено ли сейчас:
   * тот, кто зовёт, решает, объявлять ли это участникам.
   */
  public boolean markStarted(long now) {
    if (startedAt != null || closedAt != null) return false;
    if (members.values().stream().filter(m -> m.human() && m.status == Status.CONNECTED).count()
        < 2) return false;
    startedAt = now;
    return true;
  }

  /**
   * Живое участие этого профиля во встрече (T52): место занято, и срок восстановления не вышел.
   *
   * <p>Восстановление связи (RECOVERING) и ожидание у двери (WAITING) — это участие: человек всё
   * ещё во встрече. Вышедший срок восстановления — уже нет, даже если уборка до него не дошла.
   */
  public boolean engages(String profileHash, long now) {
    return closedAt == null
        && members.values().stream()
            .anyMatch(
                m ->
                    m.human()
                        && profileHash.equals(profiles.get(m.id))
                        && m.occupiesSeat()
                        && (m.recoveryDeadline == null || now < m.recoveryDeadline));
  }

  public enum Status {
    WAITING,
    JOINING,
    CONNECTED,
    RECOVERING,
    LEFT,
    EXPIRED,
    REMOVED
  }

  /**
   * Участник встречи.
   *
   * <p>{@code ignoreUnknown} — для следующего отката: начиная с этого образа новое поле участника
   * не делает комнату нечитаемой для предыдущего. Прежние образы его не знают, поэтому новое о
   * человеке пока кладётся рядом, в саму комнату ({@link #profiles}).
   */
  @JsonIgnoreProperties(ignoreUnknown = true)
  public static class Member {
    public String id;
    public String name;

    /** A small square image as a data URI, or null. Lives and dies with the room. */
    public String avatar;

    public String secretHash;
    public boolean owner;
    public String service;
    public boolean approved;
    public boolean codeRequest;
    public String replacedBy;
    public Status status;
    public long generation = 1;
    public Long recoveryDeadline;
    public boolean clientReportedLoss;
    public boolean screen;
    public String screenId;
    public boolean screenStarted;
    public boolean firstViewer;
    public String viewingScreenId;
    public long joinedAt;
    public String mediaSid;
    public long observedAt;

    /**
     * Человек ли это. Боты — музыка и всё, что приходит от служб, — не люди: они не занимают мест,
     * не держат встречу и не начинают её. Правило одно, и спрашивают его здесь.
     */
    public boolean human() {
      return service == null;
    }

    public boolean occupiesSeat() {
      return status == Status.WAITING
          || status == Status.JOINING
          || status == Status.CONNECTED
          || status == Status.RECOVERING;
    }

    public boolean mediaAllowed() {
      return status == Status.JOINING || status == Status.CONNECTED || status == Status.RECOVERING;
    }
  }

  /**
   * Совместный просмотр: один ролик или канал на всю комнату.
   *
   * <p>Позиция хранится <b>якорем</b>, а не потоком отсчётов: {@code positionMs} верна в момент
   * {@code anchorAt} по часам сервера, а сколько прошло с тех пор, каждый считает сам. Поэтому
   * состояние меняется только на действие человека — нажал паузу, перемотал, — и никакой
   * «сердцебиение позиции» в комнату не пишется. Опоздавший и переподключившийся получают то же
   * самое место в ролике из обычного снимка.
   *
   * <p>Живой эфир позиции не имеет: у {@code channel} {@code positionMs} всегда 0, и каждый смотрит
   * собственный край трансляции — догонять там нечего.
   */
  public static class Watch {
    /** Одна из {@link Contracts#WATCH_PROVIDERS}: youtube, twitch, vk, rutube, ivi, link. */
    public String provider;

    /** {@code video} — ролик с позицией, {@code channel} — живой эфир. */
    public String kind;

    public String contentId;

    /** Как назвать то, что открыто, пока плеер не рассказал о себе сам. Может быть пустым. */
    public String title;

    public String openedBy;
    public boolean paused;
    public long positionMs;

    /** Момент по часам сервера, в который {@code positionMs} была верна. */
    public long anchorAt;

    /** Растёт на каждое изменение: по нему клиент отличает своё эхо от чужого решения. */
    public long revision;
  }

  public record Invite(
      String id, String secretHash, long createdAt, long expiresAt, boolean revoked) {}

  public record Message(
      String id, String participantId, String name, String text, long createdAt, long expiresAt) {}
}
