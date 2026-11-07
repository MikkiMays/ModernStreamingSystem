package dev.mikki.stream.room;

import dev.mikki.stream.config.MaintenanceProperties;
import dev.mikki.stream.shared.Problem;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Технические работы (R194): окно, в которое Cord закрыт для всех, — срочное или заранее.
 *
 * <p>ЧЕМ ОТЛИЧАЕТСЯ ОТ ДРЕНАЖА. {@link Maintenance} — рычаг выкатки: новые встречи не создаются,
 * идущие доигрывают, перезапуск ядра его сбрасывает. Окно — другое обещание: в {@code startsAt}
 * встречи заканчиваются у всех, двери закрыты, человек видит страницу работ.
 *
 * <p>ПОЧЕМУ В БАЗЕ, А НЕ В ПАМЯТИ (Р-95). Дренаж живёт в памяти намеренно: поднялось новое ядро —
 * сервер снова принимает. Окну это не подходит: окно на четыре утра пропало бы от любой выкатки за
 * день до него, а идущее окно открылось бы посреди той самой выкатки, ради которой заведено. И
 * второй узел ядра должен видеть то же самое. Поэтому окно — строка в Postgres, а ядро только
 * читает её с коротким сроком свежести.
 *
 * <p>ПОЧЕМУ ЗАБЫТОЕ ОКНО НЕ ЗАКРОЕТ ПРОДУКТ НАВСЕГДА. У каждого окна есть {@code expiresAt}: конец
 * по плану плюс {@code overrun}, но не дальше {@code max-window} от начала; без конца — {@code
 * max-window}. Срок проверяет само чтение ({@link Window#phase}): ни проход расписания, ни запись в
 * базу для выхода не нужны. Опаздываем — {@link #extend}.
 *
 * <p>НЕСКОЛЬКО УЗЛОВ. Открыть окно — под общим замком ({@code system_lock}); встречи закрывает
 * секундный проход {@link Lifecycle#sweepRoom} под замком комнаты, повтор ничего не меняет.
 * Вошедший в последний миг (дверь проверена до начала, запись — после) попадает под следующий
 * проход. Переход окна в журнал пишет тот узел, чей {@code UPDATE} изменил строку, — ровно один.
 *
 * <p>ОТКАЗ БАЗЫ. Возможности сервера базы не трогали и не должны от неё зависеть: чтение окна при
 * сбое отвечает последним известным состоянием, а чтений сверх одного в секунду на узел не бывает.
 */
@Component
public class MaintenanceWindows {
  private static final Logger log = LoggerFactory.getLogger(MaintenanceWindows.class);

  /** Сколько прочитанное окно считается свежим: столько узнаёт об окне другой узел. */
  private static final long FRESH_NANOS = 1_000_000_000L;

  public static final String EMERGENCY = "emergency";
  public static final String SCHEDULED = "scheduled";

  /** Что окно значит прямо сейчас. */
  public enum Phase {
    /** Заранее: до начала продукт живёт как обычно, окно — только данные. */
    SCHEDULED,
    /** Срочные работы, отсрочка: новых встреч нет, идущие ещё идут, вход в них открыт. */
    GRACE,
    /** Окно идёт: встречи закончены, двери закрыты. */
    ACTIVE;

    public String wire() {
      return name().toLowerCase(java.util.Locale.ROOT);
    }
  }

  /** Открытое окно; времена — мс от эпохи (UTC). */
  public record Window(
      String id,
      String kind,
      long startsAt,
      Long endsAt,
      long expiresAt,
      String reason,
      long createdAt,
      Long startedAt) {
    /** Фаза на этот момент; {@code null} — срок вышел, окна больше нет, что бы ни было в базе. */
    public Phase phase(long now) {
      if (now >= expiresAt) return null;
      if (now >= startsAt) return Phase.ACTIVE;
      return EMERGENCY.equals(kind) ? Phase.GRACE : Phase.SCHEDULED;
    }
  }

  /**
   * Окно глазами клиента — без причины: она для владельца. {@code endsAt} — оценка для людей,
   * {@code expiresAt} — когда страница работ у клиента без связи перестаёт себе верить.
   */
  public record MaintenanceNotice(String phase, long startsAt, Long endsAt, long expiresAt) {}

  /** Чем кончилась команда «закрыть окно»: как и какое; окна не было — оба {@code null}. */
  public record Closed(String how, Window window) {}

  private record Read(Window window, long at) {}

  private final JdbcClient jdbc;
  private final RoomRepository rooms;
  private final Clock clock;
  private final TransactionTemplate tx;
  private final MaintenanceProperties terms;
  private final List<RoomObserver> observers;
  private final AtomicBoolean reading = new AtomicBoolean();
  private volatile Read last;

  public MaintenanceWindows(
      JdbcClient jdbc,
      RoomRepository rooms,
      Clock clock,
      TransactionTemplate tx,
      MaintenanceProperties terms,
      List<RoomObserver> observers,
      MeterRegistry registry) {
    this.jdbc = jdbc;
    this.rooms = rooms;
    this.clock = clock;
    this.tx = tx;
    this.terms = terms;
    this.observers = List.copyOf(observers);
    Gauge.builder("cord.maintenance.window", this, windows -> windows.active() ? 1 : 0)
        .description("Идут технические работы: встречи закончены, двери закрыты (1) или нет (0)")
        .register(registry);
  }

  /** Открытое окно, если его срок ещё не вышел. */
  public Optional<Window> current() {
    var window = window();
    return window != null && window.phase(clock.millis()) != null
        ? Optional.of(window)
        : Optional.empty();
  }

  public boolean active() {
    return phase() == Phase.ACTIVE;
  }

  /** Создавать встречи нельзя: окно идёт или идёт отсрочка срочных работ. */
  public boolean closesNewMeetings() {
    var phase = phase();
    return phase == Phase.ACTIVE || phase == Phase.GRACE;
  }

  private Phase phase() {
    var window = window();
    return window == null ? null : window.phase(clock.millis());
  }

  /** Что сказать клиентам: {@code capabilities}; окна нет — {@code null}. */
  public MaintenanceNotice notice() {
    var window = window();
    long now = clock.millis();
    var phase = window == null ? null : window.phase(now);
    return phase == null
        ? null
        : new MaintenanceNotice(
            phase.wire(), window.startsAt(), window.endsAt(), window.expiresAt());
  }

  /** Окно, о котором пора предупредить идущие встречи ({@code warn-before}), или {@code null}. */
  public Window warning() {
    var window = window();
    long now = clock.millis();
    return window != null
            && window.phase(now) != null
            && now >= window.startsAt() - terms.warnBefore().toMillis()
        ? window
        : null;
  }

  /** Дверь во встречу: окно идёт — отказ со сроком, по которому клиент откроет страницу работ. */
  public void requireOpenDoors() {
    var window = window();
    if (window == null || window.phase(clock.millis()) != Phase.ACTIVE) return;
    throw refusal(window);
  }

  /** Отказ на время окна: создать, войти, вернуться. */
  public Problem refusal() {
    return refusal(window());
  }

  private Problem refusal(Window window) {
    return new Problem(
        503,
        "MAINTENANCE_WINDOW",
        "Идут технические работы. Cord скоро снова заработает",
        Map.of("retryAfter", retryAfter(window)));
  }

  /** Через сколько секунд повторить: до обещанного конца, но не реже часа и не чаще полуминуты. */
  private long retryAfter(Window window) {
    long left = window == null || window.endsAt() == null ? 0 : window.endsAt() - clock.millis();
    return Math.clamp(left / 1000, 30, 3600);
  }

  /** Срочные работы: встречи кончатся через {@code graceSeconds} (пусто — {@code grace}). */
  public Window emergency(Integer graceSeconds, String endsAt, String reason) {
    long now = clock.millis();
    long grace = graceSeconds == null ? terms.grace().toMillis() : graceSeconds * 1000L;
    return open(EMERGENCY, now + grace, endsAt == null ? null : time(endsAt), reason);
  }

  /** Работы заранее: {@code startsAt} и {@code endsAt} — ISO-8601 со смещением. */
  public Window schedule(String startsAt, String endsAt, String reason) {
    long start = time(startsAt);
    if (start <= clock.millis()) throw invalid();
    return open(SCHEDULED, start, endsAt == null ? null : time(endsAt), reason);
  }

  /** Обещанный конец сдвинулся: автоматический выход сдвигается вместе с ним. */
  public Window extend(String endsAt) {
    long end = time(endsAt);
    var changed =
        tx.execute(
            status -> {
              rooms.lockGlobal();
              long now = clock.millis();
              var open = load();
              if (open == null || open.phase(now) == null)
                throw new Problem(
                    409, "MAINTENANCE_WINDOW_NONE", "Окна технических работ сейчас нет");
              long base = Math.max(now, open.startsAt());
              validate(base, end);
              long expires = expiresAt(base, end);
              jdbc.sql("UPDATE maintenance_windows SET ends_at=?, expires_at=? WHERE id=?")
                  .params(end, expires, open.id())
                  .update();
              return new Window(
                  open.id(),
                  open.kind(),
                  open.startsAt(),
                  end,
                  expires,
                  open.reason(),
                  open.createdAt(),
                  open.startedAt());
            });
    forget();
    return changed;
  }

  /** Закрыть окно: до начала — отмена, после — конец работ. Окна нет — не ошибка. */
  public Closed finish() {
    var closed =
        tx.execute(
            status -> {
              rooms.lockGlobal();
              long now = clock.millis();
              var open = load();
              if (open == null) return new Closed(null, null);
              if (open.phase(now) == null) {
                close(open, "expired", now);
                return new Closed(null, null);
              }
              var how = now >= open.startsAt() ? "finished" : "cancelled";
              close(open, how, now);
              return new Closed(how, open);
            });
    forget();
    return closed;
  }

  /**
   * Секундный проход: свежее окно из базы и переходы, которых никто не просил, — началось и
   * истекло. Отказ базы проход не роняет: следующий будет через секунду.
   */
  public void tick() {
    Window window;
    try {
      window = refresh();
    } catch (DataAccessException e) {
      log.warn("Maintenance window was not read: {}", e.getClass().getSimpleName());
      return;
    }
    if (window == null) return;
    long now = clock.millis();
    var phase = window.phase(now);
    if (phase == null)
      tx.executeWithoutResult(
          status -> {
            if (close(window, "expired", now)) tell(window, "expired", now);
          });
    else if (phase == Phase.ACTIVE && window.startedAt() == null)
      tx.executeWithoutResult(
          status -> {
            int won =
                jdbc.sql(
                        "UPDATE maintenance_windows SET started_at=?"
                            + " WHERE id=? AND started_at IS NULL")
                    .params(now, window.id())
                    .update();
            if (won == 1) tell(window, "started", now);
          });
    else return;
    forget();
  }

  /** Забыть прочитанное: следующее чтение пойдёт в базу. */
  public void forget() {
    // Прочитанное не выбрасывается, а устаревает: упади база, запасом останется оно, иначе вопрос о
    // состоянии во время
    // обновления открыл бы продукт всем посреди работ (ревью R194).
    var seen = last;
    last = seen == null ? null : new Read(seen.window(), System.nanoTime() - 2 * FRESH_NANOS);
  }

  private Window open(String kind, long startsAt, Long endsAt, String reason) {
    if (endsAt != null) validate(startsAt, endsAt);
    var opened =
        tx.execute(
            status -> {
              rooms.lockGlobal();
              long now = clock.millis();
              var existing = load();
              if (existing != null) {
                if (existing.phase(now) != null)
                  throw new Problem(
                      409,
                      "MAINTENANCE_WINDOW_EXISTS",
                      "Окно технических работ уже есть. Сначала закройте его");
                close(existing, "expired", now);
              }
              var window =
                  new Window(
                      UUID.randomUUID().toString(),
                      kind,
                      startsAt,
                      endsAt,
                      expiresAt(startsAt, endsAt),
                      reason,
                      now,
                      null);
              jdbc.sql(
                      "INSERT INTO maintenance_windows(id,kind,starts_at,ends_at,expires_at,reason,"
                          + "created_at) VALUES(?,?,?,?,?,?,?)")
                  .params(
                      window.id(),
                      kind,
                      startsAt,
                      endsAt,
                      window.expiresAt(),
                      reason,
                      window.createdAt())
                  .update();
              return window;
            });
    forget();
    return opened;
  }

  /** Автоматический выход: конец плюс запас, но не дальше самого долгого окна от начала. */
  private long expiresAt(long from, Long endsAt) {
    long longest = from + terms.maxWindow().toMillis();
    return endsAt == null ? longest : Math.min(longest, endsAt + terms.overrun().toMillis());
  }

  private void validate(long from, long endsAt) {
    if (endsAt <= from || endsAt > from + terms.maxWindow().toMillis()) throw invalid();
  }

  private Problem invalid() {
    return new Problem(
        400,
        "MAINTENANCE_WINDOW_INVALID",
        "Проверьте сроки окна: ISO-8601 со смещением, начало в будущем, конец позже начала и не"
            + " дальше предела окна");
  }

  /** Время со смещением: без него «четыре утра» — неизвестно где. */
  private long time(String text) {
    try {
      return OffsetDateTime.parse(text).toInstant().toEpochMilli();
    } catch (DateTimeParseException e) {
      throw invalid();
    }
  }

  private boolean close(Window window, String how, long now) {
    return jdbc.sql(
                "UPDATE maintenance_windows SET closed_at=?, closed_how=?"
                    + " WHERE id=? AND closed_at IS NULL")
            .params(now, how, window.id())
            .update()
        == 1;
  }

  private void tell(Window window, String transition, long now) {
    for (var observer : observers) observer.maintenance(window, transition, now);
  }

  /**
   * Окно из памяти, а за свежим — в базу, и не больше одного чтения разом: на занятом пуле
   * соединений публичные возможности не должны вставать в очередь за одной и той же строкой.
   */
  private Window window() {
    var seen = last;
    if (seen != null && System.nanoTime() - seen.at() < FRESH_NANOS) return seen.window();
    if (seen != null && !reading.compareAndSet(false, true)) return seen.window();
    try {
      return refresh();
    } catch (DataAccessException e) {
      log.warn("Maintenance window was not read: {}", e.getClass().getSimpleName());
      return seen == null ? null : seen.window();
    } finally {
      reading.set(false);
    }
  }

  private Window refresh() {
    var window = load();
    last = new Read(window, System.nanoTime());
    return window;
  }

  private Window load() {
    return jdbc.sql(
            "SELECT id, kind, starts_at, ends_at, expires_at, reason, created_at, started_at"
                + " FROM maintenance_windows WHERE closed_at IS NULL"
                + " ORDER BY created_at DESC LIMIT 1")
        .query(MaintenanceWindows::row)
        .optional()
        .orElse(null);
  }

  private static Window row(ResultSet rs, int ignored) throws SQLException {
    return new Window(
        rs.getString("id"),
        rs.getString("kind"),
        rs.getLong("starts_at"),
        rs.getObject("ends_at", Long.class),
        rs.getLong("expires_at"),
        rs.getString("reason"),
        rs.getLong("created_at"),
        rs.getObject("started_at", Long.class));
  }
}
