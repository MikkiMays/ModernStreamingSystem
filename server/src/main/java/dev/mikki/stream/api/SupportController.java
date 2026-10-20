package dev.mikki.stream.api;

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
 * с внутренним секретом, наружу шлюз этот путь не пропускает.
 */
@RestController
public class SupportController {
  /** Тело формы. Тексты чистит и проверяет {@link SupportService}; здесь — только границы. */
  public record Request(
      @NotNull @Pattern(regexp = "[a-z]{2,16}") String topic,
      @NotNull @Size(max = 6000) String message,
      @Size(max = 400) String contact,
      @Size(max = SupportService.MAX_DIAGNOSTICS) String diagnostics,
      boolean consent) {}

  private final SupportService support;
  private final ProofOfWork proofs;
  private final ClientAddress address;
  private final StreamProperties config;

  public SupportController(
      SupportService support, ProofOfWork proofs, ClientAddress address, StreamProperties config) {
    this.support = support;
    this.proofs = proofs;
    this.address = address;
    this.config = config;
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
            request.consent()),
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
}
