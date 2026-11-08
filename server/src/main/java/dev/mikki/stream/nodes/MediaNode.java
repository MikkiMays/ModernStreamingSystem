package dev.mikki.stream.nodes;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.Map;

/**
 * Медиаузел: SFU + TURN в одном месте (R195, {@code docs/architecture/distributed-media.md}).
 *
 * <p>Так его описывает реестр {@code infra/generated/nodes/registry.json}, который пишет {@code
 * scripts/node-config.mjs}. Поля, нужные ядру и клиенту: {@code id} — короткое имя ({@code fra},
 * {@code hel}), оно же хранится в снимке комнаты ({@code RoomState.mediaNode}); {@code rtcUrl} —
 * куда клиент подключает SDK ({@code wss://rtc-hel.callcord.ru}); {@code probeUrl} и {@code stun} —
 * чем клиент меряет путь до узла по TCP и UDP; {@code internalUrl} — Twirp узла с точки зрения ядра
 * (локальный порт магистрали); {@code maxRooms} — сколько встреч ядро ставит на узел; {@code
 * enabled} — можно ли ставить новые встречи (дренаж перед выкаткой — {@code false}); {@code
 * control} — узел управления, он же узел по умолчанию для комнат без {@code mediaNode}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record MediaNode(
    String id,
    boolean control,
    Map<String, String> title,
    String rtcUrl,
    String probeUrl,
    String stun,
    String internalUrl,
    int maxRooms,
    boolean enabled) {
  public MediaNode {
    if (id == null || !id.matches("[a-z][a-z0-9-]{0,15}"))
      throw new IllegalArgumentException("Media node id must be a short lowercase label: " + id);
    if (rtcUrl == null || rtcUrl.isBlank())
      throw new IllegalArgumentException("Media node " + id + " has no rtcUrl");
    if (internalUrl == null || internalUrl.isBlank())
      throw new IllegalArgumentException("Media node " + id + " has no internalUrl");
    title = title == null ? Map.of() : Map.copyOf(title);
    if (maxRooms < 1) maxRooms = 1;
  }

  /**
   * Как узел называется для человека на этом языке; нет перевода — английское имя, нет его — id.
   */
  public String titleFor(String language) {
    return title.getOrDefault(language, title.getOrDefault("en", id));
  }
}
