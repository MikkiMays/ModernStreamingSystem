package dev.mikki.stream.access;

import jakarta.servlet.http.HttpServletRequest;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Профиль устройства — единственная «личность» Cord без учётных записей (решение 1 целевой
 * архитектуры, {@code docs/architecture/target-2026-10.md} §1.2).
 *
 * <p>ОДНО МЕСТО РАЗБОРА. Браузер держит секрет профиля в {@code cord:profile:v1} и раньше отдавал
 * его только избранному — как {@code Authorization}. Теперь тот же секрет приходит необязательным
 * заголовком {@code X-Cord-Profile} во все входы, и разбирается он здесь, а не в каждом
 * контроллере. Ядро хранит не секрет, а его хэш ({@code Member.profileHash}), и наружу хэш не
 * отдаёт никогда.
 *
 * <p>ЗАГОЛОВОК НЕОБЯЗАТЕЛЕН. Старый клиент (WinUI 0.7.x, веб из кэша) приходит без него и входит
 * как раньше; значение, не похожее на секрет, считается отсутствием, а не ошибкой: правило удобства
 * не должно ломать вход. Обход новым профилем допустим (П13) — антибот держится на адресе и PoW.
 *
 * <p>Отдельного фильтра нет: разбор стоит три строки и нужен пока только входам. Пределы на профиль
 * для всех маршрутов (E11-B) подключат этот же компонент к {@code RequestGuard}.
 */
@Component
public class Identity {
  /** Секрет профиля устройства: 43 знака base64url (32 случайных байта). */
  public static final String PROFILE = "X-Cord-Profile";

  /** Встреча, из которой выйти, чтобы войти в эту ({@code 409 ALREADY_IN_MEETING}). */
  public static final String LEAVE = "X-Cord-Leave";

  private static final Pattern SECRET = Pattern.compile("[A-Za-z0-9_-]{43}");
  private static final Pattern ROOM = Pattern.compile("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}");

  /** Кто входит: профиль и встреча, которую он согласился покинуть. */
  public Entrant entrant(HttpServletRequest request) {
    var leave = request.getHeader(LEAVE);
    return new Entrant(
        profileHash(request.getHeader(PROFILE)),
        leave != null && ROOM.matcher(leave).matches() ? leave : null);
  }

  /**
   * Хэш секрета профиля, или {@code null}, если секрета нет или он на секрет не похож.
   *
   * <p>Тот же хэш — ключ избранного ({@code favorites.profile_hash}): один профиль, одна запись.
   */
  public static String profileHash(String secret) {
    return secret != null && SECRET.matcher(secret).matches() ? Secrets.hash(secret) : null;
  }
}
