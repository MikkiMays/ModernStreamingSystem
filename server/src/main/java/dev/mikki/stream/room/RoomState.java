package dev.mikki.stream.room;

import java.util.*;

/** A room is the transaction boundary; at most ten members may hold a seat. */
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
    /** {@code youtube} или {@code twitch}. */
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
