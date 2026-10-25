package dev.mikki.stream.api;

import dev.mikki.stream.shared.Problem;
import org.springframework.http.*;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.*;

@RestControllerAdvice
public class ApiErrors {
  /**
   * Атрибут запроса с кодом отказа: его читает {@code BlockGuard} после ответа — чтобы посчитать
   * отказ в метрах и, если он про адрес, в автоблоке. Код здесь, а не в разборе тела ответа: тело к
   * тому времени уже ушло.
   */
  public static final String CODE = "cord.problem.code";

  @ExceptionHandler(Problem.class)
  public ResponseEntity<ProblemDetail> problem(Problem error) {
    var attributes =
        org.springframework.web.context.request.RequestContextHolder.getRequestAttributes();
    if (attributes != null)
      attributes.setAttribute(
          CODE,
          error.code(),
          org.springframework.web.context.request.RequestAttributes.SCOPE_REQUEST);
    var body =
        ProblemDetail.forStatusAndDetail(
            HttpStatusCode.valueOf(error.status()), error.getMessage());
    body.setProperty("code", error.code());
    error.properties().forEach(body::setProperty);
    var response = ResponseEntity.status(error.status()).cacheControl(CacheControl.noStore());
    // Отказ «повторите позже» несёт срок и заголовком: его читают скрипты и прокси, а не только
    // браузер по полю {@code retryAfter} рядом с кодом ({@code MAINTENANCE}).
    if (error.properties().get("retryAfter") instanceof Number seconds)
      response.header(HttpHeaders.RETRY_AFTER, Long.toString(seconds.longValue()));
    return response.body(body);
  }

  @ExceptionHandler({MethodArgumentNotValidException.class, IllegalArgumentException.class})
  public ResponseEntity<ProblemDetail> invalid(Exception ignored) {
    return problem(new Problem(400, "INVALID_REQUEST", "Проверьте данные запроса"));
  }

  @ExceptionHandler(org.springframework.http.converter.HttpMessageNotReadableException.class)
  public ResponseEntity<ProblemDetail> unreadable(Exception ignored) {
    return problem(new Problem(400, "INVALID_REQUEST", "Проверьте данные запроса"));
  }
}
