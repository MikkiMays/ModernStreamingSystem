package dev.mikki.stream.board;

import dev.mikki.stream.shared.Json;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Доски, открытые на этом ядре (R159): сцена в памяти, кто у неё сидит и когда её записать.
 *
 * <p>ГОРЯЧИЙ ПУТЬ БЕЗ БАЗЫ. Правка штриха сливается в памяти ({@link BoardRoom}) и раскладывается
 * по очередям участников под замком самой доски — без транзакции и без замка комнаты. В базу сцена
 * уходит раз в {@code flush-ms} (3 с), когда в ней есть новое, и сразу, когда уходит последний
 * участник. Падение ядра теряет не больше трёх секунд правок; браузеры, вернувшись, дошлют своё
 * сами — их правки по-прежнему у них в сцене.
 *
 * <p>ОДИН УЗЕЛ. Доска живёт в памяти того ядра, к которому подключены её сокеты; Redis для неё пока
 * не нужен — ядро у Cord одно. Несколько узлов — следующий шаг (проект доски, v2).
 */
@Component
public class BoardRooms {
  private static final Logger log = LoggerFactory.getLogger(BoardRooms.class);

  private final BoardStore store;
  private final BoardProperties limits;
  private final Clock clock;
  private final Map<String, Hub> boards = new ConcurrentHashMap<>();
  private final AtomicLong accepted = new AtomicLong();
  private final AtomicLong rejected = new AtomicLong();
  private final AtomicLong saveFailures = new AtomicLong();

  /** Доска и её участники. Список участников меняется только под замком доски ({@link #room}). */
  public static final class Hub {
    final BoardRoom room;
    final Set<BoardPeer> peers = new LinkedHashSet<>();
    final AtomicBoolean flushing = new AtomicBoolean();
    long idleSince;
    long flushedAt;
    boolean evicted;

    Hub(BoardRoom room, long now) {
      this.room = room;
      this.idleSince = now;
      this.flushedAt = now;
    }

    public BoardRoom room() {
      return room;
    }

    /** Участники доски — копией, под замком. */
    public List<BoardPeer> peers() {
      synchronized (room) {
        return List.copyOf(peers);
      }
    }
  }

  public BoardRooms(BoardStore store, BoardProperties limits, Clock clock) {
    this.store = store;
    this.limits = limits;
    this.clock = clock;
  }

  public BoardProperties limits() {
    return limits;
  }

  /** Доска комнаты: из памяти, из базы или новая пустая. */
  public Hub hub(String roomId) {
    return boards.computeIfAbsent(roomId, this::load);
  }

  /** Доска, если она уже в памяти. */
  public Optional<Hub> existing(String roomId) {
    return Optional.ofNullable(boards.get(roomId));
  }

  /** Все доски в памяти — для прохода прав и записи. */
  public Collection<Hub> all() {
    return List.copyOf(boards.values());
  }

  /**
   * Посадить участника за доску. Доску могли как раз выгрузить из памяти — тогда берётся свежая:
   * иначе участник сидел бы за доской, которой больше никто не видит.
   */
  public Hub attach(String roomId, BoardPeer peer, java.util.function.Consumer<Hub> joined) {
    while (true) {
      var hub = hub(roomId);
      synchronized (hub.room) {
        if (!hub.evicted) {
          // Под тем же замком, что и рассылка: пачка, принятая в этот миг, придёт после сцены, а не
          // до.
          hub.peers.add(peer);
          joined.accept(hub);
          return hub;
        }
      }
    }
  }

  /** Участник ушёл. Последний ушедший — сцена пишется сразу. */
  public void detach(Hub hub, BoardPeer peer) {
    boolean last;
    synchronized (hub.room) {
      if (!hub.peers.remove(peer)) return;
      last = hub.peers.isEmpty();
      if (last) hub.idleSince = clock.millis();
    }
    if (last) save(hub);
  }

  /** Разослать надёжное всем, кроме {@code except}. Вызывать под замком доски. */
  public static void broadcast(Hub hub, BoardPeer except, String message) {
    for (var peer : hub.peers) if (peer != except) peer.send(message);
  }

  /** Разослать эфемерное всем, кроме {@code except}. */
  public static void broadcast(Hub hub, BoardPeer except, Ephemeral message) {
    synchronized (hub.room) {
      for (var peer : hub.peers) if (peer != except) peer.ephemeral(message);
    }
  }

  /**
   * Очистить доску у всех (команда {@code board.clear}): новое поколение, пустая сцена, картинки
   * удаляются. Всем участникам — {@code cleared}.
   */
  public void clear(String roomId, String by) {
    var hub = hub(roomId);
    synchronized (hub.room) {
      long epoch = hub.room.clear();
      broadcast(
          hub,
          null,
          Json.write(Map.of("type", "cleared", "epoch", epoch, "seq", hub.room.seq(), "by", by)));
    }
    store.deleteAllFiles(roomId);
    save(hub);
  }

  /** Проход записи: доски с новым — раз в {@code flush-ms}, пустые и записанные — из памяти. */
  public void flushDue() {
    long now = clock.millis();
    for (var hub : all()) {
      boolean empty;
      synchronized (hub.room) {
        empty = hub.peers.isEmpty();
      }
      if (hub.room.dirty() && (empty || now - hub.flushedAt >= limits.flushMs())) save(hub);
      else if (empty && !hub.room.dirty() && now - hub.idleSince >= limits.idleMs())
        synchronized (hub.room) {
          if (hub.peers.isEmpty() && !hub.room.dirty()) {
            hub.evicted = true;
            boards.remove(hub.room.roomId(), hub);
          }
        }
    }
  }

  /** Записать сцену сейчас. Комнаты уже нет — доска забывается, участники отключаются. */
  public void save(Hub hub) {
    if (!hub.flushing.compareAndSet(false, true)) return;
    try {
      var scene = hub.room.scene();
      boolean stored;
      try {
        stored =
            store.save(
                hub.room.roomId(),
                scene.epoch(),
                scene.seq(),
                scene.elements(),
                scene.oldest(),
                clock.millis());
      } catch (RuntimeException e) {
        saveFailures.incrementAndGet();
        log.warn("Доска {} не записалась: {}", hub.room.roomId(), e.toString());
        return;
      }
      hub.flushedAt = clock.millis();
      if (stored) {
        hub.room.saved(scene.seq(), scene.epoch());
        return;
      }
      List<BoardPeer> peers;
      synchronized (hub.room) {
        hub.evicted = true;
        boards.remove(hub.room.roomId(), hub);
        peers = List.copyOf(hub.peers);
        hub.peers.clear();
      }
      for (var peer : peers) peer.close("BOARD_CLOSED");
    } finally {
      hub.flushing.set(false);
    }
  }

  /**
   * Учесть пачку правок: сколько элементов принято и сколько отклонено (версия, предел) — для
   * метрик.
   */
  public void counted(BoardRoom.Applied applied) {
    accepted.addAndGet(applied.accepted());
    rejected.addAndGet(applied.rejected().size());
  }

  /** Элементов принято с запуска ядра. */
  public long accepted() {
    return accepted.get();
  }

  /** Элементов отклонено с запуска ядра. */
  public long rejected() {
    return rejected.get();
  }

  /** Неудачных записей сцены в базу с запуска ядра. */
  public long saveFailures() {
    return saveFailures.get();
  }

  /** Сокетов на всех досках сейчас. */
  public int peerCount() {
    int count = 0;
    for (var hub : all()) count += hub.peers().size();
    return count;
  }

  /** Записать все доски — при остановке ядра. */
  @jakarta.annotation.PreDestroy
  public void saveAll() {
    for (var hub : all()) if (hub.room.dirty()) save(hub);
  }

  /**
   * Сцена целиком — тем же сообщением, что получает входящий ({@code scene}): поколение, номер,
   * картинки и элементы с отметками удалённых.
   */
  public static String sceneMessage(BoardRoom.Scene scene) {
    var files = new ArrayList<Map<String, Object>>();
    for (var file : scene.files())
      files.add(Map.of("id", file.id(), "mime", file.mime(), "size", file.size()));
    return "{\"type\":\"scene\",\"epoch\":"
        + scene.epoch()
        + ",\"seq\":"
        + scene.seq()
        + ",\"files\":"
        + Json.write(files)
        + ",\"els\":"
        + scene.elements()
        + "}";
  }

  /** Сколько убрала очистка по сроку: доски, элементы, картинки. */
  public record Swept(int boards, int elements, int files) {}

  /**
   * Очистка по сроку (Р-134, раз в час из {@code room.Retention}): с каждой доски, где есть что-то
   * не новее {@code cutoff}, уходят старые элементы и картинки ({@link BoardRoom#expire}).
   *
   * <p>Доски берутся из памяти (там правки свежее базы) и из базы — по {@code content_at} сцены и
   * времени загрузки картинок; доска не в памяти поднимается тем же путём, что у входящего, и
   * уходит обратно обычной выгрузкой. Убрано что-то — участникам сразу уходит новая сцена нового
   * поколения: браузер заменяет ею свою ({@code scene} с другим {@code epoch}), а вернувшийся со
   * старым поколением возьмёт её целиком. Картинки удаляются из базы, затем сцена записывается.
   */
  public Swept expire(long cutoff) {
    var due = new LinkedHashSet<String>(store.due(cutoff));
    for (var hub : all()) if (hub.room.oldest() <= cutoff) due.add(hub.room.roomId());
    int boardsSwept = 0, elements = 0, files = 0;
    for (var roomId : due) {
      // Доску, которую поднял сам проход, он же и выгружает: первый проход после выкатки проверяет
      // все прежние доски, и держать их в памяти разом незачем.
      boolean loaded = !boards.containsKey(roomId);
      Hub hub;
      try {
        hub = hub(roomId);
      } catch (RuntimeException e) {
        log.warn("Доска {} не поднялась для очистки: {}", roomId, e.toString());
        continue;
      }
      BoardRoom.Expired expired;
      synchronized (hub.room) {
        expired = hub.room.expire(cutoff);
        if (expired != null) broadcast(hub, null, sceneMessage(hub.room.scene()));
      }
      if (expired == null) {
        // Убирать нечего (сцена до этого выпуска или правки свежее записи) — запомнить срок, чтобы
        // следующий проход доску не поднимал.
        if (!hub.room.dirty()) store.checked(roomId, hub.room.oldest());
      } else {
        store.deleteFiles(roomId, expired.files());
        save(hub);
        boardsSwept++;
        elements += expired.elements();
        files += expired.files().size();
      }
      if (loaded) unload(hub);
    }
    return new Swept(boardsSwept, elements, files);
  }

  /** Выгрузить доску, за которой никого нет и в которой нет незаписанного. */
  private void unload(Hub hub) {
    synchronized (hub.room) {
      if (hub.peers.isEmpty() && !hub.room.dirty()) {
        hub.evicted = true;
        boards.remove(hub.room.roomId(), hub);
      }
    }
  }

  /** Самое старое на досках в памяти ({@link Long#MAX_VALUE} — пусто). */
  public long oldestInMemory() {
    long oldest = Long.MAX_VALUE;
    for (var hub : all()) oldest = Math.min(oldest, hub.room.oldest());
    return oldest;
  }

  private Hub load(String roomId) {
    var files = store.files(roomId);
    var room =
        store
            .load(roomId)
            .map(
                saved ->
                    BoardRoom.restore(
                        roomId,
                        limits,
                        clock::millis,
                        saved.epoch(),
                        saved.seq(),
                        saved.elements(),
                        files,
                        saved.savedAt()))
            .orElseGet(
                () -> {
                  var fresh = new BoardRoom(roomId, limits, clock::millis);
                  files.forEach(fresh::addFile);
                  return fresh;
                });
    return new Hub(room, clock.millis());
  }
}
