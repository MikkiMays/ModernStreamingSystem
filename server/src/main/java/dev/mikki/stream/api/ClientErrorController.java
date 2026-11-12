package dev.mikki.stream.api;

import dev.mikki.stream.access.Identity;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.activity.Analytics;
import dev.mikki.stream.activity.ClientErrors;
import dev.mikki.stream.activity.ClientKind;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

/**
 * Сводка ошибок, которые видели люди ({@link ClientErrors}, R180). Пропуск встречи не нужен: ошибки
 * бывают и на главной, и на предвходе, — но дверь та же, что у остального API (пароль сервера,
 * {@code RequestGuard}). Не больше {@link #PER_MINUTE} сводок в минуту с адреса: клиент шлёт одну
 * раз в 30 с и одну при уходе, а за одним адресом бывает целый офис.
 */
@RestController
@RequestMapping("/api/v1")
public class ClientErrorController {
  static final int PER_MINUTE = 20;

  private final RateLimits limits;
  private final ClientAddress address;
  private final ClientErrors errors;
  private final Analytics analytics;

  public ClientErrorController(
      RateLimits limits, ClientAddress address, ClientErrors errors, Analytics analytics) {
    this.limits = limits;
    this.address = address;
    this.errors = errors;
    this.analytics = analytics;
  }

  @PostMapping("/client-errors")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void clientErrors(
      @Valid @RequestBody ClientErrors.ErrorSummary batch, HttpServletRequest http) {
    limits.address("client-errors-ip:" + address.of(http), PER_MINUTE);
    errors.record(batch);
    // Ошибки на сессию в аналитике (R210): только число, без мест и кодов.
    analytics.errors(
        Identity.profileHash(http.getHeader(Identity.PROFILE)),
        ClientKind.of(http),
        batch.errors().stream().mapToInt(ClientErrors.ErrorCount::count).sum());
  }
}
