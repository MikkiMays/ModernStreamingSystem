package dev.mikki.stream.activity;

import static org.assertj.core.api.Assertions.*;

import dev.mikki.stream.shared.Problem;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.junit.jupiter.api.Test;

/**
 * Отчёты службы аналитики для пульта ({@link InsightReports}, {@code contracts/insight.md} §3) без
 * Spring и без сети: что уходит службе и как её отказы звучат в формате ядра.
 */
class InsightReportsTest {
  static void refused(
      org.assertj.core.api.ThrowableAssert.ThrowingCallable call,
      int status,
      String code,
      String text) {
    assertThatThrownBy(call)
        .isInstanceOfSatisfying(
            Problem.class,
            problem -> {
              assertThat(problem.status()).isEqualTo(status);
              assertThat(problem.code()).isEqualTo(code);
              if (text != null) assertThat(problem.getMessage()).isEqualTo(text);
            });
  }

  static InsightReports.Answer answer(int status, String body) {
    return new InsightReports.Answer(status, body.getBytes(StandardCharsets.UTF_8));
  }

  /** Запрос уходит службе с пятью своими параметрами, ответ возвращается как есть. */
  @Test
  void aReportIsForwardedAndReturnedUnchanged() {
    var asked = new ArrayList<URI>();
    var body = "{\"section\":\"pulse\",\"data\":{\"люди\":[1,2,3]}}";
    var reports =
        new InsightReports(
            "http://127.0.0.1:18300",
            uri -> {
              asked.add(uri);
              return answer(200, body);
            });
    var query = new LinkedHashMap<String, String>();
    query.put("from", "2026-11-01");
    query.put("to", "2026-11-12");
    query.put("view", "cohort");
    query.put("strict", "1");
    query.put("compare", "1");
    query.put("debug", "все строки");
    assertThat(new String(reports.report("pulse", null, query), StandardCharsets.UTF_8))
        .isEqualTo(body);
    assertThat(asked.getFirst().toString())
        .isEqualTo(
            "http://127.0.0.1:18300/internal/reports/pulse"
                + "?from=2026-11-01&to=2026-11-12&view=cohort&strict=1&compare=1");
    reports.report("errors", "RATE_LIMITED~guard~core", Map.of());
    assertThat(asked.getLast().toString())
        .isEqualTo("http://127.0.0.1:18300/internal/reports/errors/RATE_LIMITED%7Eguard%7Ecore");
    assertThat(asked.getLast().getPath())
        .isEqualTo("/internal/reports/errors/RATE_LIMITED~guard~core");
  }

  /**
   * Службы нет, она молчит или отвечает не тем — {@code 503 INSIGHT_UNAVAILABLE}; её отказ запросу
   * ({@code 400}, {@code 404}) — тот же статус со словами службы.
   */
  @Test
  void reportRefusalsSpeakTheCoreErrorFormat() {
    var unavailable = "Аналитика сейчас недоступна. Попробуйте позже";
    refused(
        () -> new InsightReports("", null).report("pulse", null, Map.of()),
        503,
        "INSIGHT_UNAVAILABLE",
        unavailable);
    refused(
        () ->
            new InsightReports(
                    "http://127.0.0.1:1",
                    uri -> {
                      throw new java.net.ConnectException("refused");
                    })
                .report("pulse", null, Map.of()),
        503,
        "INSIGHT_UNAVAILABLE",
        unavailable);
    for (int status : new int[] {401, 500, 503})
      refused(
          () ->
              new InsightReports(
                      "http://x", uri -> answer(status, "{\"error\":\"база не ответила\"}"))
                  .report("pulse", null, Map.of()),
          503,
          "INSIGHT_UNAVAILABLE",
          unavailable);
    refused(
        () ->
            new InsightReports("http://x", uri -> answer(400, "{\"error\":\"from позже to\"}"))
                .report("pulse", null, Map.of()),
        400,
        "INSIGHT_REQUEST",
        "from позже to");
    refused(
        () ->
            new InsightReports("http://x", uri -> answer(404, "{\"error\":\"нет такого раздела\"}"))
                .report("nothing", null, Map.of()),
        404,
        "INSIGHT_NOT_FOUND",
        "нет такого раздела");
    refused(
        () -> new InsightReports("http://x", uri -> answer(404, "")).report("x", null, Map.of()),
        404,
        "INSIGHT_NOT_FOUND",
        "Служба аналитики не приняла запрос");
  }
}
