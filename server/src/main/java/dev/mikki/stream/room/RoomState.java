package dev.mikki.stream.room;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.*;

/**
 * A room is the transaction boundary; at most ten members may hold a seat.
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
  public boolean mediaDrained;
  public boolean approvalRequired;
  public boolean integrationsAllowed = true;
  public long sequence;
  public Map<String, Member> members = new LinkedHashMap<>();
  public Map<String, Invite> invites = new LinkedHashMap<>();
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
    if (members.values().stream().anyMatch(m -> m.service == null && m.occupiesSeat())) return now;
    long seen = createdAt;
    if (closedAt != null) seen = Math.max(seen, closedAt);
    if (emptySince != null) seen = Math.max(seen, emptySince);
    for (var member : members.values())
      if (member.service == null) seen = Math.max(seen, member.joinedAt);
    return seen;
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
    /**
     * Одна из {@link Contracts#WATCH_PROVIDERS}: youtube, twitch, vk, rutube, ivi, jellyfin, link.
     */
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
