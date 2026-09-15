package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.startsWith;
import static org.mockito.Mockito.*;

import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.access.ServerAccess;
import dev.mikki.stream.api.ClientAddress;
import dev.mikki.stream.api.RequestGuard;
import dev.mikki.stream.api.SessionController;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Problem;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.*;

class ServerAccessTest {
  private static final String SESSION_SECRET = "a-test-session-secret-of-32-chars+";
  private static final String INTERNAL_SECRET = "a-test-internal-secret-of-32-chars";

  private static StreamProperties settings(String password) {
    var config = mock(StreamProperties.class);
    when(config.sessionSecret()).thenReturn(SESSION_SECRET);
    when(config.internalSecret()).thenReturn(INTERNAL_SECRET);
    when(config.accessPassword()).thenReturn(password);
    when(config.serverName()).thenReturn("Наш Cord");
    when(config.publicUrl()).thenReturn("https://meet.example.com");
    return config;
  }

  private static ServerAccess access(String password) {
    var config = settings(password);
    return new ServerAccess(new Secrets(config), config);
  }

  @Test
  void aServerWithoutAPasswordStaysOpenAndStillIssuesASession() {
    var access = access("  ");
    assertThat(access.required()).isFalse();
    var issued = access.connect(null);
    assertThat(access.valid(issued.token())).isTrue();
    assertThat(issued.expiresAt())
        .isGreaterThan(System.currentTimeMillis() / 1000 + ServerAccess.LIFETIME_SECONDS - 60);
  }

  @Test
  void theRightPasswordOpensAndTheWrongOneDoesNot() {
    var access = access("тайна");
    assertThat(access.required()).isTrue();
    assertThat(access.valid(access.connect("тайна").token())).isTrue();
    assertThatThrownBy(() -> access.connect("тайна "))
        .isInstanceOfSatisfying(
            Problem.class, problem -> assertThat(problem.status()).isEqualTo(401));
    assertThatThrownBy(() -> access.connect(null)).isInstanceOf(Problem.class);
  }

  @Test
  void aTokenCannotBeExtendedOrInvented() {
    var access = access("тайна");
    var secrets = new Secrets(settings("тайна"));
    long expired = System.currentTimeMillis() / 1000 - 5;
    long future = System.currentTimeMillis() / 1000 + 900;
    // Correctly signed but past its time.
    assertThat(access.valid(expired + "." + secrets.derive("server-session:" + expired))).isFalse();
    // Same signature moved onto a later expiry: the expiry is what is signed.
    assertThat(access.valid(future + "." + secrets.derive("server-session:" + expired))).isFalse();
    assertThat(access.valid(future + "." + secrets.derive("server-session:" + future))).isTrue();
    for (var nonsense : new String[] {"", ".", "abc", "abc.def", "12345", "12345."})
      assertThat(access.valid(nonsense)).isFalse();
    assertThat(access.valid(null)).isFalse();
  }

  /**
   * A shared office address opening Cord after lunch must not look like an attack, and a server
   * with nothing to guess must not count guesses at all.
   */
  @Test
  void onlyAServerWithAPasswordCountsHandshakes() {
    var limits = mock(RateLimits.class);
    var request = new MockHttpServletRequest("POST", "/api/v1/session");
    var open = settings("");
    new SessionController(
            new ServerAccess(new Secrets(open), open), limits, new ClientAddress(open))
        .connect(new SessionController.Connect(null), request);
    verifyNoInteractions(limits);

    var closed = settings("тайна");
    new SessionController(
            new ServerAccess(new Secrets(closed), closed), limits, new ClientAddress(closed))
        .connect(new SessionController.Connect("тайна"), request);
    verify(limits).check(startsWith("session:"), eq(60));
  }

  @Test
  void aSignatureFromAnotherServerIsNotAccepted() {
    var other = mock(StreamProperties.class);
    when(other.sessionSecret()).thenReturn("a-different-session-secret-32char");
    long future = System.currentTimeMillis() / 1000 + 900;
    var foreign = future + "." + new Secrets(other).derive("server-session:" + future);
    assertThat(access("тайна").valid(foreign)).isFalse();
  }

  private static MockHttpServletResponse through(String password, MockHttpServletRequest request)
      throws Exception {
    var config = settings(password);
    var guard = new RequestGuard(config, new ServerAccess(new Secrets(config), config));
    var response = new MockHttpServletResponse();
    var chain = new MockFilterChain();
    guard.doFilter(request, response, chain);
    request.setAttribute("reached", chain.getRequest() != null);
    return response;
  }

  private static MockHttpServletRequest get(String uri) {
    var request = new MockHttpServletRequest("GET", uri);
    request.setRequestURI(uri);
    return request;
  }

  @Test
  void anOpenServerGuardsNothing() throws Exception {
    var request = get("/api/v1/favorites");
    assertThat(through("", request).getStatus()).isEqualTo(200);
    assertThat(request.getAttribute("reached")).isEqualTo(true);
  }

  @Test
  void theConnectScreenCanReachWhatItNeedsBeforeTheHandshake() throws Exception {
    for (var open :
        new String[] {
          "/api/v1/ping", "/api/v1/capabilities", "/api/v1/session", "/api/v1/events"
        }) {
      var request = get(open);
      assertThat(through("тайна", request).getStatus()).as(open).isEqualTo(200);
      assertThat(request.getAttribute("reached")).as(open).isEqualTo(true);
    }
  }

  @Test
  void aGuardedRequestWithoutASessionIsRefusedInAWayTheClientCanRead() throws Exception {
    var request = get("/api/v1/favorites");
    var response = through("тайна", request);
    assertThat(response.getStatus()).isEqualTo(401);
    assertThat(response.getContentAsString()).contains("SERVER_PASSWORD_REQUIRED");
    assertThat(request.getAttribute("reached")).isEqualTo(false);
  }

  @Test
  void aSessionTokenOpensTheGuardedApi() throws Exception {
    var request = get("/api/v1/favorites");
    request.addHeader("X-Cord-Session", access("тайна").connect("тайна").token());
    assertThat(through("тайна", request).getStatus()).isEqualTo(200);
    assertThat(request.getAttribute("reached")).isEqualTo(true);
  }

  /**
   * The property that decides whether the gate is worth anything: the gateway stamps
   * X-Internal-Secret on every browser request it forwards, so that header alone must never mean
   * "trusted caller". Only a caller that sets the secret itself — which no browser can — is one of
   * our services.
   */
  @Test
  void theGatewayStampOnABrowserRequestIsNotAPass() throws Exception {
    var browser = get("/api/v1/favorites");
    browser.addHeader("X-Internal-Secret", INTERNAL_SECRET);
    assertThat(through("тайна", browser).getStatus()).isEqualTo(401);

    var guessing = get("/api/v1/favorites");
    guessing.addHeader("X-Internal-Secret", INTERNAL_SECRET);
    guessing.addHeader("X-Service-Secret", "not-the-secret");
    assertThat(through("тайна", guessing).getStatus()).isEqualTo(401);

    var service = get("/api/v1/favorites");
    service.addHeader("X-Internal-Secret", INTERNAL_SECRET);
    service.addHeader("X-Service-Secret", INTERNAL_SECRET);
    assertThat(through("тайна", service).getStatus()).isEqualTo(200);
    assertThat(service.getAttribute("reached")).isEqualTo(true);
  }
}
