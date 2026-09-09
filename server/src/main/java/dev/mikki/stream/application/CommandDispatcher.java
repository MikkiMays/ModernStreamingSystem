package dev.mikki.stream.application;

import dev.mikki.stream.media.MediaGateway;
import dev.mikki.stream.room.*;
import dev.mikki.stream.shared.Problem;
import org.springframework.stereotype.Service;

/** Commit revocation before the external RPC; reconciliation retries failed removals. */
@Service
public class CommandDispatcher {
  private final RoomService rooms;
  private final MediaGateway media;

  public CommandDispatcher(RoomService rooms, MediaGateway media) {
    this.rooms = rooms;
    this.media = media;
  }

  public Contracts.Ack execute(String roomId, String credential, Contracts.Command command) {
    var ack = rooms.command(roomId, credential, command);
    try {
      switch (command.type()) {
        case "leave" ->
            media.remove(roomId, credential.replaceFirst("^Bearer ", "").split("\\.")[0]);
        case "participant.remove" -> media.remove(roomId, command.targetId());
        case "close" -> {
          for (var p : media.participants(roomId)) media.remove(roomId, p.getIdentity());
        }
        default -> {}
      }
    } catch (Problem ignored) {
      /* The admission gate already rejects this identity. */
    }
    return ack;
  }
}
