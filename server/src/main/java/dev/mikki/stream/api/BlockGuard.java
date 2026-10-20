package dev.mikki.stream.api;

import dev.mikki.stream.access.Blocks;
import dev.mikki.stream.access.Identity;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.activity.Audit;
import dev.mikki.stream.activity.Metrics;
import dev.mikki.stream.shared.Json;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import java.util.Set;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Блокировки владельца у двери — одна проверка на всё ({@code docs/abuse-model.md} §5).
 *
 * <p>КУДА НЕ ПУСКАЕТ. Любой запрос API, кроме рукопожатия ({@code ping}, {@code capabilities},
 * {@code session}: клиент должен суметь показать, что его не пускают) и страницы владельца ({@code
 * /api/v1/admin/}: владелец, заблокировавший по ошибке свой же адрес, должен суметь снять блок). И
 * подключение к SFU ({@code /internal/signaling-auth}): шлюз называет адрес клиента в {@code
 * X-Real-IP}. Все двери во встречу — создать, по ссылке, по коду, вернуться, из избранного, сокет
 * событий — за этой проверкой, поэтому обойти её новой дверью нельзя.
 *
 * <p>Наши службы без актора ({@code X-Service-Secret} без {@code X-Cord-Actor}) не проверяются: у
 * них нет адреса человека. Бот Telegram с актором — проверяется: его ключ — пользователь бота.
 *
 * <p>ПОСЛЕ ОТВЕТА — счёт отказов: каждый код ошибки в метры ({@code cord_errors_total}), а отказы
 * «слишком часто» про адрес — в автоблок ({@link Blocks#refused}).
 */
@Component
@Order(Ordered.LOWEST_PRECEDENCE)
public class BlockGuard extends OncePerRequestFilter {
  private static final Set<String> FREE =
      Set.of("/api/v1/ping", "/api/v1/capabilities", "/api/v1/session");

  private final Blocks blocks;
  private final ClientAddress address;
  private final Metrics metrics;
  private final Audit audit;
  private final Secrets secrets;

  public BlockGuard(
      Blocks blocks, ClientAddress address, Metrics metrics, Audit audit, Secrets secrets) {
    this.blocks = blocks;
    this.address = address;
    this.metrics = metrics;
    this.audit = audit;
    this.secrets = secrets;
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    var uri = request.getRequestURI();
    boolean guarded =
        (uri.startsWith("/api/v1/") && !FREE.contains(uri) && !uri.startsWith("/api/v1/admin/"))
            || uri.equals("/internal/signaling-auth");
    String key = guarded ? address.entrant(request) : null;
    if (guarded) {
      var until =
          blocks.blockedUntil(key, Identity.profileHash(request.getHeader(Identity.PROFILE)));
      if (until.isPresent()) {
        metrics.refused("BLOCKED", 403);
        response.setStatus(403);
        response.setHeader("Cache-Control", "no-store");
        response.setContentType("application/json;charset=UTF-8");
        response
            .getWriter()
            .write(
                Json.write(
                    Map.of(
                        "code",
                        "BLOCKED",
                        "detail",
                        "Доступ к этому серверу закрыт владельцем",
                        "status",
                        403,
                        "until",
                        until.get())));
        return;
      }
    }
    chain.doFilter(request, response);
    if (!(request.getAttribute(ApiErrors.CODE) instanceof String code)) return;
    metrics.refused(code, response.getStatus());
    if (guarded && response.getStatus() == 429)
      blocks
          .refused(key, code)
          .ifPresent(
              block -> {
                metrics.blocked(block.kind(), block.createdBy());
                audit.record(
                    Audit.Entry.of("block.auto")
                        .from(secrets.address(key), null)
                        .target(block.id())
                        .detail("code", code)
                        .detail("until", block.expiresAt()));
              });
  }
}
