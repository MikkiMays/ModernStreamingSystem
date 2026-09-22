package dev.mikki.stream.game;

import java.util.List;

/** Public chess position, with actions computed for the viewing participant. */
public record ChessView(
    String id,
    String hostId,
    String preset,
    String phase,
    String fen,
    String initialFen,
    String turn,
    ChessPlayer white,
    ChessPlayer black,
    long whiteMs,
    long blackMs,
    long anchorAt,
    long deadline,
    long incrementMs,
    int ply,
    List<ChessMove> moves,
    List<String> legalMoves,
    boolean check,
    String result,
    String winner,
    String drawOffer,
    List<String> claimableDraws,
    List<String> claimableMoves,
    List<String> rematchRequests,
    long revision,
    long startedAt,
    long finishedAt,
    String pgn,
    long closesAt) {
  public record ChessPlayer(String memberId, String name, boolean away) {}

  /** Absolute ply number; FEN is the position after this move. */
  public record ChessMove(int ply, String uci, String san, String fen, long at) {}
}
