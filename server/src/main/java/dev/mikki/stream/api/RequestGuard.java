package dev.mikki.stream.api;

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
   * credential, and a room credential can only be obtained through a guarded endpoint.
   */
  private static final Set<String> OPEN =
      Set.of("/api/v1/ping", "/api/v1/capabilities", "/api/v1/session", "/api/v1/events");

  private final StreamProperties config;
  private final ServerAccess access;

  public RequestGuard(StreamProperties config, ServerAccess access) {
    this.config = config;
    this.access = access;
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
    if (request.getRequestURI().startsWith("/internal/")
        && !Secrets.equal(request.getHeader("X-Internal-Secret"), config.internalSecret())) {
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
   * "arrived through the front door", not "is one of ours". A second header carrying the same
   * secret does say that — the gateway never sets it, and a caller who could guess it would already
   * hold everything the gate protects.
   */
  private boolean closed(HttpServletRequest request) {
    var uri = request.getRequestURI();
    return access.required()
        && uri.startsWith("/api/v1/")
        && !OPEN.contains(uri)
        && !Secrets.equal(request.getHeader("X-Service-Secret"), config.internalSecret())
        && !access.valid(request.getHeader("X-Cord-Session"));
  }
}
