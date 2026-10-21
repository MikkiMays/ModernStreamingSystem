package dev.mikki.stream.api;

import dev.mikki.stream.access.InternalKeys;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.config.StreamProperties;
import jakarta.servlet.http.HttpServletRequest;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.util.function.Function;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Who a rate limit should be counted against. The gateway is the only hop allowed to name a
 * different address than the socket, and it proves that with the internal secret; without it the
 * header is whatever the caller typed.
 *
 * <p>КЛЮЧ, А НЕ АДРЕС (WP1-9, A1/A3 модели угроз). IPv4 считается адресом, а IPv6 — сетью /64:
 * провайдер выдаёт абоненту целую /64, и внутри неё каждый запрос может прийти с нового адреса.
 * Считай пределы по полному адресу — одна квартира получила бы бесконечно много «разных» людей.
 *
 * <p>Бот Telegram ходит в ядро со своего адреса 127.0.0.1, и все его пользователи попадали в одну
 * корзину (A11). Поэтому служба, доказавшая себя {@code X-Service-Secret} (ключ службы, {@link
 * InternalKeys}), называет, от чьего имени действует, — заголовком {@code X-Cord-Actor} ({@code
 * tg:<HMAC номера>}), и пределы считаются по нему. Без верного ключа этот заголовок ничего не
 * значит.
 */
@Component
public class ClientAddress {
  /** От чьего имени служба действует: {@code tg:<HMAC номера пользователя>}. */
  public static final String ACTOR = "X-Cord-Actor";

  private static final Pattern ACTOR_VALUE = Pattern.compile("[a-z]{2,8}:[A-Za-z0-9_-]{8,64}");

  private final StreamProperties config;

  public ClientAddress(StreamProperties config) {
    this.config = config;
  }

  /** Ключ пределов того, кто прислал запрос: адрес, сеть /64 или актор службы. */
  public String of(HttpServletRequest request) {
    return of(request::getHeader, request.getRemoteAddr());
  }

  /**
   * То же для запроса, от которого есть только заголовки и адрес сокета, — открытия WebSocket
   * ({@code RoomSocket}): шлюз ставит {@code X-Real-IP} и на него.
   */
  public String of(Function<String, String> header, String remote) {
    var actor = header.apply(ACTOR);
    if (actor != null
        && ACTOR_VALUE.matcher(actor).matches()
        && InternalKeys.isService(header.apply("X-Service-Secret"), config.internalSecret()))
      return "actor:" + actor;
    String forwarded = header.apply("X-Real-IP");
    return network(
        forwarded != null
                && Secrets.equal(header.apply("X-Internal-Secret"), config.internalSecret())
            ? forwarded
            : remote);
  }

  /**
   * Ключ пределов входящего во встречу ({@code Entrant.address}): адрес или актор службы; у
   * внутреннего вызова службы без актора — null, людских пределов у него нет.
   */
  public String entrant(HttpServletRequest request) {
    var key = of(request);
    return service(request) && !key.startsWith("actor:") ? null : key;
  }

  /** Пришёл ли запрос от нашей службы (бот, музыка): у неё свои пределы по актору. */
  public boolean service(HttpServletRequest request) {
    return InternalKeys.isService(request.getHeader("X-Service-Secret"), config.internalSecret());
  }

  /**
   * IPv4 — как есть, IPv6 — его сеть /64 ({@code 2001:db8:0:0::/64}).
   *
   * <p>Разбор только литерала: {@code ofLiteral} не ходит в DNS, а мусор возвращается как есть —
   * пусть лучше такой «адрес» будет отдельной корзиной, чем ошибкой входа.
   */
  public static String network(String address) {
    if (address == null || address.indexOf(':') < 0) return address;
    try {
      var parsed = InetAddress.ofLiteral(address.strip());
      if (!(parsed instanceof Inet6Address)) return parsed.getHostAddress();
      var bytes = parsed.getAddress();
      var out = new StringBuilder();
      for (int i = 0; i < 8; i += 2)
        out.append(Integer.toHexString(((bytes[i] & 0xff) << 8) | (bytes[i + 1] & 0xff)))
            .append(':');
      return out.append(":/64").toString();
    } catch (IllegalArgumentException e) {
      return address;
    }
  }
}
