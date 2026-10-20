package dev.mikki.stream.access;

import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Problem;
import org.springframework.stereotype.Component;

/**
 * Дверь владельца сервера: страница «Активность» и рычаги — закрыть встречу, заблокировать адрес
 * или профиль, снять «щит» (E10-B, E11-B-12).
 *
 * <p>Учётных записей в Cord нет, поэтому владелец — тот, кто знает {@code ADMIN_PASSWORD} из {@code
 * .env}. Механизм тот же, что у {@link ServerAccess}: пароль меняется на подписанный срок, токен
 * ничего не хранит на сервере и переживает перезапуск ядра. Отличия два. Срок короче — восемь
 * часов, рабочий день, а не «чтобы разговор не прервался». И в подпись входит хэш самого пароля:
 * сменил владелец пароль — все прежние токены перестали действовать, без списка отозванных.
 *
 * <p>Пароль пуст — страницы нет: ни входа, ни ответа о том, что она где-то есть ({@code 404}).
 */
@Component
public class AdminAccess {
  /**
   * Заголовок, в котором браузер владельца несёт токен. Куки нет — нечего подделывать чужой форме.
   */
  public static final String HEADER = "X-Cord-Admin";

  public static final long LIFETIME_SECONDS = 8 * 3600L;

  private final Secrets secrets;
  private final String password;

  public AdminAccess(Secrets secrets, StreamProperties config) {
    this.secrets = secrets;
    this.password = config.adminPassword() == null ? "" : config.adminPassword().trim();
  }

  public boolean enabled() {
    return !password.isEmpty();
  }

  /** Пароль на токен. Частоту попыток считает тот, кто зовёт. */
  public ServerAccess.Issued connect(String candidate) {
    requireEnabled();
    if (!Secrets.equal(candidate == null ? "" : candidate, password))
      throw new Problem(401, "ADMIN_PASSWORD_INVALID", "Неверный пароль владельца");
    long expiresAt = System.currentTimeMillis() / 1000 + LIFETIME_SECONDS;
    return new ServerAccess.Issued(expiresAt + "." + signature(expiresAt), expiresAt);
  }

  public boolean valid(String token) {
    if (!enabled() || token == null || token.isEmpty()) return false;
    int dot = token.indexOf('.');
    if (dot <= 0 || dot == token.length() - 1) return false;
    long expiresAt;
    try {
      expiresAt = Long.parseLong(token, 0, dot, 10);
    } catch (NumberFormatException e) {
      return false;
    }
    return expiresAt > System.currentTimeMillis() / 1000
        && expiresAt <= System.currentTimeMillis() / 1000 + LIFETIME_SECONDS
        && Secrets.equal(token.substring(dot + 1), signature(expiresAt));
  }

  /** Пропустить только владельца: без пароля в настройках — 404, без токена — 401. */
  public void require(String token) {
    requireEnabled();
    if (!valid(token))
      throw new Problem(401, "ADMIN_REQUIRED", "Войдите паролем владельца сервера");
  }

  private void requireEnabled() {
    if (!enabled())
      throw new Problem(404, "ADMIN_DISABLED", "Страница владельца на этом сервере выключена");
  }

  private String signature(long expiresAt) {
    return secrets.derive("admin-session:" + Secrets.hash(password) + ":" + expiresAt);
  }
}
