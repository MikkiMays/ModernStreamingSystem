package dev.mikki.stream.board;

/**
 * Ведро частоты одного сокета доски (R159): {@code perSecond} в секунду, с запасом {@code burst}.
 *
 * <p>В памяти, а не в Redis, как пределы команд: правки штриха идут десятки раз в секунду, и ходить
 * за каждой в Redis значило бы сделать горячий путь доски сетевым. Предел — от кривого или чужого
 * клиента: браузер шлёт не чаще кадра.
 */
public final class Bucket {
  private final double perMs;
  private final double burst;
  private double tokens;
  private long at;

  public Bucket(double perSecond, double burst, long now) {
    this.perMs = perSecond / 1000.0;
    this.burst = burst;
    this.tokens = burst;
    this.at = now;
  }

  /** Взять одну отправку; {@code false} — предел выбран. */
  public synchronized boolean take(long now) {
    if (now > at) {
      tokens = Math.min(burst, tokens + (now - at) * perMs);
      at = now;
    }
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  }
}
