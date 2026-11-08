package dev.mikki.stream.api;

import dev.mikki.stream.access.AdminAccess;
import dev.mikki.stream.access.Identity;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.activity.Analytics;
import dev.mikki.stream.activity.AnalyticsReport;
import dev.mikki.stream.activity.ClientKind;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.time.Duration;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

/**
 * Аналитика продукта (R210): событие визита от клиента и отчёт для пульта.
 *
 * <p>{@code POST /visit} открыт до пароля сервера ({@code RequestGuard.OPEN}): открытие сайта —
 * первый контакт, он раньше любого входа. Тело — только шаг ({@code open}, {@code prejoin}); кто —
 * из {@code X-Cord-Profile}, чем — из {@code X-Cord-Client}. Не больше {@link #PER_MINUTE} в минуту
 * с адреса: клиент шлёт два события на сессию, а за одним адресом бывает офис.
 */
@RestController
@RequestMapping("/api/v1")
public class AnalyticsController {
  static final int PER_MINUTE = 30;

  public record Visit(@NotNull @Pattern(regexp = "open|prejoin") String stage) {}

  private final Analytics analytics;
  private final AnalyticsReport report;
  private final AdminAccess admin;
  private final RateLimits limits;
  private final ClientAddress address;

  public AnalyticsController(
      Analytics analytics,
      AnalyticsReport report,
      AdminAccess admin,
      RateLimits limits,
      ClientAddress address) {
    this.analytics = analytics;
    this.report = report;
    this.admin = admin;
    this.limits = limits;
    this.address = address;
  }

  @PostMapping("/visit")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void visit(@Valid @RequestBody Visit body, HttpServletRequest http) {
    var key = address.of(http);
    limits.check("visit-ip:" + key, PER_MINUTE);
    analytics.visit(
        Identity.profileHash(http.getHeader(Identity.PROFILE)),
        key,
        ClientKind.of(http),
        body.stage());
  }

  /** Отчёт за период в режиме {@code actual} (всё за период) или {@code ltv} (когорта периода). */
  @GetMapping("/admin/analytics")
  public AnalyticsReport.Report analytics(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @RequestParam long from,
      @RequestParam long to,
      @RequestParam(defaultValue = AnalyticsReport.ACTUAL) String mode) {
    admin.require(token);
    if (to <= from || to - from > Duration.ofDays(400).toMillis())
      throw new IllegalArgumentException("period");
    if (!AnalyticsReport.ACTUAL.equals(mode) && !AnalyticsReport.LTV.equals(mode))
      throw new IllegalArgumentException("mode");
    return report.report(from, to, mode);
  }
}
