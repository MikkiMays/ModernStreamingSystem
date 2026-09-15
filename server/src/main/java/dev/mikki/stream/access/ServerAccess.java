package dev.mikki.stream.access;

import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Problem;
import org.springframework.stereotype.Component;

/**
 * The door to the whole server, as distinct from the door to one room.
 *
 * <p>A room credential is a capability: whoever holds it may talk in that room. This is the step
 * before that — whether this person is allowed to create or join rooms here at all. An operator who
 * leaves {@code stream.access-password} blank keeps the server open, which is what every existing
 * installation does, so the check has to cost nothing when it is not configured.
 *
 * <p>The issued token is stateless on purpose: it survives a restart of the core, it needs no Redis
 * key per visitor, and losing it costs one handshake. It carries nothing but its own expiry, signed
 * with the session secret, so it cannot be extended by the holder.
 */
@Component
public class ServerAccess {
  /**
   * Long enough that a working day never interrupts a conversation, short enough that a leaked
   * token is not a permanent key. Clients re-handshake on their own before this runs out.
   */
  public static final long LIFETIME_SECONDS = 12 * 3600L;

  private final Secrets secrets;
  private final String password;
  private final String name;

  public ServerAccess(Secrets secrets, StreamProperties config) {
    this.secrets = secrets;
    this.password = config.accessPassword() == null ? "" : config.accessPassword().trim();
    this.name =
        config.serverName() == null || config.serverName().isBlank()
            ? "Cord"
            : config.serverName().trim();
  }

  public boolean required() {
    return !password.isEmpty();
  }

  public String name() {
    return name;
  }

  /** Exchanges the password for a token. The caller has already been rate limited. */
  public Issued connect(String candidate) {
    if (required() && !Secrets.equal(candidate == null ? "" : candidate, password))
      throw new Problem(401, "SERVER_PASSWORD_INVALID", "Неверный пароль сервера");
    long expiresAt = System.currentTimeMillis() / 1000 + LIFETIME_SECONDS;
    return new Issued(expiresAt + "." + signature(expiresAt), expiresAt);
  }

  public boolean valid(String token) {
    if (token == null || token.isEmpty()) return false;
    int dot = token.indexOf('.');
    if (dot <= 0 || dot == token.length() - 1) return false;
    long expiresAt;
    try {
      expiresAt = Long.parseLong(token, 0, dot, 10);
    } catch (NumberFormatException e) {
      return false;
    }
    return expiresAt > System.currentTimeMillis() / 1000
        && Secrets.equal(token.substring(dot + 1), signature(expiresAt));
  }

  private String signature(long expiresAt) {
    return secrets.derive("server-session:" + expiresAt);
  }

  public record Issued(String token, long expiresAt) {}
}
