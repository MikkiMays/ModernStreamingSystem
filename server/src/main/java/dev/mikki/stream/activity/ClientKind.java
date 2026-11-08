package dev.mikki.stream.activity;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Locale;
import java.util.Set;

/**
 * Тип клиента и операционная система — словами из перечислений (R210, Р-126).
 *
 * <p>Тип называет сам клиент заголовком {@code X-Cord-Client} ({@code web}, {@code desktop}, {@code
 * android}, {@code telegram}; {@code contracts/headers.md}); старый клиент заголовка не шлёт —
 * тогда тип угадывается по {@code User-Agent} ({@code Electron} → {@code desktop}, {@code Android}
 * → {@code android}), иначе {@code web}. Система — только из {@code User-Agent} и только словом:
 * строка агента целиком не хранится нигде (П8).
 */
public record ClientKind(String client, String os) {
  public static final String HEADER = "X-Cord-Client";

  public static final Set<String> CLIENTS =
      Set.of("web", "desktop", "android", "telegram", "other");
  public static final Set<String> SYSTEMS =
      Set.of("windows", "macos", "linux", "android", "ios", "other");

  public static final ClientKind UNKNOWN = new ClientKind("other", "other");

  public static ClientKind of(HttpServletRequest request) {
    return of(request.getHeader(HEADER), request.getHeader("User-Agent"));
  }

  public static ClientKind of(String header, String userAgent) {
    var agent = userAgent == null ? "" : userAgent;
    var client = header == null ? "" : header.trim().toLowerCase(Locale.ROOT);
    if (!CLIENTS.contains(client) || client.equals("other")) client = guess(agent);
    return new ClientKind(client, system(agent));
  }

  /** Служба, действующая от имени человека в Telegram ({@code X-Cord-Actor}): клиент — Telegram. */
  public ClientKind telegram() {
    return new ClientKind("telegram", os);
  }

  private static String guess(String agent) {
    if (agent.contains("Electron")) return "desktop";
    if (agent.contains("Android")) return "android";
    return agent.isEmpty() ? "other" : "web";
  }

  private static String system(String agent) {
    if (agent.contains("Windows")) return "windows";
    if (agent.contains("Android")) return "android";
    if (agent.contains("iPhone") || agent.contains("iPad") || agent.contains("iOS")) return "ios";
    if (agent.contains("Mac OS") || agent.contains("Macintosh")) return "macos";
    if (agent.contains("Linux") || agent.contains("X11")) return "linux";
    return "other";
  }
}
