package dev.mikki.stream.media;

import dev.mikki.stream.room.*;
import java.util.HashMap;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(
    name = "stream.scheduling-enabled",
    havingValue = "true",
    matchIfMissing = true)
public class MediaReconciler {
  private final RoomRepository repository;
  private final RoomService rooms;
  private final MediaService media;
  private final MediaGateway gateway;
  private final Lifecycle lifecycle;

  public MediaReconciler(
      RoomRepository repository,
      RoomService rooms,
      MediaService media,
      MediaGateway gateway,
      Lifecycle lifecycle) {
    this.repository = repository;
    this.rooms = rooms;
    this.media = media;
    this.gateway = gateway;
    this.lifecycle = lifecycle;
  }

  @Scheduled(fixedDelay = 1000)
  public void deadlines() {
    for (var room : repository.all()) lifecycle.sweepRoom(room.id);
  }

  @Scheduled(fixedDelay = 2000)
  public void reconcile() {
    for (var room : repository.all()) {
      if (room.closedAt != null && room.mediaDrained) continue;
      try {
        long observedAt = rooms.now();
        var participants = gateway.participants(room.id);
        var present = new HashMap<String, String>();
        if (participants != null)
          for (var p : participants) present.put(p.getIdentity(), p.getSid());
        media.observe(room.id, present, observedAt);
        var current = rooms.read(room.id);
        for (var identity : present.keySet()) {
          var member = current.members.get(identity);
          var p =
              participants.stream()
                  .filter(item -> item.getIdentity().equals(identity))
                  .findFirst()
                  .orElseThrow();
          long screens =
              p.getTracksList().stream()
                  .filter(t -> t.getSource() == livekit.LivekitModels.TrackSource.SCREEN_SHARE)
                  .count();
          if (current.closedAt != null
              || member == null
              || !member.mediaAllowed()
              || screens > 1
              || (screens > 0 && !member.screen)) gateway.remove(room.id, identity);
        }
      } catch (dev.mikki.stream.shared.Problem ignored) {
        // An unavailable SFU is not evidence that every participant has left.
      }
    }
  }
}
