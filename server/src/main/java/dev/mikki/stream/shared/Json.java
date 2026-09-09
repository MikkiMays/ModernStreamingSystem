package dev.mikki.stream.shared;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

public final class Json {
  private static final ObjectMapper MAPPER =
      new ObjectMapper()
          .registerModule(new JavaTimeModule())
          .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

  private Json() {}

  public static String write(Object value) {
    try {
      return MAPPER.writeValueAsString(value);
    } catch (Exception e) {
      throw new IllegalStateException("Cannot serialize contract", e);
    }
  }

  public static <T> T read(String value, Class<T> type) {
    try {
      return MAPPER.readValue(value, type);
    } catch (Exception e) {
      throw new IllegalArgumentException("Invalid JSON", e);
    }
  }

  public static com.fasterxml.jackson.databind.JsonNode tree(String value) {
    try {
      return MAPPER.readTree(value);
    } catch (Exception e) {
      throw new IllegalArgumentException("Invalid JSON", e);
    }
  }
}
