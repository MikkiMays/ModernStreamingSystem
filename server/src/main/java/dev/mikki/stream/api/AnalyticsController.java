package dev.mikki.stream.api;

import dev.mikki.stream.access.AdminAccess;
import dev.mikki.stream.access.Identity;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.activity.Analytics;
import dev.mikki.stream.activity.AnalyticsReport;
import dev.mikki.stream.activity.ClientKind;
import dev.mikki.stream.config.Rate;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.time.Duration;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

/**
 * Аналитика продукта (R210): событие визита от клиента и отчёт для пульта.
 *
 * <p>{@code POST /visit} открыт до пароля сервера ({@code RequestGuard.OPEN}): открытие сайта —
 * первый контакт, он раньше любого входа. Тело — только шаг ({@code open}, {@code prejoin}); кто —
 * из {@code X-Cord-Profile}, чем — из {@code X-Cord-Client}. Без профиля запрос принимается и
 * ничего не меняет: адрес в аналитику не попадает (Р-121). Не больше {@link #PER_MINUTE} в минуту с
 * адреса: клиент шлёт два события на сессию, а за одним адресом бывает офис.
 *
 * <p>НОВЫЕ ПОСЕТИТЕЛИ — С ПРЕДЕЛОМ. Профиль — случайная строка, которую может выдумать кто угодно,
 * а ручка открыта до пароля: без предела поток случайных профилей раздул бы «новых» и таблицы на
 * 400 дней, а их запись нагрузила бы базу встреч. Поэтому профиль, которого ядро не видело с
 * запуска, засчитывается, только пока таких с адреса не больше {@link #NEW_PER_ADDRESS} и со всех
 * адресов — не больше {@link #NEW_PER_SERVER}; сверх — принято и не записано. Знакомые посетители
 * пределом новых не считаются.
 */
@RestController
@RequestMapping("/api/v1")
public class AnalyticsController {
  static final int PER_MINUTE = 30;

  /** Незнакомых профилей с одного адреса (IPv4, сеть /64) в час. */
  static final Rate NEW_PER_ADDRESS = new Rate(30, Duration.ofHours(1));

  /** Незнакомых профилей со всех адресов в минуту — потолок, который не обойти сменой адреса. */
  public static final Rate NEW_PER_SERVER = new Rate(600, Duration.ofMinutes(1));

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
    var from = address.of(http);
    limits.address("visit-ip:" + from, PER_MINUTE);
    var profile = Identity.profileHash(http.getHeader(Identity.PROFILE));
    if (profile == null) return;
    if (!analytics.recent(profile)
        && (limits.exceeded("visit-new:" + from, NEW_PER_ADDRESS)
            || limits.exceeded("visit-new", NEW_PER_SERVER))) return;
    analytics.visit(profile, ClientKind.of(http), body.stage());
  }

  /**
   * Отчёт за дни {@code from…to} включительно ({@code 2026-11-01}), по поясу аналитики, в режиме
   * {@code actual} (всё за период) или {@code ltv} (когорта периода и вся её жизнь).
   */
  @GetMapping("/admin/analytics")
  public AnalyticsReport.Report analytics(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @RequestParam String from,
      @RequestParam String to,
      @RequestParam(defaultValue = AnalyticsReport.ACTUAL) String mode) {
    admin.require(token);
    var first = date(from);
    var last = date(to);
    if (last.isBefore(first) || ChronoUnit.DAYS.between(first, last) >= AnalyticsReport.MAX_DAYS)
      throw new IllegalArgumentException("period");
    if (!AnalyticsReport.ACTUAL.equals(mode) && !AnalyticsReport.LTV.equals(mode))
      throw new IllegalArgumentException("mode");
    return report.report(first, last, mode);
  }

  private static LocalDate date(String value) {
    try {
      return LocalDate.parse(value);
    } catch (DateTimeParseException e) {
      throw new IllegalArgumentException("date", e);
    }
  }
}
