package dev.mikki.stream.support;

import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.shared.Problem;
import java.text.Normalizer;
import java.time.Clock;
import java.util.*;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

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

  /** Виды записей ленты: заметка себе, что ответили человеку, смена статуса, назначение. */
  public static final List<String> NOTE_KINDS = List.of("note", "reply", "status", "assign");

  /**
   * Обращение для пульта и «Активности». {@code firstResponseDueAt}/{@code resolveDueAt} — сроки
   * SLA от создания; {@code breached} — хоть один просрочен и не закрыт.
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
      long firstResponseDueAt,
      long resolveDueAt,
      boolean breached) {}

  /** Запись ленты обращения. */
  public record Note(
      String id, String ticketId, long createdAt, String author, String kind, String text) {}

  /** Обращение с лентой — для открытого в пульте. */
  public record Ticket(Entry ticket, List<Note> notes) {}

  /** Сколько обращений в каждом статусе и сколько открытых просрочили SLA. */
  public record Counts(
      long fresh, long open, long waiting, long done, long archived, long breached) {}

  /** Чем фильтровать ящик: всё необязательно; {@code query} — по тексту, контакту и номеру. */
  public record Filter(
      Status status,
      String topic,
      String assignee,
      String priority,
      String query,
      Long before,
      Integer limit) {}

  private final JdbcClient jdbc;
  private final SupportProperties config;
  private final RateLimits limits;
  private final Secrets secrets;
  private final Clock clock;

  public SupportService(
      JdbcClient jdbc, SupportProperties config, RateLimits limits, Secrets secrets, Clock clock) {
    this.jdbc = jdbc;
    this.config = config;
    this.limits = limits;
    this.secrets = secrets;
    this.clock = clock;
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
   * Ящик: новые первыми, с фильтрами по статусу, теме, назначению, приоритету и поиском по тексту,
   * контакту и номеру (началу идентификатора). Без статуса архив не показывается — он отдельная
   * вкладка.
   */
  public List<Entry> search(Filter filter) {
    var where = new StringBuilder("WHERE created_at < ?");
    var params = new ArrayList<Object>();
    params.add(filter.before() == null ? Long.MAX_VALUE : filter.before());
    if (filter.status() != null) {
      where.append(" AND status=?");
      params.add(filter.status().word());
    } else where.append(" AND status<>'archived'");
    if (filter.topic() != null && !filter.topic().isBlank()) {
      where.append(" AND topic=?");
      params.add(filter.topic());
    }
    if (filter.assignee() != null && !filter.assignee().isBlank()) {
      where.append(" AND assignee=?");
      params.add(filter.assignee());
    }
    if (filter.priority() != null && !filter.priority().isBlank()) {
      where.append(" AND priority=?");
      params.add(filter.priority());
    }
    var query = line(filter.query());
    if (query != null) {
      // Номер — начало идентификатора в верхнем регистре: восемь знаков, которые человек назвал.
      where.append(
          " AND (LOWER(message) LIKE ? OR LOWER(contact) LIKE ? OR LOWER(id) LIKE ? OR tags LIKE ?)");
      var like = "%" + query.toLowerCase(Locale.ROOT).replace("%", "").replace("_", "") + "%";
      params.add(like);
      params.add(like);
      params.add(query.toLowerCase(Locale.ROOT) + "%");
      params.add(like);
    }
    params.add(Math.max(1, Math.min(filter.limit() == null ? 50 : filter.limit(), 200)));
    return jdbc.sql(
            "SELECT * FROM support_tickets " + where + " ORDER BY created_at DESC, id DESC LIMIT ?")
        .params(params)
        .query(this::entry)
        .list();
  }

  public Counts counts() {
    var byStatus = new HashMap<String, Long>();
    jdbc.sql("SELECT status, COUNT(*) FROM support_tickets GROUP BY status")
        .query((rs, n) -> byStatus.put(rs.getString(1), rs.getLong(2)))
        .list();
    long breached =
        search(new Filter(null, null, null, null, null, null, 200)).stream()
            .filter(Entry::breached)
            .count();
    return new Counts(
        byStatus.getOrDefault("new", 0L),
        byStatus.getOrDefault("open", 0L),
        byStatus.getOrDefault("waiting", 0L),
        byStatus.getOrDefault("done", 0L),
        byStatus.getOrDefault("archived", 0L),
        breached);
  }

  /** Обращение с лентой; нет такого — 404. */
  public Ticket get(String id) {
    var ticket =
        jdbc.sql("SELECT * FROM support_tickets WHERE id=?")
            .param(id)
            .query(this::entry)
            .optional()
            .orElseThrow(() -> new Problem(404, "SUPPORT_NOT_FOUND", "Обращение не найдено"));
    var notes =
        jdbc.sql("SELECT * FROM support_notes WHERE ticket_id=? ORDER BY created_at, id")
            .param(id)
            .query(
                (rs, n) ->
                    new Note(
                        rs.getString("id"),
                        rs.getString("ticket_id"),
                        rs.getLong("created_at"),
                        rs.getString("author"),
                        rs.getString("kind"),
                        rs.getString("text")))
            .list();
    return new Ticket(ticket, notes);
  }

  private Entry entry(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
    long createdAt = rs.getLong("created_at");
    var status = Status.of(rs.getString("status"));
    var sla = config.slaOrDefault();
    Long firstResponseAt = rs.getObject("first_response_at", Long.class);
    Long resolvedAt = rs.getObject("resolved_at", Long.class);
    long firstDue = createdAt + sla.firstResponse().toMillis();
    long resolveDue = createdAt + sla.resolve().toMillis();
    long now = clock.millis();
    boolean closed = status == Status.DONE || status == Status.ARCHIVED;
    boolean breached =
        (firstResponseAt == null && !closed && now > firstDue)
            || (resolvedAt == null && !closed && now > resolveDue);
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
        rs.getLong("status_at"),
        rs.getObject("notified_at", Long.class),
        rs.getString("assignee"),
        rs.getString("priority"),
        tags == null || tags.isBlank() ? List.of() : List.of(tags.split(" ")),
        firstResponseAt,
        resolvedAt,
        rs.getObject("archived_at", Long.class),
        firstDue,
        resolveDue,
        breached);
  }

  /** Владелец ведёт обращение: «в работе», «решено». Из Telegram и со старой «Активности». */
  public void setStatus(String id, Status status) {
    setStatus(id, status, "owner");
  }

  /**
   * Смена статуса с записью в ленту. Взятие в работу или ответ — первый ответ для SLA; {@code done}
   * ставит {@code resolved_at}, {@code archived} — {@code archived_at}; шаг назад их снимает.
   */
  public void setStatus(String id, Status status, String author) {
    long now = clock.millis();
    var sql = new StringBuilder("UPDATE support_tickets SET status=?, status_at=?");
    if (status == Status.OPEN || status == Status.WAITING)
      sql.append(", first_response_at=COALESCE(first_response_at, ").append(now).append(')');
    sql.append(
        status == Status.DONE || status == Status.ARCHIVED
            ? ", resolved_at=COALESCE(resolved_at, " + now + ")"
            : ", resolved_at=NULL");
    sql.append(status == Status.ARCHIVED ? ", archived_at=" + now : ", archived_at=NULL");
    sql.append(" WHERE id=?");
    if (jdbc.sql(sql.toString()).params(status.word(), now, id).update() == 0)
      throw new Problem(404, "SUPPORT_NOT_FOUND", "Обращение не найдено");
    note(id, author, "status", status.word(), now);
  }

  /** Назначение, приоритет, метки; {@code null} — не менять, пустая строка — снять. */
  public void update(String id, String assignee, String priority, String tags, String author) {
    var set = new ArrayList<String>();
    var params = new ArrayList<Object>();
    if (assignee != null) {
      set.add("assignee=?");
      params.add(line(assignee));
    }
    if (priority != null) {
      if (!PRIORITIES.contains(priority)) throw new IllegalArgumentException("Unknown priority");
      set.add("priority=?");
      params.add(priority);
    }
    if (tags != null) {
      set.add("tags=?");
      var words = new TreeSet<String>();
      for (var word : text(tags).toLowerCase(Locale.ROOT).split("[\\s,]+"))
        if (!word.isBlank()) words.add(word);
      var joined = String.join(" ", words);
      if (joined.length() > 200) throw new IllegalArgumentException("Tags too long");
      params.add(joined.isEmpty() ? null : joined);
    }
    if (set.isEmpty()) return;
    params.add(id);
    if (jdbc.sql("UPDATE support_tickets SET " + String.join(", ", set) + " WHERE id=?")
            .params(params)
            .update()
        == 0) throw new Problem(404, "SUPPORT_NOT_FOUND", "Обращение не найдено");
    if (assignee != null)
      note(id, author, "assign", line(assignee) == null ? "—" : line(assignee), clock.millis());
  }

  /**
   * Заметка себе ({@code note}) или что ответили человеку ({@code reply}). Ответ — первый ответ для
   * SLA и переход в «ждём человека», если обращение было новым или в работе.
   */
  public Note addNote(String id, String kind, String text, String author) {
    if (!"note".equals(kind) && !"reply".equals(kind))
      throw new IllegalArgumentException("Unknown note kind");
    var body = text(text);
    if (body.isEmpty() || body.length() > MAX_MESSAGE)
      throw new IllegalArgumentException("Note text");
    long now = clock.millis();
    var ticket = get(id).ticket();
    var note = note(id, author, kind, body, now);
    if ("reply".equals(kind)) {
      jdbc.sql(
              "UPDATE support_tickets SET first_response_at=COALESCE(first_response_at, ?) WHERE id=?")
          .params(now, id)
          .update();
      if (ticket.status() == Status.NEW || ticket.status() == Status.OPEN)
        setStatus(id, Status.WAITING, author);
    }
    return note;
  }

  private Note note(String ticketId, String author, String kind, String text, long now) {
    var note =
        new Note(
            UUID.randomUUID().toString(),
            ticketId,
            now,
            author == null ? "owner" : author,
            kind,
            text);
    jdbc.sql(
            "INSERT INTO support_notes(id,ticket_id,created_at,author,kind,text) VALUES (?,?,?,?,?,?)")
        .params(
            note.id(), note.ticketId(), note.createdAt(), note.author(), note.kind(), note.text())
        .update();
    return note;
  }

  /** Обращение после кнопки в Telegram: номер и новый статус. */
  public record Moved(String id, String number, Status status) {}

  /**
   * Кнопка в Telegram владельца (E13): тот же {@link #setStatus}, но только из чата, куда обращения
   * доносятся. Сообщение с кнопками можно переслать, а бота — добавить в другую беседу; нажатие там
   * статуса не меняет.
   */
  public Moved moveFromChat(String id, Status status, String chat) {
    var owners = config.chat();
    if (owners.isEmpty() || !owners.equals(chat == null ? "" : chat.trim()))
      throw Problem.forbidden();
    setStatus(id, status, "telegram");
    return new Moved(id, number(id), status);
  }

  /** Забыть обращения старше срока хранения; сколько забыто. */
  public int forgetOld() {
    long before = clock.millis() - config.retention().toMillis();
    jdbc.sql(
            "DELETE FROM support_notes WHERE ticket_id IN (SELECT id FROM support_tickets WHERE created_at < ?)")
        .param(before)
        .update();
    return jdbc.sql("DELETE FROM support_tickets WHERE created_at < ?").param(before).update();
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
    if (!message.isEmpty()) out.append("\n\n").append(message);
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
