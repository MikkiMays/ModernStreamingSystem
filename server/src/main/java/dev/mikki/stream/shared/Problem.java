package dev.mikki.stream.shared;

public class Problem extends RuntimeException {
  private final int status;
  private final String code;

  public Problem(int status, String code, String message) {
    super(message);
    this.status = status;
    this.code = code;
  }

  public int status() {
    return status;
  }

  public String code() {
    return code;
  }

  public static Problem forbidden() {
    return new Problem(403, "FORBIDDEN", "Доступ недоступен или отозван");
  }

  public static Problem conflict(String code, String message) {
    return new Problem(409, code, message);
  }
}
