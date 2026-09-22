package dev.mikki.stream.game;

import static io.github.asdfjkl.jchesslib.CONSTANTS.*;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import dev.mikki.stream.shared.Problem;
import io.github.asdfjkl.jchesslib.Board;
import io.github.asdfjkl.jchesslib.Move;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * Authoritative standard chess. The room transaction owns synchronization; only FEN and plain
 * values are persisted, never a library Board. Clocks keep running through disconnects and
 * restarts.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class Chess {
  public static final String INITIAL_FEN =
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  public static final long LINGER_MS = 600_000;

  /** The last 256 full moves fit comfortably in one Cord snapshot, even with PGN. */
  public static final int HISTORY_PLIES = 512;

  public String id;
  public String hostId;
  public String preset = "10-5";
  public String phase = "lobby";
  public String fen = INITIAL_FEN;
  public String initialFen = INITIAL_FEN;
  public String turn = "white";
  public Player white;
  public Player black;
  public long whiteMs;
  public long blackMs;
  public long initialMs;
  public long incrementMs;
  public long anchorAt;
  public long deadline;
  public long startedAt;
  public long matchInitialMs;
  public long matchIncrementMs;
  public long finishedAt;
  public long idleSince;
  public long revision;
  public int ply;
  public String result;
  public String winner;
  public String drawOffer;
  public int lastDrawOfferPly = -1;
  public String matchWhiteName;
  public String matchBlackName;
  public List<ChessView.ChessMove> moves = new ArrayList<>();
  public List<String> rematchRequests = new ArrayList<>();

  /** Since the last pawn move/capture: the 75-move rule bounds this to 151 positions. */
  public Map<String, Integer> repetitions = new LinkedHashMap<>();

  @JsonIgnoreProperties(ignoreUnknown = true)
  public static class Player {
    public String memberId;
    public String name;
    public boolean away;

    public Player() {}

    Player(String memberId, String name) {
      this.memberId = memberId;
      this.name = name;
    }
  }

  public static Chess open(String hostId, String name, String preset, long now) {
    var game = new Chess();
    game.id = UUID.randomUUID().toString();
    game.hostId = hostId;
    game.white = new Player(hostId, name);
    game.configure(preset, now);
    return game;
  }

  public void configure(String preset, long now) {
    if ("playing".equals(phase))
      throw conflict("CHESS_PLAYING", "Контроль времени меняется между партиями");
    String chosen = preset == null || preset.isBlank() ? "10-5" : preset;
    long minutes;
    long increment;
    switch (chosen) {
      case "untimed" -> {
        minutes = 0;
        increment = 0;
      }
      case "3-2" -> {
        minutes = 3;
        increment = 2;
      }
      case "5-0" -> {
        minutes = 5;
        increment = 0;
      }
      case "10-5" -> {
        minutes = 10;
        increment = 5;
      }
      case "15-10" -> {
        minutes = 15;
        increment = 10;
      }
      default -> throw new Problem(400, "CHESS_PRESET", "Выберите контроль времени");
    }
    this.preset = chosen;
    initialMs = minutes * 60_000;
    incrementMs = increment * 1000;
    if ("lobby".equals(phase)) {
      whiteMs = blackMs = initialMs;
      anchorAt = now;
    }
    revision++;
  }

  public void sit(String memberId, String name, Integer seat, long now) {
    if ("playing".equals(phase)) throw conflict("CHESS_PLAYING", "Места меняются после партии");
    if (seat != null && seat != 0 && seat != 1)
      throw new Problem(400, "CHESS_SEAT", "Выберите цвет");
    Player existing = player(memberId);
    if (seat == null && existing != null) return;
    int chosen = seat == null ? (white == null ? 0 : 1) : seat;
    Player target = chosen == 0 ? white : black;
    if (target != null && !target.memberId.equals(memberId))
      throw conflict("CHESS_TAKEN", "Это место уже занято");
    if (existing == target && existing != null) return;
    if (existing == white) white = null;
    if (existing == black) black = null;
    if (chosen == 0) white = new Player(memberId, name);
    else black = new Player(memberId, name);
    rematchRequests.clear();
    idleSince = 0;
    revision++;
  }

  public void stand(String memberId, long now) {
    if ("playing".equals(phase))
      throw conflict("CHESS_PLAYING", "Сначала завершите партию или сдавайтесь");
    var seated = player(memberId);
    if (seated == null) return;
    if (seated == white) white = null;
    else black = null;
    rematchRequests.clear();
    revision++;
  }

  public void start(String gameId, long now) {
    requireGame(gameId);
    if ("playing".equals(phase)) throw conflict("CHESS_PLAYING", "Партия уже идёт");
    if (white == null || black == null || white.away || black.away)
      throw conflict("CHESS_PLAYERS", "Для старта нужны два игрока во встрече");
    if ("over".equals(phase)) id = UUID.randomUUID().toString();
    phase = "playing";
    fen = initialFen = INITIAL_FEN;
    turn = "white";
    whiteMs = blackMs = initialMs;
    anchorAt = startedAt = now;
    finishedAt = 0;
    ply = 0;
    result = winner = drawOffer = null;
    lastDrawOfferPly = -1;
    moves.clear();
    rematchRequests.clear();
    repetitions.clear();
    repetitions.put(positionKey(new Board(fen)), 1);
    matchWhiteName = white.name;
    matchBlackName = black.name;
    matchInitialMs = initialMs;
    matchIncrementMs = incrementMs;
    idleSince = 0;
    schedule();
    revision++;
  }

  /** A flag fall returns normally so its result is committed by the surrounding transaction. */
  public void move(String memberId, String gameId, Long expectedPly, String uci, long now) {
    requireToken(gameId, expectedPly);
    String color = color(memberId);
    requirePlaying();
    if (!color.equals(turn)) throw conflict("CHESS_TURN", "Сейчас ход соперника");
    if (tick(now)) return;
    var board = new Board(fen);
    var move = legalMove(board, uci);
    String san = board.san(move).replace("#+", "#");
    if (repetitions.isEmpty()) repetitions.put(positionKey(board), 1);
    charge(now);
    if (initialMs > 0) {
      if (turn.equals("white")) whiteMs += incrementMs;
      else blackMs += incrementMs;
    }
    if (drawOffer != null && !drawOffer.equals(color)) drawOffer = null;
    board.apply(move);
    fen = board.fen();
    turn = board.turn == WHITE ? "white" : "black";
    ply++;
    moves.add(new ChessView.ChessMove(ply, uci(move), san, fen, now));
    if (moves.size() > HISTORY_PLIES) initialFen = moves.removeFirst().fen();
    if (board.halfmoveClock == 0) repetitions.clear();
    repetitions.merge(positionKey(board), 1, Integer::sum);
    anchorAt = now;
    if (board.isCheckmate()) finish("checkmate", opposite(turn), now);
    else if (board.isStalemate()) finish("stalemate", null, now);
    else if (deadMaterial(board)) finish("insufficient-material", null, now);
    else if (board.halfmoveClock >= 150) finish("seventy-five-move", null, now);
    else if (repetitions.getOrDefault(positionKey(board), 0) >= 5) finish("fivefold", null, now);
    else schedule();
    revision++;
  }

  public void act(
      String memberId, String gameId, Long expectedPly, String option, String text, long now) {
    requireToken(gameId, expectedPly);
    String color = color(memberId);
    if ("rematch".equals(option)) {
      if (!"over".equals(phase))
        throw conflict("CHESS_NOT_OVER", "Реванш — после окончания партии");
      if (!rematchRequests.contains(memberId)) {
        rematchRequests.add(memberId);
        revision++;
      }
      if (white != null
          && black != null
          && !white.away
          && !black.away
          && rematchRequests.contains(white.memberId)
          && rematchRequests.contains(black.memberId)) {
        var previousWhite = white;
        white = black;
        black = previousWhite;
        start(gameId, now);
      }
      return;
    }
    requirePlaying();
    if (tick(now)) return;
    switch (option == null ? "" : option) {
      case "resign" -> {
        String winningColor = opposite(color);
        if (cannotMate(new Board(fen), winningColor.equals("white") ? WHITE : BLACK))
          finish("resignation-insufficient-material", null, now);
        else finish("resignation", winningColor, now);
      }
      case "draw-offer" -> {
        if (!color.equals(turn)) throw conflict("CHESS_TURN", "Предложите ничью на своём ходу");
        if (lastDrawOfferPly == ply)
          throw conflict("CHESS_DRAW_OFFER", "На этом ходу ничья уже предложена");
        drawOffer = color;
        lastDrawOfferPly = ply;
      }
      case "draw-accept", "draw-decline" -> {
        if (drawOffer == null || drawOffer.equals(color))
          throw conflict("CHESS_NO_OFFER", "Соперник не предлагал ничью");
        if (option.equals("draw-accept")) finish("agreement", null, now);
        else drawOffer = null;
      }
      case "draw-claim" -> {
        if (!color.equals(turn)) throw conflict("CHESS_TURN", "Заявить ничью можно на своём ходу");
        var board = new Board(fen);
        boolean intended = text != null && !text.isBlank();
        if (intended) board.apply(legalMove(board, text));
        int count = repetitions.getOrDefault(positionKey(board), 0) + (intended ? 1 : 0);
        if (board.isCheckmate())
          throw conflict("CHESS_NO_CLAIM", "Мат завершает партию раньше правила ничьей");
        if (count >= 3) finish("threefold", null, now);
        else if (board.halfmoveClock >= 100) finish("fifty-move", null, now);
        else throw conflict("CHESS_NO_CLAIM", "Пока нет основания для ничьей");
      }
      default -> throw new Problem(400, "CHESS_ACTION", "Неизвестное действие за шахматной доской");
    }
    revision++;
  }

  public boolean tick(long now) {
    if (!"playing".equals(phase) || deadline <= 0 || now < deadline) return false;
    String winningColor = opposite(turn);
    var board = new Board(fen);
    if (cannotMate(board, winningColor.equals("white") ? WHITE : BLACK))
      finish("timeout-insufficient-material", null, now);
    else finish("timeout", winningColor, now);
    revision++;
    return true;
  }

  public boolean presence(Set<String> present, long now) {
    boolean changed = false;
    for (var player : new Player[] {white, black}) {
      if (player == null) continue;
      boolean away = !present.contains(player.memberId);
      if (away != player.away) {
        player.away = away;
        changed = true;
      }
    }
    if (changed) revision++;
    return changed;
  }

  public boolean rebind(String previousId, String memberId, String name) {
    boolean changed = false;
    if (Objects.equals(hostId, previousId)) {
      hostId = memberId;
      changed = true;
    }
    for (var player : new Player[] {white, black}) {
      if (player == null || !player.memberId.equals(previousId)) continue;
      player.memberId = memberId;
      player.name = name;
      player.away = false;
      changed = true;
    }
    if (rematchRequests.remove(previousId)) rematchRequests.add(memberId);
    if (changed) {
      idleSince = 0;
      revision++;
    }
    return changed;
  }

  public void host(String memberId) {
    if (!Objects.equals(memberId, hostId)) {
      hostId = memberId;
      revision++;
    }
  }

  public boolean linger(long now, long serverStartedAt) {
    boolean occupied = (white != null && !white.away) || (black != null && !black.away);
    if (occupied || "playing".equals(phase)) {
      idleSince = 0;
      return false;
    }
    if (idleSince == 0 || idleSince < serverStartedAt) idleSince = Math.max(now, serverStartedAt);
    return now - idleSince >= LINGER_MS;
  }

  public long closesAt() {
    return idleSince == 0 ? 0 : idleSince + LINGER_MS;
  }

  public ChessView view(String viewerId, long now) {
    var board = new Board(fen);
    boolean yourTurn =
        "playing".equals(phase) && player(viewerId) == (turn.equals("white") ? white : black);
    var claims = new ArrayList<String>();
    var claimMoves = new ArrayList<String>();
    var legal = yourTurn ? board.legalMoves() : List.<Move>of();
    if (yourTurn) {
      if (repetitions.getOrDefault(positionKey(board), 0) >= 3) claims.add("threefold");
      if (board.halfmoveClock >= 100) claims.add("fifty-move");
      if (claims.isEmpty()
          && (board.halfmoveClock >= 99 || repetitions.values().stream().anyMatch(n -> n >= 2))) {
        for (var move : legal) {
          var next = board.makeCopy();
          next.apply(move);
          if (!next.isCheckmate()
              && (next.halfmoveClock >= 100 || repetitions.getOrDefault(positionKey(next), 0) >= 2))
            claimMoves.add(uci(move));
        }
      }
    }
    return new ChessView(
        id,
        hostId,
        preset,
        phase,
        fen,
        initialFen,
        turn,
        playerView(white),
        playerView(black),
        whiteMs,
        blackMs,
        anchorAt,
        deadline,
        incrementMs,
        ply,
        List.copyOf(moves),
        legal.stream().map(Chess::uci).toList(),
        board.isCheck(),
        result,
        winner,
        drawOffer,
        claims,
        claimMoves,
        List.copyOf(rematchRequests),
        revision,
        startedAt,
        finishedAt,
        pgn(),
        closesAt());
  }

  private ChessView.ChessPlayer playerView(Player player) {
    return player == null
        ? null
        : new ChessView.ChessPlayer(player.memberId, player.name, player.away);
  }

  private Player player(String memberId) {
    if (memberId == null) return null;
    if (white != null && memberId.equals(white.memberId)) return white;
    if (black != null && memberId.equals(black.memberId)) return black;
    return null;
  }

  private String color(String memberId) {
    var player = player(memberId);
    if (player == null)
      throw conflict("CHESS_NOT_SEATED", "Вы наблюдаете за партией. Ходить могут только игроки");
    return player == white ? "white" : "black";
  }

  private void requireGame(String gameId) {
    if (!Objects.equals(id, gameId))
      throw conflict("CHESS_STALE", "Эта партия уже завершилась. Дождитесь нового снимка");
  }

  private void requireToken(String gameId, Long expectedPly) {
    requireGame(gameId);
    if (expectedPly == null || expectedPly != ply)
      throw conflict("CHESS_STALE", "Позиция изменилась. Повторите действие");
  }

  private void requirePlaying() {
    if (!"playing".equals(phase)) throw conflict("CHESS_NOT_PLAYING", "Партия сейчас не идёт");
  }

  private Move legalMove(Board board, String uci) {
    if (uci == null || !uci.matches("[a-h][1-8][a-h][1-8][qrbn]?"))
      throw new Problem(400, "CHESS_MOVE", "Некорректный ход");
    var move = new Move(uci);
    if (!board.isLegal(move))
      throw conflict("CHESS_ILLEGAL", "Такой ход невозможен в этой позиции");
    return move;
  }

  private void charge(long now) {
    if (initialMs == 0 || !"playing".equals(phase)) return;
    long elapsed = Math.max(0, now - anchorAt);
    if (turn.equals("white")) whiteMs = Math.max(0, whiteMs - elapsed);
    else blackMs = Math.max(0, blackMs - elapsed);
    anchorAt = now;
  }

  private void schedule() {
    deadline = initialMs == 0 ? 0 : anchorAt + (turn.equals("white") ? whiteMs : blackMs);
  }

  private void finish(String reason, String winningColor, long now) {
    charge(now);
    phase = "over";
    result = reason;
    winner = winningColor;
    deadline = 0;
    finishedAt = now;
    drawOffer = null;
    rematchRequests.clear();
  }

  /** An en-passant target matters for repetition only when the capture is actually legal. */
  private static String positionKey(Board board) {
    var parts = board.fen().split(" ");
    String ep = parts[3];
    if (!ep.equals("-")) {
      boolean effective = false;
      for (var move : board.legalMoves()) {
        if (board.getPieceTypeAt(move.getMoveSourceSquare()) == PAWN
            && move.getUci().substring(2, 4).equals(ep)
            && move.getUci().charAt(0) != move.getUci().charAt(2)) {
          effective = true;
          break;
        }
      }
      if (!effective) ep = "-";
    }
    return parts[0] + " " + parts[1] + " " + parts[2] + " " + ep;
  }

  private static boolean deadMaterial(Board board) {
    return cannotMate(board, WHITE) && cannotMate(board, BLACK);
  }

  /**
   * Material impossibility, not forceability: two knights can deliver mate with cooperation.
   * Opposing material may block escape squares; bishops' square colors therefore matter too. Like
   * common chess servers this does not attempt arbitrary locked-pawn fortress proofs.
   */
  private static boolean cannotMate(Board board, int color) {
    int ownMinors = 0, ownKnights = 0, ownBishops = 0;
    boolean opponentCanBlockKnight = false, anyPawnOrKnight = false;
    boolean lightBishop = false, darkBishop = false;
    for (int x = 0; x < 8; x++)
      for (int y = 0; y < 8; y++) {
        int type = board.getPieceTypeAt(x, y);
        if (type == EMPTY || type == KING) continue;
        boolean ours = board.getPieceColorAt(x, y) == color;
        if (ours && (type == PAWN || type == ROOK || type == QUEEN)) return false;
        if (type == PAWN || type == KNIGHT) anyPawnOrKnight = true;
        if (!ours && type != QUEEN) opponentCanBlockKnight = true;
        if (type == BISHOP) {
          if ((x + y) % 2 == 0) darkBishop = true;
          else lightBishop = true;
        }
        if (ours) {
          ownMinors++;
          if (type == KNIGHT) ownKnights++;
          if (type == BISHOP) ownBishops++;
        }
      }
    if (ownMinors == 0) return true;
    if (ownKnights > 0) return ownMinors == 1 && !opponentCanBlockKnight;
    return ownBishops > 0 && !(lightBishop && darkBishop) && !anyPawnOrKnight;
  }

  private String pgn() {
    String score =
        result == null ? "*" : winner == null ? "1/2-1/2" : winner.equals("white") ? "1-0" : "0-1";
    String date =
        startedAt == 0
            ? "????.??.??"
            : DateTimeFormatter.ofPattern("yyyy.MM.dd")
                .withZone(ZoneOffset.UTC)
                .format(Instant.ofEpochMilli(startedAt));
    var out =
        new StringBuilder("[Event \"Cord\"]\n[Site \"Cord\"]\n[Date \"")
            .append(date)
            .append("\"]\n[Round \"-\"]\n[White \"")
            .append(
                pgnName(matchWhiteName != null ? matchWhiteName : white == null ? "?" : white.name))
            .append("\"]\n[Black \"")
            .append(
                pgnName(matchBlackName != null ? matchBlackName : black == null ? "?" : black.name))
            .append("\"]\n[Result \"")
            .append(score)
            .append("\"]\n")
            .append("[TimeControl \"")
            .append(
                matchInitialMs == 0 ? "-" : matchInitialMs / 1000 + "+" + matchIncrementMs / 1000)
            .append("\"]\n");
    if (!initialFen.equals(INITIAL_FEN))
      out.append("[SetUp \"1\"]\n[FEN \"").append(initialFen).append("\"]\n");
    out.append('\n');
    var start = initialFen.split(" ");
    int fullmove = Integer.parseInt(start[5]);
    boolean whiteToMove = start[1].equals("w");
    boolean first = true;
    for (var move : moves) {
      if (whiteToMove) out.append(fullmove).append(". ");
      else if (first) out.append(fullmove).append("... ");
      out.append(move.san()).append(' ');
      if (!whiteToMove) fullmove++;
      whiteToMove = !whiteToMove;
      first = false;
    }
    return out.append(score).append('\n').toString();
  }

  private static String pgnName(String name) {
    return name.replace("\\", "\\\\").replace("\"", "\\\"").replaceAll("\\p{Cntrl}", " ");
  }

  private static String opposite(String color) {
    return color.equals("white") ? "black" : "white";
  }

  /** jchesslib writes promotion pieces uppercase; the wire uses canonical lowercase UCI. */
  private static String uci(Move move) {
    return move.getUci().toLowerCase(Locale.ROOT);
  }

  private static Problem conflict(String code, String message) {
    return Problem.conflict(code, message);
  }
}
