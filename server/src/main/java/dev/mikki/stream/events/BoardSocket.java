package dev.mikki.stream.events;

import com.fasterxml.jackson.databind.JsonNode;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.api.ClientAddress;
import dev.mikki.stream.board.*;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.room.*;
import dev.mikki.stream.room.Permissions.Action;
import dev.mikki.stream.shared.Json;
import dev.mikki.stream.shared.Problem;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.TextWebSocketHandler;

/**
 * Сокет доски {@code /api/v1/board} (R159) — горячий путь рисования, отдельно от событий встречи.
 *
 * <p>ПОЧЕМУ ОТДЕЛЬНО. Сокет событий ({@link RoomSocket}) несёт команды встречи: каждая — транзакция
 * комнаты с замком, записью и рассылкой снимка, а вход у него — 8 КиБ. Штрихи двадцати рисующих по
 * кадру через него означали бы базу на каждое движение пера. Здесь же правка сливается в памяти
 * доски и раскладывается по очередям участников без базы и без замка комнаты (меньше миллисекунды),
 * а сцена пишется в базу раз в три секунды ({@link BoardRooms}).
 *
 * <p>ПРОВОД (JSON, по сообщению на кадр, {@code permessage-deflate}):
 *
 * <ul>
 *   <li>браузер → ядро: {@code auth {roomId, credential, epoch, since}}; {@code ops {els, t}} —
 *       правки элементов, удаление — {@code isDeleted}; {@code presence {x, y, tool, button, sel}}
 *       — курсор и лазер; {@code ink {id, start, pts, el, t}} — точки штриха «в процессе»; {@code
 *       sync {epoch, since}} — «я что-то пропустил»; {@code ping {id}}.
 *   <li>ядро → браузер: {@code hello {me, canDraw, epoch, seq, peers, mode}}, затем {@code scene}
 *       или пропущенные {@code ops} и {@code synced}; {@code ops {seq, from, t, st, els}}; {@code
 *       ack {seq, rejected, stale}} — ответ на свои правки; {@code presence}, {@code ink}; {@code
 *       joined} и {@code left}; {@code cleared {epoch, seq, by}}; {@code access {canDraw}}; {@code
 *       pong}; {@code error {code}}.
 * </ul>
 *
 * <p>ПРАВО РИСОВАТЬ ({@code board.draw}) проверяется при входе и пересчитывается сразу после каждой
 * команды доски ({@link BoardChanged}) и раз в две секунды: правки и штрихи без права отвергаются
 * ({@code VIEW_ONLY}), курсор и лазер остаются у всех. Модерация мягкая, как везде: кто ушёл из
 * встречи или кого удалили — тот теряет и доску.
 */
@Component
public class BoardSocket extends TextWebSocketHandler {
  /**
   * Сокет закрыт, потому что доски нет: закрыли, встреча завершена или удалена. Не
   * переподключаться.
   */
  static final CloseStatus BOARD_CLOSED = new CloseStatus(4001, "BOARD_CLOSED");

  /** Пропуск не годится или отозван. Не переподключаться. */
  static final CloseStatus FORBIDDEN = new CloseStatus(4003, "FORBIDDEN");

  /** Слишком часто — кривой клиент. Можно вернуться и дослать своё. */
  static final CloseStatus RATE = new CloseStatus(4008, "RATE");

  /** Сокет не успевает за доской. Вернуться и взять пропущенное. */
  static final CloseStatus SLOW = new CloseStatus(4009, "SLOW");

  /**
   * У участника открыто больше досок, чем можно, и эту — самую старую — вытеснила новая вкладка.
   * Сама не возвращается: иначе две вкладки выбивали бы друг друга по кругу.
   */
  static final CloseStatus REPLACED = new CloseStatus(4010, "REPLACED");

  private static final Pattern ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
  private static final Set<String> STROKE_STYLES = Set.of("solid", "dashed", "dotted");
  private static final Set<String> FILL_STYLES =
      Set.of("hachure", "cross-hatch", "solid", "zigzag");

  /** Одна правка — не больше стольких элементов; больше — браузер режет на части. */
  static final int MAX_BATCH = 2000;

  /** Столько точек в одной дельте штриха: кадр пера столько не набирает. */
  static final int MAX_INK_POINTS = 2000;

  final class Peer implements BoardPeer {
    final WebSocketSession session;
    final String address;
    final long openedAt;
    final Outbox outbox;
    final Bucket ops;
    final Bucket presence;
    final Bucket ink;
    final Bucket sync;
    volatile String roomId;
    volatile String memberId;
    volatile boolean canDraw;
    volatile BoardRooms.Hub hub;
    volatile String lastPresence;
    private volatile CloseStatus closing = SLOW;

    Peer(WebSocketSession session, String address, long now) {
      this.session = session;
      this.address = address;
      this.openedAt = now;
      this.ops = new Bucket(120, 240, now);
      this.presence = new Bucket(40, 60, now);
      this.ink = new Bucket(90, 120, now);
      this.sync = new Bucket(2, 6, now);
      this.outbox =
          new Outbox(
              new Outbox.Sink() {
                @Override
                public void send(String text) throws Exception {
                  if (session.isOpen()) session.sendMessage(new TextMessage(text));
                }

                @Override
                public void close() {
                  try {
                    session.close(closing);
                  } catch (Exception ignored) {
                  }
                }
              },
              executor,
              boards.limits().outboxBytes());
    }

    @Override
    public String memberId() {
      return memberId;
    }

    @Override
    public void send(String message) {
      outbox.reliable(message);
    }

    @Override
    public void ephemeral(Ephemeral message) {
      outbox.ephemeral(message);
    }

    @Override
    public void close(String code) {
      closing =
          switch (code) {
            case "BOARD_CLOSED" -> BOARD_CLOSED;
            case "FORBIDDEN" -> FORBIDDEN;
            case "RATE" -> RATE;
            case "REPLACED" -> REPLACED;
            default -> SLOW;
          };
      outbox.close();
    }
  }

  private final Map<String, Peer> peers = new ConcurrentHashMap<>();
  private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
  private final RoomService rooms;
  private final BoardRooms boards;
  private final RateLimits limits;
  private final StreamProperties config;
  private final ClientAddress addresses;

  public BoardSocket(
      RoomService rooms,
      BoardRooms boards,
      RateLimits limits,
      StreamProperties config,
      ClientAddress addresses) {
    this.rooms = rooms;
    this.boards = boards;
    this.limits = limits;
    this.config = config;
    this.addresses = addresses;
  }

  /** Сокет открыт: те же пределы адреса, что у сокета событий (A13), — свой счётчик. */
  @Override
  public void afterConnectionEstablished(WebSocketSession socket) throws Exception {
    socket.setTextMessageSizeLimit(boards.limits().maxMessageBytes());
    var headers = socket.getHandshakeHeaders();
    var remote = socket.getRemoteAddress();
    var address =
        addresses.of(
            headers::getFirst,
            remote == null
                ? ""
                : remote.getAddress() == null
                    ? remote.getHostString()
                    : remote.getAddress().getHostAddress());
    var abuse = config.abuse().perIp();
    if (limits.exceeded("board-open:" + address, abuse.socketOpens())
        || peers.values().stream().filter(p -> address.equals(p.address)).count()
            >= abuse.sockets()) {
      socket.close(CloseStatus.POLICY_VIOLATION);
      return;
    }
    peers.put(socket.getId(), new Peer(socket, address, rooms.now()));
  }

  @Override
  protected void handleTextMessage(WebSocketSession socket, TextMessage message) throws Exception {
    var peer = peers.get(socket.getId());
    if (peer == null) return;
    JsonNode body;
    try {
      body = Json.tree(message.getPayload());
    } catch (IllegalArgumentException e) {
      socket.close(CloseStatus.BAD_DATA);
      return;
    }
    var type = body.path("type").asText();
    synchronized (peer) {
      try {
        if (peer.memberId == null) {
          if (!type.equals("auth")) {
            peer.close("FORBIDDEN");
            return;
          }
          auth(peer, body);
          return;
        }
        switch (type) {
          case "ops" -> ops(peer, body);
          case "presence" -> presence(peer, body);
          case "ink" -> ink(peer, body);
          case "sync" -> sync(peer, body);
          case "ping" ->
              peer.send(
                  Json.write(
                      Map.of("type", "pong", "id", body.path("id").asText(""), "st", rooms.now())));
          default -> peer.send(error("BOARD_INVALID"));
        }
      } catch (Problem e) {
        peer.send(error(e.code()));
        if (e.status() == 403 || e.status() == 404 || e.status() == 410)
          peer.close(e.status() == 403 ? "FORBIDDEN" : "BOARD_CLOSED");
      } catch (IllegalArgumentException e) {
        socket.close(CloseStatus.BAD_DATA);
      }
    }
  }

  private void auth(Peer peer, JsonNode body) {
    String roomId = UUID.fromString(body.path("roomId").asText()).toString();
    var room = rooms.read(roomId);
    var member = rooms.authenticate(room, body.path("credential").asText());
    if (room.closedAt != null || room.board == null || !member.mediaAllowed()) {
      peer.send(error("BOARD_CLOSED"));
      peer.close("BOARD_CLOSED");
      return;
    }
    limits.check("board-ws:" + member.id, 60);
    peer.roomId = roomId;
    peer.memberId = member.id;
    peer.canDraw = Permissions.allows(room, member, Action.BOARD_DRAW);
    oneTooMany(peer);
    long epoch = body.path("epoch").asLong(-1);
    long since = body.path("since").asLong(-1);
    peer.hub =
        boards.attach(
            roomId,
            peer,
            hub -> {
              var missed = hub.room().since(epoch, since);
              var others = new LinkedHashSet<String>();
              for (var other : hub.peers())
                if (other != peer && other.memberId() != null) others.add(other.memberId());
              var hello = new LinkedHashMap<String, Object>();
              hello.put("type", "hello");
              hello.put("me", member.id);
              hello.put("canDraw", peer.canDraw);
              hello.put("epoch", hub.room().epoch());
              hello.put("seq", hub.room().seq());
              hello.put("peers", others);
              hello.put("mode", missed.isPresent() ? "replay" : "scene");
              hello.put("st", rooms.now());
              peer.send(Json.write(hello));
              catchUp(peer, hub, missed);
              // Курсоры тех, кто уже здесь, — сразу, не дожидаясь, пока они шевельнут мышью.
              for (var other : hub.peers())
                if (other != peer && other instanceof Peer seen && seen.lastPresence != null)
                  peer.ephemeral(new Ephemeral.Presence("p:" + seen.memberId, seen.lastPresence));
              BoardRooms.broadcast(
                  hub, peer, Json.write(Map.of("type", "joined", "from", member.id)));
            });
  }

  /** Пропущенное пачками и {@code synced} — или вся сцена. Вызывать под замком доски. */
  private void catchUp(Peer peer, BoardRooms.Hub hub, Optional<List<BoardRoom.Batch>> missed) {
    if (missed.isPresent()) {
      for (var batch : missed.get()) peer.send(ops(batch, true, 0));
      peer.send(Json.write(Map.of("type", "synced", "seq", hub.room().seq())));
      return;
    }
    var scene = hub.room().scene();
    var files = new ArrayList<Map<String, Object>>();
    for (var file : scene.files())
      files.add(Map.of("id", file.id(), "mime", file.mime(), "size", file.size()));
    peer.send(
        "{\"type\":\"scene\",\"epoch\":"
            + scene.epoch()
            + ",\"seq\":"
            + scene.seq()
            + ",\"files\":"
            + Json.write(files)
            + ",\"els\":"
            + scene.elements()
            + "}");
  }

  private void ops(Peer peer, JsonNode body) {
    if (!peer.canDraw) {
      peer.send(error("VIEW_ONLY"));
      return;
    }
    if (!peer.ops.take(rooms.now())) {
      peer.close("RATE");
      return;
    }
    var elements = body.get("els");
    if (elements == null || !elements.isArray() || elements.size() > MAX_BATCH) {
      peer.send(error("BOARD_INVALID"));
      return;
    }
    long sent = body.path("t").asLong(0);
    var hub = peer.hub;
    synchronized (hub.room()) {
      var applied = hub.room().apply(elements, peer.memberId);
      if (applied.batch() != null)
        BoardRooms.broadcast(hub, peer, ops(applied.batch(), false, sent));
      var ack = new StringBuilder("{\"type\":\"ack\",\"seq\":");
      ack.append(applied.batch() == null ? hub.room().seq() : applied.batch().seq());
      ack.append(",\"n\":").append(applied.accepted());
      if (!applied.rejected().isEmpty())
        ack.append(",\"rejected\":").append(Json.write(applied.rejected()));
      if (!applied.stale().isEmpty())
        ack.append(",\"stale\":[").append(String.join(",", applied.stale())).append(']');
      peer.send(ack.append('}').toString());
    }
  }

  /** Пачка правок для участников: живая — с отметками времени для замера задержки, повтор — без. */
  private String ops(BoardRoom.Batch batch, boolean replay, long sent) {
    var text = new StringBuilder(batch.elements().length() + 128);
    text.append("{\"type\":\"ops\",\"seq\":").append(batch.seq());
    text.append(",\"from\":").append(Json.write(batch.from()));
    if (replay) text.append(",\"replay\":true");
    else text.append(",\"t\":").append(sent).append(",\"st\":").append(rooms.now());
    return text.append(",\"els\":").append(batch.elements()).append('}').toString();
  }

  private void presence(Peer peer, JsonNode body) {
    if (!peer.presence.take(rooms.now())) return;
    var x = body.path("x");
    var y = body.path("y");
    if (!finite(x) || !finite(y)) return;
    var message = new LinkedHashMap<String, Object>();
    message.put("type", "presence");
    message.put("from", peer.memberId);
    message.put("x", x.asDouble());
    message.put("y", y.asDouble());
    message.put("tool", "laser".equals(body.path("tool").asText()) ? "laser" : "pointer");
    message.put("button", "down".equals(body.path("button").asText()) ? "down" : "up");
    var selection = body.get("sel");
    if (selection != null && selection.isArray()) {
      var ids = new ArrayList<String>();
      for (var id : selection)
        if (id.isTextual() && ID.matcher(id.asText()).matches() && ids.size() < 500)
          ids.add(id.asText());
      message.put("sel", ids);
    }
    message.put("t", body.path("t").asLong(0));
    var json = Json.write(message);
    peer.lastPresence = json;
    BoardRooms.broadcast(peer.hub, peer, new Ephemeral.Presence("p:" + peer.memberId, json));
  }

  private void ink(Peer peer, JsonNode body) {
    if (!peer.canDraw || !peer.ink.take(rooms.now())) return;
    var stroke = body.path("id").asText("");
    long start = body.path("start").asLong(-1);
    var pts = body.get("pts");
    if (!ID.matcher(stroke).matches() || start < 0 || pts == null || !pts.isArray()) return;
    if (pts.size() > MAX_INK_POINTS) return;
    var points = new ArrayList<double[]>(pts.size());
    for (var point : pts) {
      if (!point.isArray() || point.size() < 2 || point.size() > 3) return;
      var values = new double[point.size()];
      for (int i = 0; i < point.size(); i++) {
        if (!finite(point.get(i))) return;
        values[i] = point.get(i).asDouble();
      }
      points.add(values);
    }
    var style = style(body.get("el"));
    BoardRooms.broadcast(
        peer.hub,
        peer,
        new Ephemeral.Ink(
            "i:" + peer.memberId + ":" + stroke,
            peer.memberId,
            stroke,
            start,
            points,
            style,
            body.path("t").asLong(0),
            rooms.now()));
  }

  /**
   * Вид штриха «в процессе» — только известные поля и только своего вида: это не элемент сцены, и
   * лишнего соседу везти незачем. Нет вида — {@code null}: приёмник возьмёт прежний.
   */
  private static String style(JsonNode el) {
    if (el == null || !el.isObject()) return null;
    var style = new LinkedHashMap<String, Object>();
    for (var field : List.of("x", "y", "strokeWidth", "opacity", "roughness", "angle"))
      if (finite(el.path(field))) style.put(field, el.path(field).asDouble());
    for (var field : List.of("strokeColor", "backgroundColor")) {
      var value = el.path(field).asText("");
      if (value.length() <= 32 && value.matches("[#A-Za-z0-9(),. %]*")) style.put(field, value);
    }
    var strokeStyle = el.path("strokeStyle").asText("");
    if (STROKE_STYLES.contains(strokeStyle)) style.put("strokeStyle", strokeStyle);
    var fillStyle = el.path("fillStyle").asText("");
    if (FILL_STYLES.contains(fillStyle)) style.put("fillStyle", fillStyle);
    if (el.path("simulatePressure").isBoolean())
      style.put("simulatePressure", el.path("simulatePressure").asBoolean());
    var index = el.path("index").asText("");
    if (index.length() <= 64 && index.matches("[0-9A-Za-z]*") && !index.isEmpty())
      style.put("index", index);
    var frame = el.path("frameId").asText("");
    if (ID.matcher(frame).matches()) style.put("frameId", frame);
    return Json.write(style);
  }

  private void sync(Peer peer, JsonNode body) {
    if (!peer.sync.take(rooms.now())) return;
    long epoch = body.path("epoch").asLong(-1);
    long since = body.path("since").asLong(-1);
    var hub = peer.hub;
    synchronized (hub.room()) {
      catchUp(peer, hub, hub.room().since(epoch, since));
    }
  }

  /** Доску очистили командой: стереть сцену и сказать всем (после фиксации команды). */
  @TransactionalEventListener(fallbackExecution = true)
  public void cleared(BoardCleared event) {
    boards.clear(event.roomId(), event.by());
  }

  /**
   * Комната изменилась сама (сроки, завершение встречи): права сокетов доски — сразу, не через 2 с.
   */
  @TransactionalEventListener(fallbackExecution = true)
  public void roomChanged(RoomChanged event) {
    refresh(event.roomId());
  }

  /** Доску открыли, закрыли или сменили, кто рисует: пересчитать права её сокетов сразу. */
  @TransactionalEventListener(fallbackExecution = true)
  public void changed(BoardChanged event) {
    refresh(event.roomId());
  }

  /** Пересчитать права всех сокетов доски этой комнаты по свежему снимку комнаты. */
  public void refresh(String roomId) {
    var hub = boards.existing(roomId).orElse(null);
    if (hub == null) return;
    var connected = hub.peers();
    if (connected.isEmpty()) return;
    RoomState room;
    try {
      room = rooms.read(roomId);
    } catch (Problem e) {
      for (var peer : connected) peer.close("BOARD_CLOSED");
      return;
    }
    for (var peer : connected) {
      var member = room.members.get(peer.memberId());
      if (room.closedAt != null || room.board == null) {
        peer.send(error("BOARD_CLOSED"));
        peer.close("BOARD_CLOSED");
      } else if (member == null
          || member.replacedBy != null
          || member.status == RoomState.Status.REMOVED
          || !member.mediaAllowed()) {
        peer.send(error("FORBIDDEN"));
        peer.close("FORBIDDEN");
      } else if (peer instanceof Peer socket) {
        boolean draw = Permissions.allows(room, member, Action.BOARD_DRAW);
        if (draw != socket.canDraw) {
          socket.canDraw = draw;
          socket.send(Json.write(Map.of("type", "access", "canDraw", draw)));
        }
      }
    }
  }

  /**
   * Проход раз в две секунды ({@code BoardSchedule}): права всех досок, зависшие отправки и сокеты,
   * не назвавшие себя за пять секунд.
   */
  public void recheck() {
    long now = System.currentTimeMillis();
    for (var peer : peers.values()) {
      if (peer.memberId == null && rooms.now() - peer.openedAt > 5000) peer.close("FORBIDDEN");
      else if (peer.outbox.stuck(now, boards.limits().sendTimeoutMs())) peer.close("SLOW");
    }
    for (var hub : boards.all()) refresh(hub.room().roomId());
  }

  @Override
  public void afterConnectionClosed(WebSocketSession socket, CloseStatus status) {
    var peer = peers.remove(socket.getId());
    if (peer == null) return;
    peer.outbox.close();
    var hub = peer.hub;
    if (hub == null) return;
    boards.detach(hub, peer);
    synchronized (hub.room()) {
      boolean stillHere = hub.peers().stream().anyMatch(p -> peer.memberId.equals(p.memberId()));
      if (!stillHere)
        BoardRooms.broadcast(hub, null, Json.write(Map.of("type", "left", "from", peer.memberId)));
    }
  }

  /**
   * Сокетов доски у участника не больше {@code per-member.sockets}: лишний закрывает самый старый.
   */
  private void oneTooMany(Peer fresh) {
    var same =
        peers.values().stream()
            .filter(p -> p != fresh && fresh.memberId.equals(p.memberId))
            .sorted(Comparator.comparingLong(p -> p.openedAt))
            .toList();
    int extra = same.size() + 1 - config.abuse().perMember().sockets();
    for (int i = 0; i < extra; i++) same.get(i).close("REPLACED");
  }

  /** Сколько сокетов доски открыто — для тестов и метров. */
  public int open() {
    return peers.size();
  }

  @jakarta.annotation.PreDestroy
  public void stop() {
    executor.shutdownNow();
  }

  private static boolean finite(JsonNode node) {
    return node != null && node.isNumber() && Double.isFinite(node.asDouble());
  }

  private static String error(String code) {
    return Json.write(Map.of("type", "error", "code", code));
  }
}
