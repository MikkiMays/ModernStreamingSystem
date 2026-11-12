package dev.mikki.stream.api;

import dev.mikki.stream.access.AdminAccess;
import dev.mikki.stream.activity.InsightReports;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import java.util.LinkedHashMap;
import java.util.regex.Pattern;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * Отчёты аналитики для пульта (R239): ядро пересылает запрос службе {@code insight} и отдаёт её
 * ответ как есть ({@link InsightReports}). Вход — тот же, что у остальной страницы владельца:
 * {@code X-Cord-Admin} ({@link AdminAccess}); пульт флота ходит сюда своим ключом мимо шлюза.
 *
 * <p>Разделы — {@code pulse}, {@code audience}, {@code acquisition}, {@code activation}, {@code
 * retention}, {@code engagement}, {@code integrations}, {@code quality}, {@code errors}, {@code
 * traffic} и {@code errors/{key}} — группа ошибок. Какие разделы есть, решает служба: незнакомый
 * раздел — её {@code 404}, новый раздел не требует выкатки ядра. Формы ответов — {@code
 * contracts/insight-reports.md}; параметры — {@code from}, {@code to}, {@code view}, {@code
 * strict}, {@code compare}.
 */
@RestController
@RequestMapping("/api/v1/admin/insight")
public class InsightController {
  /** Имя раздела — слово, а не путь. */
  private static final Pattern SECTION = Pattern.compile("[a-z][a-z0-9_-]{0,31}");

  /** Ключ группы ошибок: {@code код~область~версия} — как его строит служба. */
  private static final Pattern KEY = Pattern.compile("[A-Za-z0-9_.:~-]{1,200}");

  private final AdminAccess admin;
  private final InsightReports reports;

  public InsightController(AdminAccess admin, InsightReports reports) {
    this.admin = admin;
    this.reports = reports;
  }

  @GetMapping(value = "/{section}", produces = MediaType.APPLICATION_JSON_VALUE)
  @ApiResponse(
      responseCode = "200",
      description = "Отчёт службы аналитики как есть (contracts/insight-reports.md)",
      content =
          @Content(
              schema =
                  @Schema(
                      type = "object",
                      additionalProperties = Schema.AdditionalPropertiesValue.TRUE)))
  public ResponseEntity<byte[]> insightReport(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @PathVariable String section,
      @RequestParam(required = false) String from,
      @RequestParam(required = false) String to,
      @RequestParam(required = false) String view,
      @RequestParam(required = false) String strict,
      @RequestParam(required = false) String compare) {
    admin.require(token);
    if (!SECTION.matcher(section).matches()) throw new IllegalArgumentException("section");
    return answer(reports.report(section, null, query(from, to, view, strict, compare)));
  }

  @GetMapping(value = "/errors/{key}", produces = MediaType.APPLICATION_JSON_VALUE)
  @ApiResponse(
      responseCode = "200",
      description = "Отчёт об одной группе ошибок как есть (contracts/insight-reports.md)",
      content =
          @Content(
              schema =
                  @Schema(
                      type = "object",
                      additionalProperties = Schema.AdditionalPropertiesValue.TRUE)))
  public ResponseEntity<byte[]> insightErrorReport(
      @RequestHeader(value = AdminAccess.HEADER, required = false) String token,
      @PathVariable String key,
      @RequestParam(required = false) String from,
      @RequestParam(required = false) String to,
      @RequestParam(required = false) String view,
      @RequestParam(required = false) String strict,
      @RequestParam(required = false) String compare) {
    admin.require(token);
    if (!KEY.matcher(key).matches()) throw new IllegalArgumentException("key");
    return answer(reports.report("errors", key, query(from, to, view, strict, compare)));
  }

  private static LinkedHashMap<String, String> query(
      String from, String to, String view, String strict, String compare) {
    var query = new LinkedHashMap<String, String>();
    if (from != null) query.put("from", from);
    if (to != null) query.put("to", to);
    if (view != null) query.put("view", view);
    if (strict != null) query.put("strict", strict);
    if (compare != null) query.put("compare", compare);
    return query;
  }

  private static ResponseEntity<byte[]> answer(byte[] body) {
    return ResponseEntity.ok()
        .contentType(MediaType.APPLICATION_JSON)
        .cacheControl(CacheControl.noStore())
        .body(body);
  }
}
