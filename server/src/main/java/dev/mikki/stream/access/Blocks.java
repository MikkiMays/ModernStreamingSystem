package dev.mikki.stream.access;

import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Problem;
import java.time.Clock;
import java.time.Duration;
import java.util.*;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Блокировки владельца сервера ({@code docs/abuse-model.md} §5, таблица {@code blocks}, V10).
 *
 * <p>ПРЕДМЕТ — ОТПЕЧАТОК. Адрес блокируется отпечатком ключа адреса ({@link Secrets#address}: IPv4
 * или сеть /64, HMAC секретом сервера), профиль устройства — хэшем его секрета. Владелец нажимает
 * «заблокировать создателя» или «заблокировать адрес из этой строки журнала» и самого адреса не
 * видит никогда (П8).
 *
 * <p>ОДНА ПРОВЕРКА. Блок проверяется у двери ({@code BlockGuard}) — перед любым запросом API, кроме
 * рукопожатия и страницы владельца, и перед подключением к SFU. Поэтому новый вход во встречу не
 * может её обойти: двери создать, по ссылке, по коду, вернуться и из избранного — все за ней.
 *
 * <p>КЭШ В ПАМЯТИ. Проверка стоит на каждом запросе, поэтому активные блоки держатся в памяти и
 * перечитываются из базы раз в {@link #CACHE_MS} (ядро одно; второй экземпляр увидит чужой блок не
 * позже этого срока). Пустой список — самый частый случай — не стоит даже HMAC.
 *
 * <p>АВТОБЛОК. Адрес, получивший {@code abuse.blocks.auto-block} отказов «слишком часто» за окно,
 * закрывается сам на {@code auto-block-term}. Считаются только отказы про адрес ({@link
 * #ADDRESS_REFUSALS}): «все комнаты заняты» — про сервер, а частота чата — про одного человека, и
 * закрывать из-за них целый офис за одним NAT нельзя. Снять — на странице «Активность».
 */
@Component
public class Blocks {
  /** Как долго список активных блоков в памяти считается свежим. */
  public static final long CACHE_MS = 10_000;

  /** Отказы, которые говорят о самом адресе, — только они ведут к автоблоку. */
  public static final Set<String> ADDRESS_REFUSALS =
      Set.of("RATE_LIMITED", "ROOMS_PER_HOUR", "OPEN_ROOMS", "CODE_MISSES", "PASSWORD_MISSES");

  public static final String IP = "ip";
  public static final String PROFILE = "profile";

  public record Block(
      String id,
      String kind,
      String subject,
      String reason,
      long createdAt,
      long expiresAt,
      String createdBy,
      Long liftedAt) {
    public boolean active(long now) {
      return liftedAt == null && expiresAt > now;
    }
  }

  private final JdbcClient jdbc;
  private final Secrets secrets;
  private final StreamProperties config;
  private final Clock clock;
  private final RateLimits limits;
  private volatile Map<String, Long> active;
  private volatile long loadedAt;

  public Blocks(
      JdbcClient jdbc, Secrets secrets, StreamProperties config, Clock clock, RateLimits limits) {
    this.jdbc = jdbc;
    this.secrets = secrets;
    this.config = config;
    this.clock = clock;
    this.limits = limits;
  }

  /** До какого момента закрыт этот адрес или профиль; пусто — открыт. */
  public Optional<Long> blockedUntil(String addressKey, String profileHash) {
    var now = clock.millis();
    var current = current(now);
    if (current.isEmpty()) return Optional.empty();
    Long until = null;
    if (addressKey != null) until = current.get(IP + ":" + secrets.address(addressKey));
    if (profileHash != null) {
      var profile = current.get(PROFILE + ":" + profileHash);
      if (profile != null && (until == null || profile > until)) until = profile;
    }
    return until != null && until > now ? Optional.of(until) : Optional.empty();
  }

  /** Отказ {@code 403 BLOCKED} с моментом окончания, если адрес или профиль закрыт. */
  public void check(String addressKey, String profileHash) {
    var until = blockedUntil(addressKey, profileHash);
    if (until.isPresent())
      throw new Problem(
          403, "BLOCKED", "Доступ к этому серверу закрыт владельцем", Map.of("until", until.get()));
  }

  /**
   * Закрыть адрес (отпечаток) или профиль на срок. {@code term} — null: срок по умолчанию; {@code
   * never} ({@code Term.FOREVER}) — навсегда.
   */
  public Block block(String kind, String subject, Duration term, String reason, String by) {
    if (!IP.equals(kind) && !PROFILE.equals(kind))
      throw new Problem(400, "INVALID_REQUEST", "Проверьте данные запроса");
    if (subject == null || subject.isBlank() || subject.length() > 64)
      throw new Problem(400, "INVALID_REQUEST", "Проверьте данные запроса");
    long now = clock.millis();
    var length = term == null ? config.abuse().blocks().defaultTerm() : term;
    var block =
        new Block(
            UUID.randomUUID().toString(),
            kind,
            subject,
            reason == null
                ? null
                : reason.strip().substring(0, Math.min(200, reason.strip().length())),
            now,
            now + length.toMillis(),
            by,
            null);
    jdbc.sql(
            "INSERT INTO blocks(id,kind,subject,reason,created_at,expires_at,created_by)"
                + " VALUES(?,?,?,?,?,?,?)")
        .params(
            block.id(),
            block.kind(),
            block.subject(),
            block.reason(),
            block.createdAt(),
            block.expiresAt(),
            block.createdBy())
        .update();
    active = null;
    return block;
  }

  /** Снять блок досрочно; пусто — такого нет или он уже не действует. */
  public Optional<Block> lift(String id) {
    long now = clock.millis();
    var found = find(id).filter(b -> b.active(now));
    found.ifPresent(
        b -> {
          jdbc.sql("UPDATE blocks SET lifted_at=? WHERE id=?").params(now, id).update();
          active = null;
        });
    return found;
  }

  public Optional<Block> find(String id) {
    return jdbc.sql("SELECT * FROM blocks WHERE id=?").param(id).query(this::map).optional();
  }

  /** Действующие блоки и снятые или истёкшие за последние сутки — для страницы владельца. */
  public List<Block> list() {
    long now = clock.millis();
    long day = Duration.ofDays(1).toMillis();
    return jdbc.sql(
            "SELECT * FROM blocks WHERE (lifted_at IS NULL AND expires_at>?) OR lifted_at>?"
                + " OR (expires_at<=? AND expires_at>?) ORDER BY created_at DESC LIMIT 500")
        .params(now, now - day, now, now - day)
        .query(this::map)
        .list();
  }

  public int activeCount() {
    return current(clock.millis()).size();
  }

  /**
   * Отказ «слишком часто» по адресу: шаг счётчика автоблока, и если он вышел за предел — блок на
   * {@code auto-block-term}. Возвращает поставленный блок; пусто — не ставили.
   */
  public Optional<Block> refused(String addressKey, String code) {
    var rules = config.abuse().blocks();
    if (addressKey == null || !ADDRESS_REFUSALS.contains(code) || rules.autoBlock().unlimited())
      return Optional.empty();
    if (!limits.exceeded("refusals:" + addressKey, rules.autoBlock())) return Optional.empty();
    if (blockedUntil(addressKey, null).isPresent()) return Optional.empty();
    var block =
        block(
            IP,
            secrets.address(addressKey),
            rules.autoBlockTerm(),
            "Автоблок: слишком много отказов подряд",
            "auto");
    // Счёт начинается заново: снятый владельцем автоблок не должен вернуться с первым же отказом.
    limits.reset("refusals:" + addressKey, rules.autoBlock());
    return Optional.of(block);
  }

  /** Строки, истёкшие больше месяца назад, журналу уже не нужны. */
  public int sweep(long now) {
    return jdbc.sql("DELETE FROM blocks WHERE expires_at<?")
        .param(now - Duration.ofDays(30).toMillis())
        .update();
  }

  private Map<String, Long> current(long now) {
    var cached = active;
    if (cached != null && now - loadedAt < CACHE_MS && now >= loadedAt) return cached;
    var loaded = new HashMap<String, Long>();
    jdbc.sql(
            "SELECT kind, subject, MAX(expires_at) FROM blocks WHERE lifted_at IS NULL AND"
                + " expires_at>? GROUP BY kind, subject")
        .param(now)
        .query(
            (rs, i) -> {
              loaded.put(rs.getString(1) + ":" + rs.getString(2), rs.getLong(3));
              return null;
            })
        .list();
    active = Map.copyOf(loaded);
    loadedAt = now;
    return active;
  }

  private Block map(java.sql.ResultSet rs, int row) throws java.sql.SQLException {
    return new Block(
        rs.getString("id"),
        rs.getString("kind"),
        rs.getString("subject"),
        rs.getString("reason"),
        rs.getLong("created_at"),
        rs.getLong("expires_at"),
        rs.getString("created_by"),
        rs.getObject("lifted_at", Long.class));
  }
}
