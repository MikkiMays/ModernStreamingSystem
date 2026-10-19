package dev.mikki.stream.shared;

import java.util.Map;

public class Problem extends RuntimeException {
  private final int status;
  private final String code;
  private final Map<String, Object> properties;

  public Problem(int status, String code, String message) {
    this(status, code, message, Map.of());
  }

  /**
   * Отказ с подробностями, которые клиенту нужны не словами, а значениями: в какой встрече он уже
   * сидит ({@code ALREADY_IN_MEETING {roomId, title}}), сколько комнат помещается в избранное
   * ({@code FAVORITES_FULL {max}}). Они ложатся в ответ RFC 7807 рядом с {@code code}.
   */
  public Problem(int status, String code, String message, Map<String, Object> properties) {
    super(message);
    this.status = status;
    this.code = code;
    this.properties = Map.copyOf(properties);
  }

  public int status() {
    return status;
  }

  public String code() {
    return code;
  }

  public Map<String, Object> properties() {
    return properties;
  }

  public static Problem forbidden() {
    return new Problem(403, "FORBIDDEN", "Доступ недоступен или отозван");
  }

  public static Problem conflict(String code, String message) {
    return new Problem(409, code, message);
  }
}
