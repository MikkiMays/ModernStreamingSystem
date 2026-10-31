package dev.mikki.stream.board;

import java.util.ArrayDeque;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.concurrent.Executor;

/**
 * Очередь одного сокета доски (R159) — обратное давление без потерь надёжного.
 *
 * <p>У каждого сокета своя очередь и свой отправитель: медленный участник (телефон на плохой сети)
 * не задерживает рассылку остальным, а доска раскладывает пачку по очередям за микросекунды, не
 * дожидаясь сети. Отправитель один на сокет — сообщения уходят строго в порядке очереди.
 *
 * <ul>
 *   <li><b>Надёжное</b> (правки, сцена, очистка) — по порядку и целиком. Если его копится больше
 *       {@code limit} байт, сокет не успевает: он закрывается, и браузер, вернувшись, берёт
 *       пропущенное по {@code since} или сцену целиком. Это лучше, чем держать в памяти ядра чужое
 *       отставание.
 *   <li><b>Эфемерное</b> (курсоры, лазер, штрих «в процессе») — после надёжного, схлопнутое по
 *       автору: медленный сокет получает последнее место курсора, а не всю его дорогу.
 * </ul>
 */
public final class Outbox {
  /** Куда отправлять. {@code send} блокирует, пока сообщение не ушло в сеть. */
  public interface Sink {
    void send(String text) throws Exception;

    void close();
  }

  /** Эфемерных ключей у одного сокета не бывает больше: это авторы и их штрихи. */
  static final int MAX_EPHEMERAL = 256;

  private final Sink sink;
  private final Executor executor;
  private final long limit;
  private final ArrayDeque<String> reliable = new ArrayDeque<>();
  private long bytes;
  private final LinkedHashMap<String, Ephemeral> ephemeral = new LinkedHashMap<>();
  private boolean draining;
  private boolean closed;
  private volatile long sendingSince;

  public Outbox(Sink sink, Executor executor, long limit) {
    this.sink = sink;
    this.executor = executor;
    this.limit = limit;
  }

  /** Надёжное сообщение. {@code false} — очередь переполнена, и сокет закрыт. */
  public boolean reliable(String text) {
    boolean overflow;
    synchronized (this) {
      if (closed) return false;
      // Первое сообщение в пустой очереди проходит любым: это может быть вся сцена.
      overflow = !reliable.isEmpty() && bytes + text.length() > limit;
      if (overflow) closed = true;
      else {
        reliable.addLast(text);
        bytes += text.length();
      }
    }
    if (overflow) {
      sink.close();
      return false;
    }
    kick();
    return true;
  }

  /** Эфемерное сообщение: склеивается с ждущим того же ключа. */
  public void ephemeral(Ephemeral message) {
    synchronized (this) {
      if (closed) return;
      var waiting = ephemeral.remove(message.key());
      ephemeral.put(message.key(), waiting == null ? message : waiting.merge(message));
      if (ephemeral.size() > MAX_EPHEMERAL) {
        Iterator<String> eldest = ephemeral.keySet().iterator();
        eldest.next();
        eldest.remove();
      }
    }
    kick();
  }

  /** Сколько байт надёжного ждёт отправки. */
  public synchronized long pending() {
    return bytes;
  }

  /** Отправка висит дольше {@code timeoutMs}: сеть встала, сокет пора закрыть. */
  public boolean stuck(long now, long timeoutMs) {
    long since = sendingSince;
    return since > 0 && now - since > timeoutMs;
  }

  public void close() {
    synchronized (this) {
      if (closed) return;
      closed = true;
      reliable.clear();
      ephemeral.clear();
      bytes = 0;
    }
    sink.close();
  }

  public synchronized boolean closed() {
    return closed;
  }

  private void kick() {
    synchronized (this) {
      if (draining || closed) return;
      draining = true;
    }
    executor.execute(this::drain);
  }

  private void drain() {
    while (true) {
      String next;
      synchronized (this) {
        if (closed) {
          draining = false;
          return;
        }
        next = reliable.pollFirst();
        if (next != null) bytes -= next.length();
        else {
          var eldest = ephemeral.entrySet().iterator();
          if (!eldest.hasNext()) {
            draining = false;
            return;
          }
          next = eldest.next().getValue().render();
          eldest.remove();
        }
      }
      sendingSince = System.currentTimeMillis();
      try {
        sink.send(next);
      } catch (Exception e) {
        sendingSince = 0;
        close();
        synchronized (this) {
          draining = false;
        }
        return;
      }
      sendingSince = 0;
    }
  }
}
