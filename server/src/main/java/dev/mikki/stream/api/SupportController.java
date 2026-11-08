package dev.mikki.stream.api;

import dev.mikki.stream.access.AdminAccess;
import dev.mikki.stream.access.ProofOfWork;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.support.SupportService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * Поддержка (E13, T36): форма «Помощи» и очередь, из которой бот доносит обращения в Telegram
 * владельца.
 *
 * <p>Форма открыта и до пароля сервера ({@code RequestGuard.OPEN}): помощь нужнее всего тому, кто
 * застрял у двери. От потока её держат задача «не бот» на действие {@code support} и пределы на
 * адрес и на сервер ({@code stream.support}). Очередь — {@code /internal/}: её видит только служба
 * с внутренним секретом, наружу шлюз этот путь не пропускает. Владелец видит обращения и ведёт их
 * статус на странице «Активность» ({@code /api/v1/admin/support}, вход {@link AdminAccess}).
 */
@RestController
public class SupportController {
  /**
   * Тело формы. Тексты чистит и проверяет {@link SupportService}; здесь — только границы. {@code
   * issues} — «Сообщить о проблеме» (R79): что не так, словами из {@link SupportService#ISSUES}.
   */
  public record Request(
      @NotNull @Pattern(regexp = "[a-z]{2,16}") String topic,
      @NotNull @Size(max = 6000) String message,
      @Size(max = 400) String contact,
      @Size(max = SupportService.MAX_DIAGNOSTICS) String diagnostics,
      boolean consent,
      @Size(max = 8) List<String> issues) {}

  /** Новый статус обращения: «в работе», «ждём человека», «решено», «архив» — или назад. */
  public record StatusChange(@NotNull SupportService.Status status) {}

  /** Назначение, приоритет, метки (R215); {@code null} — не менять. */
  public record Update(
      @Size(max = 40) @Pattern(regexp = "[\\p{L}\\p{N}@._ -]*") String assignee,
      @Pattern(regexp = "low|normal|high|urgent") String priority,
      @Size(max = 400) String tags) {}

  /** Запись в ленту: заметка себе или что ответили человеку. */
  public record NoteRequest(
      @NotNull @Pattern(regexp = "note|reply") String kind,
      @NotNull @Size(min = 1, max = SupportService.MAX_MESSAGE) String text) {}

  /**
   * Кто действует от имени владельца: пульт флота подписывает запросы {@code owner} или {@code
   * agent} ({@code X-Cord-Admin-Actor}); без заголовка — {@code owner}.
   */
  public static final String ACTOR = "X-Cord-Admin-Actor";

  private final SupportService support;
  private final ProofOfWork proofs;
  private final ClientAddress address;
  private final StreamProperties config;
  private final AdminAccess admin;

  public SupportController(
      SupportService support,
      ProofOfWork proofs,
      ClientAddress address,
      StreamProperties config,
      AdminAccess admin) {
    this.support = support;
    this.proofs = proofs;
    this.address = address;
    this.config = config;
    this.admin = admin;
  }

  @PostMapping("/api/v1/support")
  public SupportService.Receipt submit(
      @Valid @RequestBody Request request, HttpServletRequest http) {
    var key = address.of(http);
    if (config.abuse().humanCheck() != StreamProperties.Abuse.HumanCheck.OFF)
      proofs.verify(http.getHeader(ProofOfWork.HEADER), "support", key);
    return support.submit(
        new SupportService.Submission(
            request.topic(),
            request.message(),
            request.contact(),
            request.diagnostics(),
            request.consent(),
            request.issues()),
        key);
  }

  /** Обращения, которые бот ещё не донёс до Telegram владельца. */
  @GetMapping("/internal/support/outbox")
  public List<SupportService.Outgoing> outbox() {
    return support.outbox(10);
  }

  /** Бот донёс обращение — больше его не отдавать. */
  @PostMapping("/internal/support/{id}/sent")
  public ResponseEntity<Void> sent(@PathVariable java.util.UUID id) {
    support.sent(id.toString());
    return ResponseEntity.noContent().build();
  }

  /** Кнопка под обращением в Telegram владельца: новый статус и чат, где её нажали. */
  public record TelegramStatus(
      @NotNull SupportService.Status status, @NotNull @Size(max = 64) String chat) {}

  /**
   * Кнопки «В работу» и «Решено» под обращением в Telegram владельца (E13). Бот — служба с ключом
   * службы, пароля владельца у него нет; доверие — чат: статус меняется, только если кнопку нажали
   * в том чате, куда обращения доносятся ({@code stream.support.notify-telegram-chat}). Ответ —
   * номер и статус для новой подписи под сообщением.
   */
  @PutMapping("/internal/support/{id}/status")
  public SupportService.Moved telegramStatus(
      @PathVariable java.util.UUID id, @Valid @RequestBody TelegramStatus change) {
    return support.moveFromChat(id.toString(), change.status(), change.chat());
  }

  /**
   * Ящик обращений для пульта и «Активности», новые первыми; {@code before} — время последнего на
   * прошлой странице. Без {@code status} архив не показывается.
   */
  @GetMapping("/api/v1/admin/support")
  public List<SupportService.Entry> tickets(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @RequestParam(value = "before", required = false) Long before,
      @RequestParam(required = false) SupportService.Status status,
      @RequestParam(required = false) @Pattern(regexp = "[a-z]{2,16}") String topic,
      @RequestParam(required = false) @Size(max = 40) String assignee,
      @RequestParam(required = false) @Pattern(regexp = "low|normal|high|urgent") String priority,
      @RequestParam(required = false) @Size(max = 100) String q,
      @RequestParam(required = false) Integer limit) {
    admin.require(token);
    return support.search(
        new SupportService.Filter(status, topic, assignee, priority, q, before, limit));
  }

  @GetMapping("/api/v1/admin/support/counts")
  public SupportService.Counts counts(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token) {
    admin.require(token);
    return support.counts();
  }

  @GetMapping("/api/v1/admin/support/{id}")
  public SupportService.Ticket ticket(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @PathVariable java.util.UUID id) {
    admin.require(token);
    return support.get(id.toString());
  }

  @PutMapping("/api/v1/admin/support/{id}/status")
  public ResponseEntity<Void> status(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @RequestHeader(value = ACTOR, required = false) String actor,
      @PathVariable java.util.UUID id,
      @Valid @RequestBody StatusChange change) {
    admin.require(token);
    support.setStatus(id.toString(), change.status(), actor(actor));
    return ResponseEntity.noContent().build();
  }

  @PutMapping("/api/v1/admin/support/{id}")
  public ResponseEntity<Void> update(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @RequestHeader(value = ACTOR, required = false) String actor,
      @PathVariable java.util.UUID id,
      @Valid @RequestBody Update change) {
    admin.require(token);
    support.update(
        id.toString(), change.assignee(), change.priority(), change.tags(), actor(actor));
    return ResponseEntity.noContent().build();
  }

  @PostMapping("/api/v1/admin/support/{id}/notes")
  public SupportService.Note note(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @RequestHeader(value = ACTOR, required = false) String actor,
      @PathVariable java.util.UUID id,
      @Valid @RequestBody NoteRequest note) {
    admin.require(token);
    return support.addNote(id.toString(), note.kind(), note.text(), actor(actor));
  }

  private static String actor(String header) {
    return "agent".equals(header) ? "agent" : "owner";
  }
}
