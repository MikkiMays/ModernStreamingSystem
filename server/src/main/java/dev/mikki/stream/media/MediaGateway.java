package dev.mikki.stream.media;

import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.room.Contracts.MediaToken;
import dev.mikki.stream.room.RoomState;
import dev.mikki.stream.shared.Problem;
import io.livekit.server.*;
import java.time.Duration;
import java.util.*;
import livekit.LivekitModels;
import org.springframework.stereotype.Component;

@Component
public class MediaGateway {
  private final StreamProperties config;
  private final RoomServiceClient client;

  public MediaGateway(StreamProperties config) {
    this.config = config;
    client =
        RoomServiceClient.createClient(
            config.livekitInternalUrl(),
            config.livekitKey(),
            config.livekitSecret(),
            () -> new okhttp3.OkHttpClient.Builder().callTimeout(Duration.ofSeconds(3)).build());
  }

  public MediaToken token(RoomState room, RoomState.Member member) {
    var token = new AccessToken(config.livekitKey(), config.livekitSecret());
    token.setIdentity(member.id);
    token.setName(member.name);
    token.setTtl(60000);
    token.addGrants(
        new RoomJoin(true),
        new RoomName(room.id),
        new CanSubscribe(true),
        new CanPublish(true),
        new CanPublishData(false),
        new CanUpdateOwnMetadata(false),
        new CanPublishSources(sources(member.screen)));
    return new MediaToken(config.livekitUrl(), token.toJwt(), System.currentTimeMillis() + 60000);
  }

  public static List<String> sources(boolean screen) {
    return screen
        ? List.of("camera", "microphone", "screen_share", "screen_share_audio")
        : List.of("camera", "microphone");
  }

  public void permissions(String roomId, String participantId, boolean screen) {
    var permission =
        LivekitModels.ParticipantPermission.newBuilder()
            .setCanSubscribe(true)
            .setCanPublish(true)
            .setCanPublishData(false)
            .setCanUpdateMetadata(false)
            .addCanPublishSources(LivekitModels.TrackSource.CAMERA)
            .addCanPublishSources(LivekitModels.TrackSource.MICROPHONE);
    if (screen)
      permission
          .addCanPublishSources(LivekitModels.TrackSource.SCREEN_SHARE)
          .addCanPublishSources(LivekitModels.TrackSource.SCREEN_SHARE_AUDIO);
    execute(client.updateParticipant(roomId, participantId, null, null, permission.build()));
  }

  public List<LivekitModels.ParticipantInfo> participants(String roomId) {
    return execute(client.listParticipants(roomId));
  }

  public void remove(String roomId, String participantId) {
    execute(client.removeParticipant(roomId, participantId));
  }

  private <T> T execute(retrofit2.Call<T> call) {
    try {
      var result = call.execute();
      if (!result.isSuccessful()) throw new IllegalStateException("SFU response " + result.code());
      return result.body();
    } catch (Exception e) {
      throw new Problem(503, "MEDIA_UNAVAILABLE", "Медиасервер временно недоступен");
    }
  }
}
