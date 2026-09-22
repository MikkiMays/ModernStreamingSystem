package dev.mikki.stream.game;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/** Public animation facts. Private card movement contains counts only, for every viewer. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record GameVisualEvent(
    long id,
    long at,
    String type,
    Integer fromSeat,
    Integer toSeat,
    int count,
    List<String> cards) {
  public GameVisualEvent {
    cards = List.copyOf(cards);
  }
}
