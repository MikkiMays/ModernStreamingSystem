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
 * (локальный порт магистрали); {@code enabled} — можно ли ставить новые встречи (дренаж перед
 * выкаткой — {@code false}); {@code control} — узел управления, он же узел по умолчанию для комнат
 * без {@code mediaNode}. Сколько встреч на узле — не предел (R228, Р-135): поле {@code maxRooms}
 * старых реестров читается и пропускается.
 *
 * <p>Ёмкость и показ (R200, {@code server-selection.md} §3.4, §8.1): {@code country} — ISO 3166-1
 * alpha-2 ({@code DE}, {@code FI}, {@code RU}) для флага у человека; {@code uplinkMbps} — отдача
 * канала узла, к ней считается доля трафика; {@code cores} — ядра хоста, для справки оператору;
 * {@code loadUrl} — откуда ядро читает ЦП и трафик узла (node-exporter узла по магистрали, {@code
 * http://127.0.0.1:2N002/metrics}); нет адреса — ЦП оценивается по людям на узле. {@code
 * sfuMetricsUrl} — метрики самого SFU (LiveKit {@code /metrics} за паролем {@code
 * LIVEKIT_METRICS_PASSWORD}: {@code http://127.0.0.1:6789/metrics} у узла управления, {@code 2N001}
 * — у медиаузла), откуда ядро читает память процесса SFU; {@code sfuMemoryMb} — предел памяти его
 * контейнера ({@code mem_limit} в compose, по умолчанию 1 ГиБ). Нет адреса — память SFU оценивается
 * по людям.
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
    boolean enabled,
    String country,
    int uplinkMbps,
    int cores,
    String loadUrl,
    String sfuMetricsUrl,
    int sfuMemoryMb) {
  /**
   * Отдача канала, если реестр её не назвал: как {@code stream.uplink-mbps} у {@code LoadMeter}.
   */
  public static final int DEFAULT_UPLINK_MBPS = 1000;

  /** Предел памяти контейнера SFU, если реестр его не назвал: {@code mem_limit: 1g} в compose. */
  public static final int DEFAULT_SFU_MEMORY_MB = 1024;

  public MediaNode {
    if (id == null || !id.matches("[a-z][a-z0-9-]{0,15}"))
      throw new IllegalArgumentException("Media node id must be a short lowercase label: " + id);
    if (rtcUrl == null || rtcUrl.isBlank())
      throw new IllegalArgumentException("Media node " + id + " has no rtcUrl");
    if (internalUrl == null || internalUrl.isBlank())
      throw new IllegalArgumentException("Media node " + id + " has no internalUrl");
    title = title == null ? Map.of() : Map.copyOf(title);
    if (country != null) {
      country = country.trim().toUpperCase();
      if (!country.matches("[A-Z]{2}"))
        throw new IllegalArgumentException(
            "Media node " + id + " country must be ISO 3166-1 alpha-2, got " + country);
    }
    if (uplinkMbps < 1) uplinkMbps = DEFAULT_UPLINK_MBPS;
    if (cores < 0) cores = 0;
    if (loadUrl != null && loadUrl.isBlank()) loadUrl = null;
    if (sfuMetricsUrl != null && sfuMetricsUrl.isBlank()) sfuMetricsUrl = null;
    if (sfuMemoryMb < 1) sfuMemoryMb = DEFAULT_SFU_MEMORY_MB;
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
      boolean enabled) {
    this(
        id,
        control,
        title,
        rtcUrl,
        probeUrl,
        stun,
        internalUrl,
        enabled,
        null,
        0,
        0,
        null,
        null,
        0);
  }

  /**
   * Как узел называется для человека на этом языке; нет перевода — английское имя, нет его — id.
   */
  public String titleFor(String language) {
    return title.getOrDefault(language, title.getOrDefault("en", id));
  }
}
