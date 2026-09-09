package dev.mikki.stream.api;

import dev.mikki.stream.shared.Problem;
import org.springframework.http.*;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.*;

@RestControllerAdvice
public class ApiErrors {
  @ExceptionHandler(Problem.class)
  public ResponseEntity<ProblemDetail> problem(Problem error) {
    var body =
        ProblemDetail.forStatusAndDetail(
            HttpStatusCode.valueOf(error.status()), error.getMessage());
    body.setProperty("code", error.code());
    return ResponseEntity.status(error.status()).cacheControl(CacheControl.noStore()).body(body);
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
