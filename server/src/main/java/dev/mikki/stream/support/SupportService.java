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
    TOPICS = Collections.unmodifiableMap(topics);
  }

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

  public enum Status {
    NEW,
    OPEN,
    DONE;

    String word() {
      return name().toLowerCase(Locale.ROOT);
    }

    static Status of(String word) {
      return valueOf(word.toUpperCase(Locale.ROOT));
    }
  }

  /** Что прислала форма; проверку формы делает контроллер. */
  public record Submission(
      String topic, String message, String contact, String diagnostics, boolean consent) {}

  /** Что человек получает в ответ: номер, по которому его обращение найдут. */
  public record Receipt(String id, String number) {}

  /** Обращение, готовое к отправке ботом. */
  public record Outgoing(String id, String chat, String text) {}

  /** Обращение для страницы «Активность». */
  public record Entry(
      String id,
      String number,
      long createdAt,
      String topic,
      String message,
      String contact,
      String diagnostics,
      Status status,
      long statusAt,
      Long notifiedAt) {}

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
      throw new Problem(
          503,
          "SUPPORT_OFF",
          "Обращения сейчас не принимаются. Напишите автору Cord в Telegram — ссылка рядом");
    if (!TOPICS.containsKey(form.topic())) throw new IllegalArgumentException("Unknown topic");
    var message = text(form.message());
    if (message.codePointCount(0, message.length()) < MIN_MESSAGE)
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
          "С этого адреса уже пришло несколько обращений. Попробуйте через час или напишите автору"
              + " Cord в Telegram");
    if (limits.exceeded("support:server", config.perServer()))
      throw new Problem(429, "SUPPORT_BUSY", "Сейчас обращений очень много. Попробуйте чуть позже");

    var id = UUID.randomUUID().toString();
    long now = clock.millis();
    jdbc.sql(
            "INSERT INTO support_tickets(id,created_at,topic,message,contact,diagnostics,status,"
                + "status_at,from_key) VALUES (?,?,?,?,?,?,?,?,?)")
        .params(
            id,
            now,
            form.topic(),
            message,
            contact,
            diagnostics,
            Status.NEW.word(),
            now,
            secrets.derive("support-from:" + address))
        .update();
    return new Receipt(id, number(id));
  }

  /**
   * Обращения, которые бот ещё не донёс, — старые первыми. Чат владельца не задан — очередь пуста:
   * обращения ждут в базе и видны на «Активности».
   */
  public List<Outgoing> outbox(int limit) {
    var chat = config.chat();
    if (chat.isEmpty()) return List.of();
    return jdbc.sql(
            "SELECT id,created_at,topic,message,contact,diagnostics FROM support_tickets"
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
                        rs.getString("diagnostics"))))
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
    return jdbc.sql(
            "SELECT * FROM support_tickets WHERE created_at < ? ORDER BY created_at DESC, id DESC"
                + " LIMIT ?")
        .params(before == null ? Long.MAX_VALUE : before, Math.max(1, Math.min(limit, 100)))
        .query(
            (rs, n) -> {
              long notified = rs.getLong("notified_at");
              Long notifiedAt = rs.wasNull() ? null : notified;
              return new Entry(
                  rs.getString("id"),
                  number(rs.getString("id")),
                  rs.getLong("created_at"),
                  rs.getString("topic"),
                  rs.getString("message"),
                  rs.getString("contact"),
                  rs.getString("diagnostics"),
                  Status.of(rs.getString("status")),
                  rs.getLong("status_at"),
                  notifiedAt);
            })
        .list();
  }

  /** Владелец ведёт обращение: «в работе», «решено». */
  public void setStatus(String id, Status status) {
    if (jdbc.sql("UPDATE support_tickets SET status=?, status_at=? WHERE id=?")
            .params(status.word(), clock.millis(), id)
            .update()
        == 0) throw new Problem(404, "SUPPORT_NOT_FOUND", "Обращение не найдено");
  }

  /** Забыть обращения старше срока хранения; сколько забыто. */
  public int forgetOld() {
    return jdbc.sql("DELETE FROM support_tickets WHERE created_at < ?")
        .param(clock.millis() - config.retention().toMillis())
        .update();
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
      String id, String topic, String message, String contact, String diagnostics) {
    var out = new StringBuilder();
    out.append("Обращение ")
        .append(number(id))
        .append(" · ")
        .append(TOPICS.getOrDefault(topic, topic))
        .append("\n\n")
        .append(message)
        .append("\n\nКонтакт: ")
        .append(contact == null ? "не оставлен" : contact);
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
