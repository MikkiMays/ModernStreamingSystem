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

  public record Invite(
      String id, String secretHash, long createdAt, long expiresAt, boolean revoked) {}

  public record Message(
      String id, String participantId, String name, String text, long createdAt, long expiresAt) {}
}
