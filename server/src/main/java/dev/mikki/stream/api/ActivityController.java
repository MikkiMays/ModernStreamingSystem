package dev.mikki.stream.api;

import dev.mikki.stream.access.AdminAccess;
import dev.mikki.stream.access.Blocks;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.activity.ActivityReport;
import dev.mikki.stream.activity.Audit;
import dev.mikki.stream.activity.Metrics;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.config.Term;
import dev.mikki.stream.room.RoomService;
import dev.mikki.stream.shared.Problem;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.Duration;
import java.util.*;
import org.springframework.web.bind.annotation.*;

/**
 * Страница владельца сервера «Активность» ({@code /activity}, E10-B): встречи сейчас и за период,
 * журнал аудита, блокировки и рычаги ({@code docs/observability.md} §12, {@code
 * docs/abuse-model.md} §5).
 *
 * <p>Вход — паролем владельца ({@code ADMIN_PASSWORD}, {@link AdminAccess}); каждый следующий
 * запрос несёт токен в {@code X-Cord-Admin}. Промахи паролем считаются тем же пределом, что промахи
 * паролем сервера ({@code per-ip.password-misses}), но отдельным счётчиком. Каждый рычаг пишется в
 * журнал: владелец сервера тоже оставляет след.
 */
@RestController
@RequestMapping("/api/v1/admin")
public class ActivityController {
  public record Login(@Size(max = 200) String password) {}

  public record Session(String token, long expiresAt) {}

  /**
   * Сервер глазами владельца: «щит», число действующих блоков, версия сборки и сроки — в
   * миллисекундах, {@code -1} — «никогда»; словами их называет страница.
   */
  public record Server(
      boolean shield,
      int blocksActive,
      String build,
      long auditMs,
      long meetingStatsMs,
      long activityDailyMs,
      long blockDefaultMs,
      Integer autoBlockCount,
      long autoBlockWindowMs,
      long autoBlockTermMs) {}

  /**
   * Кого блокировать. Либо прямо — вид и отпечаток ({@code kind}, {@code subject}: из строки
   * журнала), либо по встрече — её создателя ({@code roomId}) или участника ({@code roomId} и
   * {@code memberId}): отпечатки ядро найдёт само. Срок — словами ({@code 1 hour}, {@code 7 days},
   * {@code never}); пусто — {@code abuse.blocks.default-term}.
   */
  public record BlockRequest(
      @Pattern(regexp = "ip|profile") String kind,
      @Size(max = 64) @Pattern(regexp = "[A-Za-z0-9_-]*") String subject,
      @Pattern(regexp = "[0-9a-f-]{36}") String roomId,
      @Pattern(regexp = "[0-9a-f-]{36}") String memberId,
      @Size(max = 40) String term,
      @Size(max = 200) String reason) {}

  public record Close(boolean blockCreator, @Size(max = 40) String term) {}

  private final AdminAccess admin;
  private final ActivityReport report;
  private final Audit audit;
  private final Blocks blocks;
  private final RoomService rooms;
  private final RateLimits limits;
  private final ClientAddress address;
  private final Secrets secrets;
  private final StreamProperties config;
  private final Metrics metrics;

  public ActivityController(
      AdminAccess admin,
      ActivityReport report,
      Audit audit,
      Blocks blocks,
      RoomService rooms,
      RateLimits limits,
      ClientAddress address,
      Secrets secrets,
      StreamProperties config,
      Metrics metrics) {
    this.admin = admin;
    this.report = report;
    this.audit = audit;
    this.blocks = blocks;
    this.rooms = rooms;
    this.limits = limits;
    this.address = address;
    this.secrets = secrets;
    this.config = config;
    this.metrics = metrics;
  }

  @PostMapping("/session")
  public Session login(@Valid @RequestBody Login request, HttpServletRequest http) {
    var key = address.of(http);
    limits.check("admin-session:" + key, 30);
    var misses = config.abuse().perIp().passwordMisses();
    if (limits.exhausted("admin-miss:" + key, misses))
      throw new Problem(429, "PASSWORD_MISSES", "Слишком много неверных паролей. Попробуйте позже");
    try {
      var issued = admin.connect(request.password());
      audit.record(
          Audit.Entry.of("admin.login").actor("admin", null, null).from(fingerprint(http), null));
      return new Session(issued.token(), issued.expiresAt());
    } catch (Problem refused) {
      if (refused.status() == 401) {
        limits.hit("admin-miss:" + key, misses);
        audit.record(
            Audit.Entry.of("admin.login")
                .denied(refused.code())
                .actor("anonymous", null, null)
                .from(fingerprint(http), null));
      }
      throw refused;
    }
  }

  @GetMapping("/now")
  public ActivityReport.Now now(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token) {
    admin.require(token);
    return report.now();
  }

  @GetMapping("/meetings")
  public ActivityReport.Summary meetings(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @RequestParam long from,
      @RequestParam long to,
      @RequestParam(defaultValue = "0") int tz) {
    admin.require(token);
    if (to <= from || to - from > Duration.ofDays(400).toMillis())
      throw new IllegalArgumentException("period");
    return report.summary(from, to, tz);
  }

  @GetMapping("/audit")
  public Audit.Page audit(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @RequestParam(required = false) Long from,
      @RequestParam(required = false) Long to,
      @RequestParam(required = false) String group,
      @RequestParam(required = false) String code,
      @RequestParam(required = false) String outcome,
      @RequestParam(required = false) String ip,
      @RequestParam(required = false) String room,
      @RequestParam(required = false) String cursor,
      @RequestParam(required = false) Integer limit) {
    admin.require(token);
    return audit.query(new Audit.Filter(from, to, group, code, outcome, ip, room, cursor, limit));
  }

  @GetMapping("/server")
  public Server server(@RequestHeader(value = AdminAccess.HEADER, required = false) String token) {
    admin.require(token);
    var keep = config.retention();
    var rules = config.abuse().blocks();
    var build = System.getenv("CORD_BUILD");
    return new Server(
        rooms.shielded(),
        blocks.activeCount(),
        build == null || build.isBlank() ? null : build,
        ms(keep.audit()),
        ms(keep.meetingStats()),
        ms(keep.activityDaily()),
        ms(rules.defaultTerm()),
        rules.autoBlock().unlimited() ? null : rules.autoBlock().count(),
        ms(rules.autoBlock().period()),
        ms(rules.autoBlockTerm()));
  }

  @GetMapping("/blocks")
  public List<Blocks.Block> blocks(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token) {
    admin.require(token);
    return blocks.list();
  }

  @PostMapping("/blocks")
  public List<Blocks.Block> block(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @Valid @RequestBody BlockRequest request,
      HttpServletRequest http) {
    admin.require(token);
    var term = term(request.term());
    var subjects = new LinkedHashMap<String, String>();
    if (request.kind() != null && request.subject() != null && !request.subject().isBlank())
      subjects.put(request.kind(), request.subject());
    else if (request.roomId() != null) {
      var room = rooms.read(request.roomId());
      if (request.memberId() == null) {
        if (room.createdFrom != null) subjects.put(Blocks.IP, room.createdFrom);
        if (room.createdBy != null) subjects.put(Blocks.PROFILE, room.createdBy);
      } else {
        audit
            .lastJoin(room.id, request.memberId())
            .ifPresent(
                join -> {
                  if (join.ipHash() != null) subjects.put(Blocks.IP, join.ipHash());
                  if (join.profileHash() != null) subjects.put(Blocks.PROFILE, join.profileHash());
                });
        var profile = room.profiles.get(request.memberId());
        if (profile != null) subjects.putIfAbsent(Blocks.PROFILE, profile);
      }
    }
    if (subjects.isEmpty())
      throw new Problem(
          409,
          "BLOCK_SUBJECT_UNKNOWN",
          "Не знаю адреса и профиля этого человека: заблокировать нечего");
    var created = new ArrayList<Blocks.Block>();
    subjects.forEach(
        (kind, subject) -> {
          var block = blocks.block(kind, subject, term, request.reason(), "admin");
          metrics.blocked(kind, "admin");
          audit.record(
              Audit.Entry.of("block.created")
                  .actor("admin", null, null)
                  .from(fingerprint(http), null)
                  .room(request.roomId(), null)
                  .target(block.id())
                  .detail("kind", kind)
                  .detail("subject", subject.substring(0, Math.min(8, subject.length())))
                  .detail("until", block.expiresAt()));
          created.add(block);
        });
    return created;
  }

  @DeleteMapping("/blocks/{id}")
  public void lift(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @PathVariable UUID id,
      HttpServletRequest http) {
    admin.require(token);
    var lifted =
        blocks
            .lift(id.toString())
            .orElseThrow(() -> new Problem(404, "BLOCK_NOT_FOUND", "Блок уже снят или истёк"));
    audit.record(
        Audit.Entry.of("block.lifted")
            .actor("admin", null, null)
            .from(fingerprint(http), null)
            .target(lifted.id())
            .detail("kind", lifted.kind()));
  }

  @PostMapping("/rooms/{id}/close")
  public ActivityReport.Now close(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @PathVariable UUID id,
      @Valid @RequestBody(required = false) Close request,
      HttpServletRequest http) {
    admin.require(token);
    var room = rooms.closeByServer(id.toString());
    audit.record(
        Audit.Entry.of("admin.room_closed")
            .actor("admin", null, null)
            .from(fingerprint(http), null)
            .room(room));
    if (request != null && request.blockCreator())
      block(
          token,
          new BlockRequest(null, null, room.id, null, request.term(), "Встреча закрыта владельцем"),
          http);
    return report.now();
  }

  /** Снять «щит» досрочно (A3): вход по коду снова идёт без допуска ведущего. */
  @DeleteMapping("/shield")
  public void shield(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      HttpServletRequest http) {
    admin.require(token);
    rooms.forgetCodeMisses();
    audit.record(
        Audit.Entry.of("admin.shield_cleared")
            .actor("admin", null, null)
            .from(fingerprint(http), null));
  }

  private String fingerprint(HttpServletRequest http) {
    return secrets.address(address.of(http));
  }

  private static long ms(Duration term) {
    return term.compareTo(Term.FOREVER) >= 0 ? -1 : term.toMillis();
  }

  private static Duration term(String words) {
    if (words == null || words.isBlank()) return null;
    try {
      return Term.parse(words);
    } catch (IllegalArgumentException e) {
      throw new Problem(400, "INVALID_REQUEST", "Проверьте данные запроса");
    }
  }
}
