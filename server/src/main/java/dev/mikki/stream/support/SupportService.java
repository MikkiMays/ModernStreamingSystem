package dev.mikki.stream.support;

import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Problem;
import java.text.Normalizer;
import java.time.Clock;
import java.util.*;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Обращения в поддержку (E13, T36).
 *
 * <p>КАК УСТРОЕНО. Учётных записей нет, поэтому обращение — то, что человек написал сам в форме
 * «Помощи»: тема, текст, по желанию контакт и — только с явного согласия — диагностика клиента.
 * Обращение ложится в базу (V11), бот забирает его из очереди ({@link #outbox}) и доносит в
 * Telegram владельца Cord, а страница «Активность» показывает его со статусом. Ответ — по контакту,
 * который человек оставил; без контакта обращение всё равно прочитают.
 *
 * <p>ПОЧЕМУ ОЧЕРЕДЬ, А НЕ ВЫЗОВ. Ядро не держит токен бота, а Telegram бывает недоступен. Бот сам
 * спрашивает очередь и отмечает донесённое: упал бот, отказал Telegram, выкатили службу посреди
 * отправки — обращение остаётся в очереди и уходит позже, а не теряется.
 *
 * <p>Защита — та же, что у входа во встречу (E11-B): задача «не бот» на действие {@code support},
 * предел на адрес и общий предел сервера. Адрес не хранится: {@code from_key} — HMAC его ключа.
 *
 * <p>ОДНО ОБРАЩЕНИЕ — ОДИН ПРАВЯЩИЙ. Его ведут сразу несколько мест: пульт владельца и агента,
 * кнопки Telegram, «Активность», автоархив. Каждая перемена — транзакция, начинающаяся с замка
 * строки обращения ({@code FOR UPDATE}): два одновременных шага не прочтут один и тот же прежний
 * статус — пауза SLA не удвоится, в ленте не будет двух одинаковых переходов, а перемена и её
 * строка ленты ложатся вместе.
 */
@Service
public class SupportService {
  /** Темы формы. Подписи для человека — в каталоге веба, здесь — для Telegram владельца. */
  public static final Map<String, String> TOPICS;

  static {
    var topics = new LinkedHashMap<String, String>();
    topics.put("camera", "Камера и микрофон");
    topics.put("sound", "Звук");
    topics.put("screen", "Демонстрация экрана");
    topics.put("network", "Связь и качество");
    topics.put("windows", "Приложение для Windows");
    topics.put("idea", "Идея или пожелание");
    topics.put("other", "Другое");
    topics.put("report", "Проблема во встрече");
    TOPICS = Collections.unmodifiableMap(topics);
  }

  /**
   * «Сообщить о проблеме» (R79): что не так во встрече. Тот же список, что у веба ({@code
   * core/support.ts} → {@code ISSUES}); подписи для человека — в каталоге веба, здесь — для
   * Telegram владельца.
   */
  public static final Map<String, String> ISSUES;

  static {
    var issues = new LinkedHashMap<String, String>();
    issues.put("sound", "звук обрывается");
    issues.put("screen", "показ лагает");
    issues.put("music", "не слышно музыку");
    issues.put("connect", "не подключается");
    issues.put("other", "другое");
    ISSUES = Collections.unmodifiableMap(issues);
  }

  /** Тема «Сообщить о проблеме»: у неё есть отмеченное, а подробности — по желанию. */
  public static final String REPORT = "report";

  public static final int MIN_MESSAGE = 10;
  public static final int MAX_MESSAGE = 4000;
  public static final int MAX_CONTACT = 200;
  public static final int MAX_DIAGNOSTICS = 8000;

  /** Telegram не берёт сообщение длиннее 4096 знаков. */
  static final int TELEGRAM_LIMIT = 4096;

  /**
   * Невидимое и управляющее, кроме перевода строки и табуляции: подмена направления, нулевая
   * ширина.
   */
  private static final Pattern HIDDEN = Pattern.compile("[\\p{Cf}\\p{Co}[\\p{Cc}&&[^\\n\\t]]]");

  private static final Pattern BLANK_LINES = Pattern.compile("\\n{3,}");

  /**
   * Поток обращения (R215, Р-124): пришло → в работе → ждём человека → решено → архив. Любой шаг
   * назад разрешён владельцу; кнопки Telegram знают только {@code OPEN} и {@code DONE}.
   */
  public enum Status {
    NEW,
    OPEN,
    WAITING,
    DONE,
    ARCHIVED;

    String word() {
      return name().toLowerCase(Locale.ROOT);
    }

    static Status of(String word) {
      return valueOf(word.toUpperCase(Locale.ROOT));
    }
  }

  /** Что прислала форма; проверку формы делает контроллер. */
  public record Submission(
      String topic,
      String message,
      String contact,
      String diagnostics,
      boolean consent,
      List<String> issues) {}

  /** Что человек получает в ответ: номер, по которому его обращение найдут. */
  public record Receipt(String id, String number) {}

  /** Обращение, готовое к отправке ботом. */
  public record Outgoing(String id, String chat, String text) {}

  /** Приоритеты обращения — слова; порядок — от спокойного к срочному. */
  public static final List<String> PRIORITIES = List.of("low", "normal", "high", "urgent");

  /**
   * Виды записей ленты: заметка себе, что ответили человеку, смена статуса, назначения, приоритета
   * и меток.
   */
  public static final List<String> NOTE_KINDS =
      List.of("note", "reply", "status", "assign", "priority", "tags");

  /** Как сортировать ящик: новые первыми, старые первыми, срочные первыми. */
  public enum Sort {
    NEW,
    OLD,
    PRIORITY
  }

  /**
   * Обращение для пульта и «Активности».
   *
   * <p>SLA (Р-124): {@code firstResponseDueAt} — срок первой реакции (взяли в работу, ответили или
   * решили) от создания; {@code resolveDueAt} — срок решения от создания плюс время в «ждём
   * человека» ({@code pausedMs}: пока ждём его ответа, часы стоят). {@code breached} — открытое
   * обращение просрочило хоть один срок; {@code slaMet} — у решённого оба срока соблюдены ({@code
   * null}, пока не решено).
   */
  public record Entry(
      String id,
      String number,
      long createdAt,
      String topic,
      String message,
      String contact,
      String diagnostics,
      List<String> issues,
      Status status,
      long statusAt,
      Long notifiedAt,
      String assignee,
      String priority,
      List<String> tags,
      Long firstResponseAt,
      Long resolvedAt,
      Long archivedAt,
      long pausedMs,
      long firstResponseDueAt,
      long resolveDueAt,
      boolean breached,
      Boolean slaMet) {}

  /** Запись ленты обращения; {@code id} растёт по порядку записи. */
  public record Note(
      long id, String ticketId, long createdAt, String author, String kind, String text) {}

  /** Обращение с лентой — для открытого в пульте. */
  public record Ticket(Entry ticket, List<Note> notes) {}

  /**
   * Сколько обращений в каждом статусе; {@code breached} — открытых с просроченным SLA; {@code
   * unassigned} — открытых без назначения. Открытые — новые и в работе.
   */
  public record Counts(
      long fresh,
      long open,
      long waiting,
      long done,
      long archived,
      long breached,
      long unassigned) {}

  /**
   * Качество работы за {@code days} дней по обращениям, созданным в эти дни: сколько пришло и
   * решено, медианы первой реакции и решения (минуты, без времени ожидания человека) и доля
   * решённых в срок.
   */
  public record Stats(
      int days,
      long created,
      long resolved,
      Double firstResponseMedianMinutes,
      Double resolveMedianMinutes,
      Double withinSla,
      Map<String, Long> topics) {}

  /**
   * Чем фильтровать ящик: всё необязательно. Без {@code status} — всё, кроме архива; {@code query}
   * — по тексту, контакту, номеру, меткам и ленте; {@code overdue} — только просроченные; {@code
   * assignee} {@code "-"} — без назначения.
   */
  public record Filter(
      Status status,
      String topic,
      String assignee,
      String priority,
      String query,
      Boolean overdue,
      Long before,
      Sort sort,
      Integer limit) {
    public Filter(
        Status status,
        String topic,
        String assignee,
        String priority,
        String query,
        Long before,
        Integer limit) {
      this(status, topic, assignee, priority, query, null, before, null, limit);
    }
  }

  private final JdbcClient jdbc;
  private final SupportProperties config;
  private final RateLimits limits;
  private final Secrets secrets;
  private final Clock clock;
  private final StreamProperties stream;

  public SupportService(
      JdbcClient jdbc,
      SupportProperties config,
      RateLimits limits,
      Secrets secrets,
      Clock clock,
      StreamProperties stream) {
    this.jdbc = jdbc;
    this.config = config;
    this.limits = limits;
    this.secrets = secrets;
    this.clock = clock;
    this.stream = stream;
  }

  public boolean enabled() {
    return config.enabled();
  }

  /**
   * Принять обращение от ключа адреса {@code address}. Проверку «не бот» к этому моменту прошёл
   * контроллер; текст проверяется здесь, до пределов, — опечатка не тратит предел.
   */
  public Receipt submit(Submission form, String address) {
    if (!config.enabled())
      throw new Problem(503, "SUPPORT_OFF", "Обращения сейчас не принимаются. Попробуйте позже");
    if (!TOPICS.containsKey(form.topic())) throw new IllegalArgumentException("Unknown topic");
    var issues = issues(form);
    var message = text(form.message());
    // У «Сообщить о проблеме» суть — в отмеченном; у обычного обращения — в тексте.
    if (issues.isEmpty() && message.codePointCount(0, message.length()) < MIN_MESSAGE)
      throw new Problem(
          400, "SUPPORT_TEXT", "Опишите, что случилось, — хотя бы одним предложением");
    if (message.length() > MAX_MESSAGE) throw new IllegalArgumentException("Message too long");
    var contact = line(form.contact());
    if (contact != null && contact.length() > MAX_CONTACT)
      throw new IllegalArgumentException("Contact too long");
    var diagnostics = form.diagnostics() == null ? null : form.diagnostics().strip();
    if (diagnostics != null && diagnostics.isEmpty()) diagnostics = null;
    if (diagnostics != null && (!form.consent() || diagnostics.length() > MAX_DIAGNOSTICS))
      throw new IllegalArgumentException("Diagnostics need consent");

    if (limits.exceeded("support:ip:" + address, config.perIp()))
      throw new Problem(
          429,
          "SUPPORT_RATE",
          "Из вашей сети уже пришло несколько обращений. Попробуйте через час");
    if (limits.exceeded("support:server", config.perServer()))
      throw new Problem(429, "SUPPORT_BUSY", "Сейчас обращений очень много. Попробуйте чуть позже");

    var id = UUID.randomUUID().toString();
    long now = clock.millis();
    jdbc.sql(
            "INSERT INTO support_tickets(id,created_at,topic,message,contact,diagnostics,issues,"
                + "status,status_at,from_key) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .params(
            id,
            now,
            form.topic(),
            message,
            contact,
            diagnostics,
            issues.isEmpty() ? null : String.join(",", issues),
            Status.NEW.word(),
            now,
            secrets.derive("support-from:" + address))
        .update();
    return new Receipt(id, number(id));
  }

  /**
   * Отмеченное в «Сообщить о проблеме» — по порядку списка, без повторов. Отмеченное бывает только
   * у этой темы и обязательно у неё; чужое слово — отказ, а не молча выброшенное.
   */
  static List<String> issues(Submission form) {
    var given = form.issues() == null ? List.<String>of() : form.issues();
    if (!ISSUES.keySet().containsAll(given)) throw new IllegalArgumentException("Unknown issue");
    if (REPORT.equals(form.topic()) == given.isEmpty())
      throw new IllegalArgumentException("Issues belong to a problem report");
    return ISSUES.keySet().stream().filter(given::contains).toList();
  }

  private static List<String> issues(String stored) {
    return stored == null || stored.isEmpty() ? List.of() : List.of(stored.split(","));
  }

  /**
   * Обращения, которые бот ещё не донёс, — старые первыми. Чат владельца не задан — очередь пуста:
   * обращения ждут в базе и видны на «Активности».
   */
  public List<Outgoing> outbox(int limit) {
    var chat = config.chat();
    if (chat.isEmpty()) return List.of();
    return jdbc.sql(
            "SELECT id,created_at,topic,message,contact,diagnostics,issues FROM support_tickets"
                + " WHERE notified_at IS NULL ORDER BY created_at, id LIMIT ?")
        .param(Math.max(1, Math.min(limit, 50)))
        .query(
            (rs, n) ->
                new Outgoing(
                    rs.getString("id"),
                    chat,
                    telegram(
                        rs.getString("id"),
                        rs.getString("topic"),
                        rs.getString("message"),
                        rs.getString("contact"),
                        rs.getString("diagnostics"),
                        issues(rs.getString("issues")))))
        .list();
  }

  /** Бот донёс обращение; повтор ничего не меняет. */
  public void sent(String id) {
    jdbc.sql("UPDATE support_tickets SET notified_at=? WHERE id=? AND notified_at IS NULL")
        .params(clock.millis(), id)
        .update();
  }

  /** Последние обращения, новые первыми; {@code before} — время последнего на прошлой странице. */
  public List<Entry> recent(int limit, Long before) {
    return search(new Filter(null, null, null, null, null, before, limit));
  }

  /**
   * Ящик с фильтрами и поиском. Страницы — {@code before} (время последнего на прошлой странице)
   * при сортировке «новые первыми»; при другой — первые {@code limit}.
   */
  public List<Entry> search(Filter filter) {
    var where = new StringBuilder("WHERE 1=1");
    var params = new ArrayList<Object>();
    var sort = filter.sort() == null ? Sort.NEW : filter.sort();
    if (filter.before() != null && sort == Sort.NEW) {
      where.append(" AND created_at < ?");
      params.add(filter.before());
    }
    if (filter.status() != null) {
      where.append(" AND status=?");
      params.add(filter.status().word());
    } else where.append(" AND status<>'archived'");
    if (filter.topic() != null && !filter.topic().isBlank()) {
      where.append(" AND topic=?");
      params.add(filter.topic());
    }
    var assignee = line(filter.assignee());
    if ("-".equals(assignee)) where.append(" AND assignee IS NULL");
    else if (assignee != null) {
      where.append(" AND assignee=?");
      params.add(assignee);
    }
    if (filter.priority() != null && !filter.priority().isBlank()) {
      where.append(" AND priority=?");
      params.add(filter.priority());
    }
    if (Boolean.TRUE.equals(filter.overdue())) {
      where.append(" AND ").append(OVERDUE);
      params.addAll(overdueParams());
    }
    var query = line(filter.query());
    if (query != null) {
      // Номер — начало идентификатора: восемь знаков, которые человек назвал.
      var like = "%" + query.toLowerCase(Locale.ROOT).replace("%", "").replace("_", "") + "%";
      where.append(
          " AND (LOWER(message) LIKE ? OR LOWER(contact) LIKE ? OR id LIKE ? OR tags LIKE ? OR id IN"
              + " (SELECT ticket_id FROM support_notes WHERE LOWER(text) LIKE ?))");
      params.addAll(List.of(like, like, query.toLowerCase(Locale.ROOT) + "%", like, like));
    }
    var order =
        switch (sort) {
          case NEW -> "created_at DESC, id DESC";
          case OLD -> "created_at, id";
          case PRIORITY ->
              "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,"
                  + " created_at, id";
        };
    params.add(Math.max(1, Math.min(filter.limit() == null ? 50 : filter.limit(), 200)));
    return jdbc.sql("SELECT * FROM support_tickets " + where + " ORDER BY " + order + " LIMIT ?")
        .params(params)
        .query(this::entry)
        .list();
  }

  /**
   * Открытое (новое или в работе) обращение просрочено: нет первой реакции дольше срока или не
   * решено дольше срока решения за вычетом ожидания человека. Параметры — {@link #overdueParams}.
   */
  private static final String OVERDUE =
      "status IN ('new','open') AND ((first_response_at IS NULL AND created_at < ?) OR created_at +"
          + " paused_ms < ?)";

  private List<Object> overdueParams() {
    var sla = config.slaOrDefault();
    long now = clock.millis();
    return List.of(now - sla.firstResponse().toMillis(), now - sla.resolve().toMillis());
  }

  public Counts counts() {
    var byStatus = new HashMap<String, Long>();
    jdbc.sql("SELECT status, COUNT(*) FROM support_tickets GROUP BY status")
        .query((rs, n) -> byStatus.put(rs.getString(1), rs.getLong(2)))
        .list();
    long breached =
        jdbc.sql("SELECT COUNT(*) FROM support_tickets WHERE " + OVERDUE)
            .params(overdueParams())
            .query(Long.class)
            .single();
    long unassigned =
        jdbc.sql(
                "SELECT COUNT(*) FROM support_tickets WHERE status IN ('new','open') AND assignee IS"
                    + " NULL")
            .query(Long.class)
            .single();
    return new Counts(
        byStatus.getOrDefault("new", 0L),
        byStatus.getOrDefault("open", 0L),
        byStatus.getOrDefault("waiting", 0L),
        byStatus.getOrDefault("done", 0L),
        byStatus.getOrDefault("archived", 0L),
        breached,
        unassigned);
  }

  /**
   * Качество работы за последние {@code days} дней ({@link Stats}). Читаются только сроки и тема,
   * без текстов: за год обращений с диагностикой в памяти ядра встреч набралось бы слишком много.
   */
  public Stats stats(int days) {
    long since = clock.millis() - java.time.Duration.ofDays(days).toMillis();
    var sla = config.slaOrDefault();
    var firstResponse = new ArrayList<Long>();
    var resolve = new ArrayList<Long>();
    var topics = new TreeMap<String, Long>();
    long[] totals = new long[3]; // пришло, решено, решено в срок
    jdbc.sql(
            "SELECT topic, created_at, first_response_at, resolved_at, paused_ms FROM"
                + " support_tickets WHERE created_at >= ?")
        .param(since)
        .query(
            (org.springframework.jdbc.core.RowCallbackHandler)
                rs -> {
                  long createdAt = rs.getLong("created_at");
                  Long firstResponseAt = rs.getObject("first_response_at", Long.class);
                  Long resolvedAt = rs.getObject("resolved_at", Long.class);
                  long paused = rs.getLong("paused_ms");
                  totals[0]++;
                  topics.merge(rs.getString("topic"), 1L, Long::sum);
                  if (firstResponseAt != null) firstResponse.add(firstResponseAt - createdAt);
                  if (resolvedAt != null) {
                    totals[1]++;
                    resolve.add(resolvedAt - createdAt - paused);
                    if (slaMet(sla, createdAt, firstResponseAt, resolvedAt, paused)) totals[2]++;
                  }
                });
    return new Stats(
        days,
        totals[0],
        totals[1],
        medianMinutes(firstResponse),
        medianMinutes(resolve),
        totals[1] > 0 ? totals[2] / (double) totals[1] : null,
        topics);
  }

  /**
   * Решённое — в срок: первая реакция не позже срока от создания, решение — не позже срока решения
   * плюс время в «ждём человека».
   */
  private static boolean slaMet(
      SupportProperties.Sla sla,
      long createdAt,
      Long firstResponseAt,
      long resolvedAt,
      long paused) {
    return (firstResponseAt == null
            || firstResponseAt <= createdAt + sla.firstResponse().toMillis())
        && resolvedAt <= createdAt + sla.resolve().toMillis() + paused;
  }

  private static Double medianMinutes(List<Long> millis) {
    if (millis.isEmpty()) return null;
    Collections.sort(millis);
    int n = millis.size();
    double middle =
        n % 2 == 1 ? millis.get(n / 2) : (millis.get(n / 2 - 1) + millis.get(n / 2)) / 2.0;
    return Math.max(0, middle) / 60_000.0;
  }

  /** Обращение с лентой; нет такого — 404. */
  public Ticket get(String id) {
    var ticket =
        jdbc.sql("SELECT * FROM support_tickets WHERE id=?")
            .param(id)
            .query(this::entry)
            .optional()
            .orElseThrow(SupportService::notFound);
    var notes =
        jdbc.sql("SELECT * FROM support_notes WHERE ticket_id=? ORDER BY id")
            .param(id)
            .query(
                (rs, n) ->
                    new Note(
                        rs.getLong("id"),
                        rs.getString("ticket_id"),
                        rs.getLong("created_at"),
                        rs.getString("author"),
                        rs.getString("kind"),
                        rs.getString("text")))
            .list();
    return new Ticket(ticket, notes);
  }

  private static Problem notFound() {
    return new Problem(404, "SUPPORT_NOT_FOUND", "Обращение не найдено");
  }

  private Entry entry(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
    long createdAt = rs.getLong("created_at");
    var status = Status.of(rs.getString("status"));
    var sla = config.slaOrDefault();
    long statusAt = rs.getLong("status_at");
    Long firstResponseAt = rs.getObject("first_response_at", Long.class);
    Long resolvedAt = rs.getObject("resolved_at", Long.class);
    long paused = rs.getLong("paused_ms");
    long now = clock.millis();
    // Ждём человека сейчас — это время тоже не в счёт решения.
    long pausedNow = status == Status.WAITING ? paused + Math.max(0, now - statusAt) : paused;
    long firstDue = createdAt + sla.firstResponse().toMillis();
    long resolveDue = createdAt + sla.resolve().toMillis() + pausedNow;
    boolean open = status == Status.NEW || status == Status.OPEN;
    boolean breached = open && ((firstResponseAt == null && now > firstDue) || now > resolveDue);
    Boolean slaMet =
        resolvedAt == null ? null : slaMet(sla, createdAt, firstResponseAt, resolvedAt, pausedNow);
    var tags = rs.getString("tags");
    return new Entry(
        rs.getString("id"),
        number(rs.getString("id")),
        createdAt,
        rs.getString("topic"),
        rs.getString("message"),
        rs.getString("contact"),
        rs.getString("diagnostics"),
        issues(rs.getString("issues")),
        status,
        statusAt,
        rs.getObject("notified_at", Long.class),
        rs.getString("assignee"),
        rs.getString("priority"),
        tags == null || tags.isBlank() ? List.of() : List.of(tags.split(" ")),
        firstResponseAt,
        resolvedAt,
        rs.getObject("archived_at", Long.class),
        pausedNow,
        firstDue,
        resolveDue,
        breached,
        slaMet);
  }

  /** Владелец ведёт обращение: «в работе», «решено». Из Telegram и со старой «Активности». */
  @Transactional
  public void setStatus(String id, Status status) {
    setStatus(id, status, "owner");
  }

  /**
   * Смена статуса с записью в ленту; тот же статус — ничего. Любой шаг из «нового» и ответ — первая
   * реакция для SLA; уход из «ждём человека» прибавляет ожидание к паузе SLA; {@code done} ставит
   * {@code resolved_at}, {@code archived} — {@code archived_at} (и решение, если его не было); шаг
   * назад их снимает.
   */
  @Transactional
  public void setStatus(String id, Status status, String author) {
    long now = clock.millis();
    var current =
        jdbc.sql("SELECT status, status_at FROM support_tickets WHERE id=? FOR UPDATE")
            .param(id)
            .query((rs, n) -> new Object[] {Status.of(rs.getString(1)), rs.getLong(2)})
            .optional()
            .orElseThrow(SupportService::notFound);
    var was = (Status) current[0];
    if (was == status) return;
    long paused = was == Status.WAITING ? Math.max(0, now - (long) current[1]) : 0;
    var sql =
        new StringBuilder(
            "UPDATE support_tickets SET status=?, status_at=?, paused_ms=paused_ms+?");
    var params = new ArrayList<Object>(List.of(status.word(), now, paused));
    if (status != Status.NEW) {
      sql.append(", first_response_at=COALESCE(first_response_at, ?)");
      params.add(now);
    }
    if (status == Status.DONE || status == Status.ARCHIVED) {
      sql.append(", resolved_at=COALESCE(resolved_at, ?)");
      params.add(now);
    } else
      // Вернули в работу — новые заметки снова живут до решения и суток после него (Р-134).
      sql.append(", resolved_at=NULL, content_cleared_at=NULL");
    if (status == Status.ARCHIVED) {
      sql.append(", archived_at=?");
      params.add(now);
    } else sql.append(", archived_at=NULL");
    sql.append(" WHERE id=?");
    params.add(id);
    jdbc.sql(sql.toString()).params(params).update();
    note(id, author, "status", status.word(), now);
  }

  /**
   * Назначение, приоритет, метки; {@code null} — не менять, пустая строка — снять. Каждая перемена
   * — строка в ленте; то же значение — ничего.
   */
  @Transactional
  public void update(String id, String assignee, String priority, String tags, String author) {
    lock(id);
    var before = get(id).ticket();
    long now = clock.millis();
    if (assignee != null) {
      var value = line(assignee);
      // «-» — «без назначения» у фильтра ящика: назначить такое слово значит снять назначение.
      if ("-".equals(value)) value = null;
      if (!Objects.equals(value, before.assignee())) {
        jdbc.sql("UPDATE support_tickets SET assignee=? WHERE id=?").params(value, id).update();
        note(id, author, "assign", value == null ? "—" : value, now);
      }
    }
    if (priority != null && !priority.equals(before.priority())) {
      if (!PRIORITIES.contains(priority)) throw new IllegalArgumentException("Unknown priority");
      jdbc.sql("UPDATE support_tickets SET priority=? WHERE id=?").params(priority, id).update();
      note(id, author, "priority", priority, now);
    }
    if (tags != null) {
      var words = new TreeSet<String>();
      for (var word : text(tags).toLowerCase(Locale.ROOT).split("[\\s,]+"))
        if (!word.isBlank()) words.add(word);
      var joined = String.join(" ", words);
      if (joined.length() > 200) throw new IllegalArgumentException("Tags too long");
      if (!joined.equals(String.join(" ", before.tags()))) {
        jdbc.sql("UPDATE support_tickets SET tags=? WHERE id=?")
            .params(joined.isEmpty() ? null : joined, id)
            .update();
        note(id, author, "tags", joined.isEmpty() ? "—" : joined, now);
      }
    }
  }

  /**
   * Заметка себе ({@code note}) или что ответили человеку ({@code reply}). Ответ — первая реакция
   * для SLA и переход в «ждём человека», если обращение было новым или в работе.
   */
  @Transactional
  public Note addNote(String id, String kind, String text, String author) {
    if (!"note".equals(kind) && !"reply".equals(kind))
      throw new IllegalArgumentException("Unknown note kind");
    var body = text(text);
    if (body.isEmpty() || body.length() > MAX_MESSAGE)
      throw new IllegalArgumentException("Note text");
    lock(id);
    var ticket = get(id).ticket();
    long now = clock.millis();
    var note = note(id, author, kind, body, now);
    if ("reply".equals(kind)) {
      jdbc.sql(
              "UPDATE support_tickets SET first_response_at=COALESCE(first_response_at, ?) WHERE"
                  + " id=?")
          .params(now, id)
          .update();
      if (ticket.status() == Status.NEW || ticket.status() == Status.OPEN)
        setStatus(id, Status.WAITING, author);
    }
    return note;
  }

  /** Замок строки обращения до конца транзакции; нет такого — 404. */
  private void lock(String id) {
    jdbc.sql("SELECT id FROM support_tickets WHERE id=? FOR UPDATE")
        .param(id)
        .query(String.class)
        .optional()
        .orElseThrow(SupportService::notFound);
  }

  private Note note(String ticketId, String author, String kind, String text, long now) {
    var who = author == null ? "owner" : author;
    var keys = new org.springframework.jdbc.support.GeneratedKeyHolder();
    jdbc.sql("INSERT INTO support_notes(ticket_id,created_at,author,kind,text) VALUES (?,?,?,?,?)")
        .params(ticketId, now, who, kind, text)
        .update(keys, "id");
    return new Note(keys.getKeyAs(Long.class), ticketId, now, who, kind, text);
  }

  /** Обращение после кнопки в Telegram: номер и новый статус. */
  public record Moved(String id, String number, Status status) {}

  /**
   * Кнопка в Telegram владельца (E13): тот же {@link #setStatus}, но только из чата, куда обращения
   * доносятся. Сообщение с кнопками можно переслать, а бота — добавить в другую беседу; нажатие там
   * статуса не меняет.
   */
  @Transactional
  public Moved moveFromChat(String id, Status status, String chat) {
    var owners = config.chat();
    if (owners.isEmpty() || !owners.equals(chat == null ? "" : chat.trim()))
      throw Problem.forbidden();
    setStatus(id, status, "telegram");
    return new Moved(id, number(id), status);
  }

  /**
   * Текст решённого обращения — до решения и ещё сутки (Р-134 (в), {@code
   * stream.retention.content}): у обращений в «решено» и «архиве» дольше этого текст, диагностика и
   * тексты ленты становятся {@code null}, а тема, статус, время, контакт, метки и узел остаются
   * метаданными до {@code stream.support.retention}. Открытое обращение текст держит — по нему ещё
   * работают. Вернули из архива в работу — текста уже нет, и это честно: он ушёл в срок. Сколько
   * обращений очищено.
   */
  @Transactional
  public int forgetResolvedText() {
    long now = clock.millis();
    long before = now - stream.retention().content().toMillis();
    var ids =
        jdbc.sql(
                "SELECT id FROM support_tickets WHERE status IN ('done','archived') AND"
                    + " content_cleared_at IS NULL AND COALESCE(resolved_at, archived_at, status_at)"
                    + " <= ?")
            .param(before)
            .query(String.class)
            .list();
    for (var id : ids) {
      jdbc.sql(
              "UPDATE support_tickets SET message=NULL, diagnostics=NULL, content_cleared_at=?"
                  + " WHERE id=?")
          .params(now, id)
          .update();
      jdbc.sql("UPDATE support_notes SET text=NULL WHERE ticket_id=?").param(id).update();
    }
    // Заметка, дописанная к уже очищенному решённому обращению, живёт сутки от записи.
    jdbc.sql(
            "UPDATE support_notes SET text=NULL WHERE text IS NOT NULL AND created_at<=? AND"
                + " ticket_id IN (SELECT id FROM support_tickets WHERE content_cleared_at IS NOT"
                + " NULL)")
        .param(before)
        .update();
    return ids.size();
  }

  /** Забыть обращения старше срока хранения вместе с их лентой; сколько забыто. */
  @Transactional
  public int forgetOld() {
    long before = clock.millis() - config.retention().toMillis();
    jdbc.sql(
            "DELETE FROM support_notes WHERE ticket_id IN (SELECT id FROM support_tickets WHERE"
                + " created_at < ?)")
        .param(before)
        .update();
    return jdbc.sql("DELETE FROM support_tickets WHERE created_at < ?").param(before).update();
  }

  /**
   * Решённое дольше {@code stream.support.auto-archive} уходит в архив само — ящик остаётся рабочим
   * списком; сколько убрано. Срок — от перехода в «решено» ({@code status_at}), а не от первого
   * решения: обращение, которое владелец вернул из архива, не уходит туда же в следующий час.
   */
  @Transactional
  public int archiveResolved() {
    long now = clock.millis();
    var ids =
        jdbc.sql("SELECT id FROM support_tickets WHERE status='done' AND status_at < ?")
            .param(now - config.autoArchiveOrDefault().toMillis())
            .query(String.class)
            .list();
    for (var id : ids) setStatus(id, Status.ARCHIVED, "system");
    return ids.size();
  }

  /** Номер для человека и для владельца — начало идентификатора, восемь знаков. */
  static String number(String id) {
    return id.substring(0, 8).toUpperCase(Locale.ROOT);
  }

  /**
   * Текст для Telegram владельца — без разметки: так ничего из написанного человеком не станет
   * ссылкой или жирным, и Telegram не откажет из-за незакрытого знака.
   */
  static String telegram(
      String id,
      String topic,
      String message,
      String contact,
      String diagnostics,
      List<String> issues) {
    var out = new StringBuilder();
    out.append("Обращение ")
        .append(number(id))
        .append(" · ")
        .append(TOPICS.getOrDefault(topic, topic));
    if (!issues.isEmpty())
      out.append("\nЧто не так: ")
          .append(String.join(", ", issues.stream().map(i -> ISSUES.getOrDefault(i, i)).toList()));
    if (message != null && !message.isEmpty()) out.append("\n\n").append(message);
    out.append("\n\nКонтакт: ").append(contact == null ? "не оставлен" : contact);
    if (diagnostics != null) out.append("\n\nДиагностика:\n").append(diagnostics);
    if (out.length() <= TELEGRAM_LIMIT) return out.toString();
    return out.substring(0, TELEGRAM_LIMIT - 1) + "…";
  }

  /** Текст обращения: NFC, без невидимого, один вид перевода строки, без пустых хвостов. */
  static String text(String value) {
    if (value == null) return "";
    var text = Normalizer.normalize(value, Normalizer.Form.NFC).replace("\r\n", "\n");
    text = HIDDEN.matcher(text.replace('\r', '\n')).replaceAll("");
    return BLANK_LINES.matcher(text).replaceAll("\n\n").strip();
  }

  /** Одна строка: контакт. Пусто — {@code null}. */
  static String line(String value) {
    var text = text(value).replaceAll("\\s+", " ");
    return text.isEmpty() ? null : text;
  }
}
