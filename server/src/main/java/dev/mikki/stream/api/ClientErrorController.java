package dev.mikki.stream.api;

import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.activity.ClientErrors;
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

  public ClientErrorController(RateLimits limits, ClientAddress address, ClientErrors errors) {
    this.limits = limits;
    this.address = address;
    this.errors = errors;
  }

  @PostMapping("/client-errors")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void clientErrors(
      @Valid @RequestBody ClientErrors.ErrorSummary batch, HttpServletRequest http) {
    limits.check("client-errors-ip:" + address.of(http), PER_MINUTE);
    errors.record(batch);
  }
}
