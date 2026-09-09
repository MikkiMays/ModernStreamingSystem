package dev.mikki.stream.api;

import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.config.StreamProperties;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class RequestGuard extends OncePerRequestFilter {
  private final StreamProperties config;

  public RequestGuard(StreamProperties config) {
    this.config = config;
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
}
