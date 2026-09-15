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

  /**
   * Sixty a minute per address on a server with a password: far too slow to guess one, and roomy
   * enough for an office where thirty people share a single address and all open Cord after a lunch
   * break. An open server has nothing to guess, so it counts nothing — the handshake there costs
   * one HMAC, the same as the `/capabilities` call beside it.
   */
  private static final int ATTEMPTS_PER_MINUTE = 60;

  @PostMapping
  public Session connect(
      @Valid @RequestBody(required = false) Connect request, HttpServletRequest http) {
    if (access.required()) limits.check("session:" + address.of(http), ATTEMPTS_PER_MINUTE);
    var issued = access.connect(request == null ? null : request.password());
    return new Session(issued.token(), issued.expiresAt(), access.name(), access.required());
  }
}
