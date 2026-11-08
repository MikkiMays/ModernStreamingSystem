package dev.mikki.stream.media;

import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.nodes.MediaNode;
import dev.mikki.stream.nodes.MediaNodes;
import dev.mikki.stream.room.Contracts.MediaToken;
import dev.mikki.stream.room.RoomRepository;
import dev.mikki.stream.room.RoomState;
import dev.mikki.stream.shared.Problem;
import io.livekit.server.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import livekit.LivekitModels;
import org.springframework.stereotype.Component;

/**
 * Разговор ядра с SFU — с тем узлом, на котором живёт комната (R195).
 *
 * <p>Узел комнаты — {@code RoomState.mediaNode}, узлы — {@link MediaNodes}; у каждого узла свой
 * Twirp-клиент по его {@code internalUrl} (на узле управления — {@code 127.0.0.1:7880}, на других —
 * локальный порт магистрали). Токен участника несёт {@code rtcUrl} узла комнаты: сигнал и медиа
 * идут прямо туда, ядро между ними не стоит.
 */
@Component
public class MediaGateway {
  private final StreamProperties config;
  private final MediaNodes nodes;
  private final RoomRepository rooms;
  private final Map<String, RoomServiceClient> clients = new ConcurrentHashMap<>();

  /**
   * Клиенты опроса здоровья: таймаут 1 с, чтобы молчащий узел был замечен за ≈ 3 × (1 с + 5 с), а
   * не за 19–24 с.
   */
  private final Map<String, RoomServiceClient> healthClients = new ConcurrentHashMap<>();

  public MediaGateway(StreamProperties config, MediaNodes nodes, RoomRepository rooms) {
    this.config = config;
    this.nodes = nodes;
    this.rooms = rooms;
  }

  private RoomServiceClient client(MediaNode node) {
    return clients.computeIfAbsent(
        node.internalUrl(),
        url ->
            RoomServiceClient.createClient(
                url,
                config.livekitKey(),
                config.livekitSecret(),
                () ->
                    new okhttp3.OkHttpClient.Builder().callTimeout(Duration.ofSeconds(3)).build()));
  }

  private MediaNode nodeOf(String roomId) {
    return nodes.resolve(rooms.get(roomId, false).mediaNode);
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
    return new MediaToken(
        nodes.resolve(room.mediaNode).rtcUrl(), token.toJwt(), System.currentTimeMillis() + 60000);
  }

  public static List<String> sources(boolean screen) {
    return screen
        ? List.of("camera", "microphone", "screen_share", "screen_share_audio")
        : List.of("camera", "microphone");
  }

  public void permissions(RoomState room, String participantId, boolean screen) {
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
    execute(
        client(nodes.resolve(room.mediaNode))
            .updateParticipant(room.id, participantId, null, null, permission.build()));
  }

  public List<LivekitModels.ParticipantInfo> participants(RoomState room) {
    return execute(client(nodes.resolve(room.mediaNode)).listParticipants(room.id));
  }

  /** То же по имени комнаты — для вызовов, у которых самой комнаты под рукой нет (команды). */
  public List<LivekitModels.ParticipantInfo> participants(String roomId) {
    return execute(client(nodeOf(roomId)).listParticipants(roomId));
  }

  public void muteMicrophone(String roomId, String participantId) {
    var client = client(nodeOf(roomId));
    for (var participant : execute(client.listParticipants(roomId))) {
      if (!participant.getIdentity().equals(participantId)) continue;
      for (var track : participant.getTracksList())
        if (track.getSource() == LivekitModels.TrackSource.MICROPHONE)
          execute(client.mutePublishedTrack(roomId, participantId, track.getSid(), true));
    }
  }

  public void remove(RoomState room, String participantId) {
    execute(client(nodes.resolve(room.mediaNode)).removeParticipant(room.id, participantId));
  }

  public void remove(String roomId, String participantId) {
    execute(client(nodeOf(roomId)).removeParticipant(roomId, participantId));
  }

  /**
   * Распустить комнату SFU (R97). Все участники получают {@code Disconnected(ROOM_DELETED)} по
   * сигнальному сокету одновременно со снимком ядра — встреча закрывается у всех сразу, какой бы из
   * двух путей ни пришёл первым. {@code nodeId} — узел комнаты на момент закрытия: сама комната к
   * этому моменту уже закрыта, и перечитывать её незачем.
   */
  public void close(String nodeId, String roomId) {
    execute(client(nodes.resolve(nodeId)).deleteRoom(roomId));
  }

  /** Что узел держит сейчас: комнаты SFU и люди на связи в них (сумма {@code num_participants}). */
  public record NodeStats(int rooms, int participants) {}

  /**
   * Жив ли узел и сколько комнат и людей он держит — опрос {@link NodeHealth}. Отказ — {@link
   * Problem} {@code MEDIA_UNAVAILABLE}, как у любого вызова SFU.
   */
  public NodeStats rooms(MediaNode node) {
    var client =
        healthClients.computeIfAbsent(
            node.internalUrl(),
            url ->
                RoomServiceClient.createClient(
                    url,
                    config.livekitKey(),
                    config.livekitSecret(),
                    () ->
                        new okhttp3.OkHttpClient.Builder()
                            .callTimeout(Duration.ofSeconds(1))
                            .build()));
    var list = execute(client.listRooms(List.of()));
    if (list == null) return new NodeStats(0, 0);
    int people = 0;
    for (var room : list) people += room.getNumParticipants();
    return new NodeStats(list.size(), people);
  }

  /** Клиент для чтения node-exporter узла: та же секунда, что и у опроса SFU. */
  private final okhttp3.OkHttpClient metricsClient =
      new okhttp3.OkHttpClient.Builder().callTimeout(Duration.ofSeconds(1)).build();

  /**
   * Текст метрик node-exporter узла по его {@code loadUrl} — только ЦП и сеть ({@code collect[]}).
   * Нет адреса или узел не ответил — {@code null}: ступень считается без ЦП и канала, это не отказ.
   */
  public String metrics(MediaNode node) {
    if (node.loadUrl() == null) return null;
    var url =
        node.loadUrl()
            + (node.loadUrl().contains("?") ? "&" : "?")
            + "collect[]=cpu&collect[]=netdev";
    try (var response =
        metricsClient.newCall(new okhttp3.Request.Builder().url(url).build()).execute()) {
      if (!response.isSuccessful() || response.body() == null) return null;
      return response.body().string();
    } catch (Exception e) {
      return null;
    }
  }

  private <T> T execute(retrofit2.Call<T> call) {
    try {
      var result = call.execute();
      if (!result.isSuccessful()) throw new IllegalStateException("SFU response " + result.code());
      return result.body();
    } catch (Exception e) {
      throw new Problem(
          503, "MEDIA_UNAVAILABLE", "Звонок временно недоступен. Попробуйте через минуту");
    }
  }
}
