package dev.mikki.stream.game;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * Per-member projection; unassigned telephone albums and unrevealed words never leave the engine.
 */
public record GarticView(
    String gameId,
    String hostId,
    String mode,
    String phase,
    long revision,
    long turnToken,
    int round,
    int rounds,
    int turnSeconds,
    int step,
    int totalSteps,
    String drawerId,
    long deadline,
    long phaseStartedAt,
    List<GarticPlayer> players,
    GarticYou you,
    List<GarticStroke> canvas,
    List<GarticGuess> guesses,
    String answer,
    String hint,
    List<GarticAlbum> albums,
    int revealAlbum,
    int revealEntry,
    GarticEntry revealed,
    long closesAt) {

  public record GarticPlayer(
      String memberId,
      String name,
      int score,
      boolean away,
      boolean active,
      boolean guessed,
      boolean submitted) {}

  public record GarticYou(
      String memberId,
      boolean playing,
      boolean canDraw,
      boolean canGuess,
      boolean canSubmit,
      boolean submitted,
      String prompt,
      List<String> choices,
      GarticEntry previous) {}

  /** Coordinates and brush width use a 1000 by 1000 logical canvas. */
  @JsonIgnoreProperties(ignoreUnknown = true)
  public record GarticStroke(String id, String color, int width, List<List<Integer>> points) {}

  @JsonIgnoreProperties(ignoreUnknown = true)
  public record GarticGuess(
      long id, long at, String memberId, String name, String text, boolean correct) {}

  @JsonIgnoreProperties(ignoreUnknown = true)
  public record GarticEntry(
      String authorId,
      String authorName,
      String kind,
      String text,
      List<GarticStroke> strokes,
      boolean skipped,
      int step) {}

  public record GarticAlbum(int index, String ownerId, String ownerName, int entries) {}
}
