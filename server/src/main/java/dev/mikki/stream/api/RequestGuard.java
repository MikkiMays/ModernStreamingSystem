package dev.mikki.stream.api;

import dev.mikki.stream.access.InternalKeys;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.access.ServerAccess;
import dev.mikki.stream.config.StreamProperties;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Set;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class RequestGuard extends OncePerRequestFilter {
  /**
   * What a client may reach before it has passed the door. Everything here either says whether the
   * server is alive and what it wants, or is the handshake itself. The events socket is on the list
   * because a browser cannot put a header on a WebSocket upgrade; its first packet carries a room
   * credential, and a room credential can only be obtained through a guarded endpoint. The server
   * catalog is public by design: it is signed offline and the client needs it before it knows any
   * server's password (ADR 0001 §8).
   *
   * <p>Поддержка (E13) — тоже до двери: помощь нужнее всего тому, кто у неё застрял. Форму держат
   * задача «не бот» ({@code /api/v1/proof} — она ничего не открывает сама) и пределы обращений.
   */
  private static final Set<String> OPEN =
      Set.of(
          "/api/v1/ping",
          "/api/v1/capabilities",
          "/api/v1/session",
          "/api/v1/events",
          // Сокет доски (R159) — как сокет событий: заголовка на нём нет, первый пакет несёт
          // пропуск.
          "/api/v1/board",
          "/api/v1/proof",
          "/api/v1/support",
          "/api/v1/catalog");

  /**
   * Картинка доски (R159): единственное тело больше 16 КиБ, которое ядро принимает само, — до
   * {@code stream.board.max-file-bytes}. Его не копирует фильтр: предел и проверку содержимого
   * держит ручка ({@code BoardController}), читая не больше предела.
   */
  private static final java.util.regex.Pattern BOARD_FILE =
      java.util.regex.Pattern.compile(
          "/api/v1/rooms/[0-9a-f-]{36}/board/files/[A-Za-z0-9_-]{1,64}");

  private final StreamProperties config;
  private final ServerAccess access;
  private final long boardFileBytes;

  public RequestGuard(StreamProperties config, ServerAccess access) {
    this(config, access, dev.mikki.stream.board.BoardProperties.defaults());
  }

  @org.springframework.beans.factory.annotation.Autowired
  public RequestGuard(
      StreamProperties config, ServerAccess access, dev.mikki.stream.board.BoardProperties board) {
    this.config = config;
    this.access = access;
    this.boardFileBytes = board.maxFileBytes();
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    var origin = request.getHeader("Origin");
    if (origin != null && !origin.equals(config.publicUrl())) {
      response.sendError(403);
      return;
    }
    // Внутренние пути — шлюзу (его заголовок — сам секрет: Caddy ключей не выводит) и нашим службам
    // (их заголовок — ключ службы, A14).
    if (request.getRequestURI().startsWith("/internal/")
        && !Secrets.equal(request.getHeader("X-Internal-Secret"), config.internalSecret())
        && !InternalKeys.isService(
            request.getHeader("X-Service-Secret"), config.internalSecret())) {
      response.sendError(403);
      return;
    }
    if (closed(request)) {
      response.setStatus(401);
      response.setContentType("application/json;charset=UTF-8");
      response
          .getWriter()
          .write(
              "{\"code\":\"SERVER_PASSWORD_REQUIRED\",\"detail\":\"Подключитесь к серверу: нужен пароль\"}");
      return;
    }
    if ("PUT".equals(request.getMethod())
        && BOARD_FILE.matcher(request.getRequestURI()).matches()) {
      if (request.getContentLengthLong() > boardFileBytes) {
        response.sendError(413);
        return;
      }
      chain.doFilter(request, response);
      return;
    }
    if (request.getContentLengthLong() > 16384) {
      response.sendError(413);
      return;
    }
    if (java.util.Set.of("POST", "PUT", "PATCH").contains(request.getMethod())) {
      byte[] body = request.getInputStream().readNBytes(16385);
      if (body.length > 16384) {
        response.sendError(413);
        return;
      }
      var wrapped =
          new HttpServletRequestWrapper(request) {
            @Override
            public ServletInputStream getInputStream() {
              var input = new ByteArrayInputStream(body);
              return new ServletInputStream() {
                @Override
                public int read() {
                  return input.read();
                }

                @Override
                public boolean isFinished() {
                  return input.available() == 0;
                }

                @Override
                public boolean isReady() {
                  return true;
                }

                @Override
                public void setReadListener(ReadListener listener) {
                  throw new UnsupportedOperationException("Synchronous MVC request");
                }
              };
            }
          };
      chain.doFilter(wrapped, response);
    } else chain.doFilter(request, response);
  }

  /**
   * On a server with a password, everything but {@link #OPEN} needs a token from the handshake.
   *
   * <p>The bots are the one caller that never performs it. They cannot be recognised by {@code
   * X-Internal-Secret}: the gateway stamps that on every browser request it forwards, so it says
   * "arrived through the front door", not "is one of ours". A second header does say that — the
   * gateway never sets it (and strips it from browsers). Its value is the service key derived from
   * the internal secret ({@link InternalKeys}, A14), so the secret itself never travels in it.
   */
  private boolean closed(HttpServletRequest request) {
    var uri = request.getRequestURI();
    return access.required()
        && uri.startsWith("/api/v1/")
        && !OPEN.contains(uri)
        // Страница владельца — за своим паролем (`AdminAccess`), сильнее пароля входа: владельцу не
        // нужно знать ещё и пароль для гостей, чтобы закрыть встречу или снять блок.
        && !uri.startsWith("/api/v1/admin/")
        && !InternalKeys.isService(request.getHeader("X-Service-Secret"), config.internalSecret())
        && !access.valid(request.getHeader("X-Cord-Session"));
  }
}
