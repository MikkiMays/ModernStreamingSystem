package dev.mikki.stream.shared;

import java.util.Map;

public class Problem extends RuntimeException {
  private final int status;
  private final String code;
  private final Map<String, Object> properties;
  private boolean addressScoped;

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

  /**
   * Пометить отказ как отказ предела <b>по адресу</b>: частота входов, новых встреч, промахи кода и
   * пароля — то, что считается на IPv4 или сеть /64. Только такие отказы ведут к автоблоку адреса
   * ({@code Blocks.refused}). Отказ предела участника, пропуска или профиля — с тем же кодом и тем
   * же статусом — пометки не несёт: один шумный клиент за общим адресом не закрывает весь офис или
   * мобильную сеть. Клиенту пометка не видна, код и текст отказа те же.
   */
  public Problem perAddress() {
    addressScoped = true;
    return this;
  }

  /** Считается ли предел, который отказал, по адресу ({@link #perAddress}). */
  public boolean addressScoped() {
    return addressScoped;
  }

  public static Problem forbidden() {
    return new Problem(403, "FORBIDDEN", "Доступ закрыт или отозван");
  }

  public static Problem conflict(String code, String message) {
    return new Problem(409, code, message);
  }
}
