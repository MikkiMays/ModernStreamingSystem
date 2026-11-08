package dev.mikki.stream.nodes;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.Map;

/**
 * Медиаузел: SFU + TURN в одном месте (R195, {@code docs/architecture/distributed-media.md}).
 *
 * <p>Так его описывает реестр {@code infra/generated/nodes/registry.json}, который пишет {@code
 * scripts/node-config.mjs}. Поля, нужные ядру и клиенту: {@code id} — короткое имя ({@code fra},
 * {@code hel}), оно же хранится в снимке комнаты ({@code RoomState.mediaNode}); {@code rtcUrl} —
 * куда клиент подключает SDK ({@code wss://rtc-hel.cordcam.ru}); {@code probeUrl} и {@code stun} —
 * чем клиент меряет путь до узла по TCP и UDP; {@code internalUrl} — Twirp узла с точки зрения ядра
 * (локальный порт магистрали); {@code maxRooms} — сколько встреч ядро ставит на узел; {@code
 * enabled} — можно ли ставить новые встречи (дренаж перед выкаткой — {@code false}); {@code
 * control} — узел управления, он же узел по умолчанию для комнат без {@code mediaNode}.
 *
 * <p>Ёмкость и показ (R200, {@code server-selection.md} §3.4, §8.1): {@code country} — ISO 3166-1
 * alpha-2 ({@code DE}, {@code FI}, {@code RU}) для флага у человека; {@code uplinkMbps} — отдача
 * канала узла, к ней считается доля трафика; {@code cores} — ядра хоста, для справки оператору;
 * {@code loadUrl} — откуда ядро читает ЦП и трафик узла (node-exporter узла по магистрали, {@code
 * http://127.0.0.1:2N002/metrics}); нет адреса — ступень считается только по встречам и людям.
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
    boolean enabled,
    String country,
    int uplinkMbps,
    int cores,
    String loadUrl) {
  /**
   * Отдача канала, если реестр её не назвал: как {@code stream.uplink-mbps} у {@code LoadMeter}.
   */
  public static final int DEFAULT_UPLINK_MBPS = 1000;

  public MediaNode {
    if (id == null || !id.matches("[a-z][a-z0-9-]{0,15}"))
      throw new IllegalArgumentException("Media node id must be a short lowercase label: " + id);
    if (rtcUrl == null || rtcUrl.isBlank())
      throw new IllegalArgumentException("Media node " + id + " has no rtcUrl");
    if (internalUrl == null || internalUrl.isBlank())
      throw new IllegalArgumentException("Media node " + id + " has no internalUrl");
    title = title == null ? Map.of() : Map.copyOf(title);
    if (maxRooms < 1) maxRooms = 1;
    if (country != null) {
      country = country.trim().toUpperCase();
      if (!country.matches("[A-Z]{2}"))
        throw new IllegalArgumentException(
            "Media node " + id + " country must be ISO 3166-1 alpha-2, got " + country);
    }
    if (uplinkMbps < 1) uplinkMbps = DEFAULT_UPLINK_MBPS;
    if (cores < 0) cores = 0;
    if (loadUrl != null && loadUrl.isBlank()) loadUrl = null;
  }

  /** Узел без полей ёмкости (так реестр писали до R200 и так строится неявный узел). */
  public MediaNode(
      String id,
      boolean control,
      Map<String, String> title,
      String rtcUrl,
      String probeUrl,
      String stun,
      String internalUrl,
      int maxRooms,
      boolean enabled) {
    this(
        id,
        control,
        title,
        rtcUrl,
        probeUrl,
        stun,
        internalUrl,
        maxRooms,
        enabled,
        null,
        0,
        0,
        null);
  }

  /**
   * Как узел называется для человека на этом языке; нет перевода — английское имя, нет его — id.
   */
  public String titleFor(String language) {
    return title.getOrDefault(language, title.getOrDefault("en", id));
  }
}
