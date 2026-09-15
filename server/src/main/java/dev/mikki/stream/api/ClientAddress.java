package dev.mikki.stream.api;

import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.config.StreamProperties;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Component;

/**
 * Who a rate limit should be counted against. The gateway is the only hop allowed to name a
 * different address than the socket, and it proves that with the internal secret; without it the
 * header is whatever the caller typed.
 */
@Component
public class ClientAddress {
  private final StreamProperties config;

  public ClientAddress(StreamProperties config) {
    this.config = config;
  }

  public String of(HttpServletRequest request) {
    String forwarded = request.getHeader("X-Real-IP");
    return forwarded != null
            && Secrets.equal(request.getHeader("X-Internal-Secret"), config.internalSecret())
        ? forwarded
        : request.getRemoteAddr();
  }
}
