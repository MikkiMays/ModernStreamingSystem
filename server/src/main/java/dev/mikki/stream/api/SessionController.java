package dev.mikki.stream.api;

import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.access.ServerAccess;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;
import org.springframework.web.bind.annotation.*;

/**
 * The handshake a client performs once per visit, before it shows anything but the connect screen.
 * On an open server it still happens: it is the moment the client learns the server answers at all,
 * and the answer tells it whether a password is even expected.
 */
@RestController
@RequestMapping("/api/v1/session")
public class SessionController {
  public record Connect(@Size(max = 200) String password) {}

  public record Session(String token, long expiresAt, String name, boolean passwordRequired) {}

  private final ServerAccess access;
  private final RateLimits limits;
  private final ClientAddress address;

  public SessionController(ServerAccess access, RateLimits limits, ClientAddress address) {
    this.access = access;
    this.limits = limits;
    this.address = address;
  }

  @PostMapping
  public Session connect(
      @Valid @RequestBody(required = false) Connect request, HttpServletRequest http) {
    // Guessing a password has to stay expensive even though the response itself is cheap.
    limits.check("session:" + address.of(http), 20);
    var issued = access.connect(request == null ? null : request.password());
    return new Session(issued.token(), issued.expiresAt(), access.name(), access.required());
  }
}
