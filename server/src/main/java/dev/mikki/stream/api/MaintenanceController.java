package dev.mikki.stream.api;

import dev.mikki.stream.access.AdminAccess;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.activity.Audit;
import dev.mikki.stream.room.MaintenanceWindows;
import dev.mikki.stream.room.MaintenanceWindows.Window;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.time.Clock;
import java.time.Instant;
import org.springframework.web.bind.annotation.*;

/**
 * Рычаги технических работ (R194, {@code docs/RELEASE.md}): срочно, заранее, сдвинуть конец,
 * закрыть.
 *
 * <p>Только API: в интерфейсе рычагов нет («пока что никак нигде не отображать»), ими пользуется
 * {@code backlog/bin/maintenance.sh}. Дверь та же, что у «Активности»: пароль владельца ({@link
 * AdminAccess}) и токен в {@code X-Cord-Admin}. Рычаги считаются пределом по адресу; каждый — в
 * журнал: кто (отпечаток адреса) и когда, номер окна и сроки. Причина свободным текстом в журнал не
 * идёт (П8): она для владельца, рядом с окном.
 *
 * <p>Времена на входе — ISO-8601 со смещением (владелец думает по Москве: {@code
 * 2026-11-10T04:00:00+03:00}), на выходе — тот же формат в UTC.
 */
@RestController
@RequestMapping("/api/v1/admin/maintenance/window")
public class MaintenanceController {
  /** Рычагов в минуту с одного адреса. Человеку и скрипту выкатки хватит с запасом. */
  private static final int LEVERS_PER_MINUTE = 30;

  /** Срочные работы: отсрочка в секундах (пусто — {@code grace}, 0 — сразу). */
  public record MaintenanceEmergency(
      @Min(0) @Max(3600) Integer graceSeconds,
      @Size(max = 40) String endsAt,
      @Size(max = 200) String reason) {}

  public record MaintenanceSchedule(
      @NotBlank @Size(max = 40) String startsAt,
      @Size(max = 40) String endsAt,
      @Size(max = 200) String reason) {}

  public record MaintenanceExtend(@NotBlank @Size(max = 40) String endsAt) {}

  /** Окно глазами владельца; {@code expiresAt} — когда оно закроется само. */
  public record MaintenanceWindowView(
      String id,
      String kind,
      String startsAt,
      String endsAt,
      String expiresAt,
      String reason,
      String createdAt,
      String startedAt) {}

  /**
   * Что сейчас: {@code phase} — {@code none}, {@code scheduled}, {@code grace}, {@code active};
   * {@code closed} — чем кончилась команда закрыть окно: {@code cancelled}, {@code finished} или
   * {@code null}, если закрывать было нечего.
   */
  public record MaintenanceWindowStatus(
      String phase, MaintenanceWindowView window, String closed, String now) {}

  private final AdminAccess admin;
  private final MaintenanceWindows windows;
  private final Audit audit;
  private final RateLimits limits;
  private final ClientAddress address;
  private final Secrets secrets;
  private final Clock clock;

  public MaintenanceController(
      AdminAccess admin,
      MaintenanceWindows windows,
      Audit audit,
      RateLimits limits,
      ClientAddress address,
      Secrets secrets,
      Clock clock) {
    this.admin = admin;
    this.windows = windows;
    this.audit = audit;
    this.limits = limits;
    this.address = address;
    this.secrets = secrets;
    this.clock = clock;
  }

  @GetMapping
  public MaintenanceWindowStatus status(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token) {
    admin.require(token);
    windows.forget();
    return answer(null);
  }

  /** Срочно: новых встреч нет сразу, идущие кончаются через отсрочку. */
  @PostMapping("/now")
  public MaintenanceWindowStatus emergency(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @Valid @RequestBody(required = false) MaintenanceEmergency request,
      HttpServletRequest http) {
    lever(token, http);
    var body = request == null ? new MaintenanceEmergency(null, null, null) : request;
    var window = windows.emergency(body.graceSeconds(), body.endsAt(), body.reason());
    record("emergency", window, http);
    return answer(null);
  }

  /** Заранее: до {@code startsAt} ничего не меняется, в {@code startsAt} встречи кончаются. */
  @PostMapping("/schedule")
  public MaintenanceWindowStatus schedule(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @Valid @RequestBody MaintenanceSchedule request,
      HttpServletRequest http) {
    lever(token, http);
    var window = windows.schedule(request.startsAt(), request.endsAt(), request.reason());
    record("schedule", window, http);
    return answer(null);
  }

  /** Опаздываем: новый обещанный конец отодвигает и автоматический выход. */
  @PostMapping("/extend")
  public MaintenanceWindowStatus extend(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @Valid @RequestBody MaintenanceExtend request,
      HttpServletRequest http) {
    lever(token, http);
    var window = windows.extend(request.endsAt());
    record("extend", window, http);
    return answer(null);
  }

  /** Закрыть окно: до начала — отмена, после — конец работ. Закрывать нечего — не ошибка. */
  @DeleteMapping
  public MaintenanceWindowStatus finish(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      HttpServletRequest http) {
    lever(token, http);
    var closed = windows.finish();
    if (closed.window() != null) record("finish", closed.window(), http);
    return answer(closed.how());
  }

  private void lever(String token, HttpServletRequest http) {
    limits.check("admin-maintenance:" + address.of(http), LEVERS_PER_MINUTE);
    admin.require(token);
  }

  private void record(String action, Window window, HttpServletRequest http) {
    audit.record(
        Audit.Entry.of("admin.maintenance_window")
            .actor("admin", null, null)
            .from(secrets.address(address.of(http)), null)
            .ip(address.ip(http))
            .target(window.id())
            .detail("do", action)
            .detail("kind", window.kind())
            .detail("graceSeconds", grace(window))
            .detail("startsAt", window.startsAt())
            .detail("endsAt", window.endsAt())
            .detail("expiresAt", window.expiresAt()));
  }

  /** Отсрочка срочных работ — для журнала: сколько встречам дали на прощание. */
  private static Long grace(Window window) {
    return MaintenanceWindows.EMERGENCY.equals(window.kind())
        ? (window.startsAt() - window.createdAt()) / 1000
        : null;
  }

  private MaintenanceWindowStatus answer(String closed) {
    long now = clock.millis();
    var window = windows.current().orElse(null);
    var phase = window == null ? null : window.phase(now);
    return new MaintenanceWindowStatus(
        phase == null ? "none" : phase.wire(), view(window), closed, iso(now));
  }

  private static MaintenanceWindowView view(Window window) {
    return window == null
        ? null
        : new MaintenanceWindowView(
            window.id(),
            window.kind(),
            iso(window.startsAt()),
            iso(window.endsAt()),
            iso(window.expiresAt()),
            window.reason(),
            iso(window.createdAt()),
            iso(window.startedAt()));
  }

  private static String iso(Long millis) {
    return millis == null ? null : Instant.ofEpochMilli(millis).toString();
  }
}
