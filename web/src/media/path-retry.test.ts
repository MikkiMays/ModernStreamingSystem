import { describe, expect, it } from 'vitest';
import { MAX_RETRY_MS, ORDERED_RETRY_MS, PathRetry, STARVED_RETRY_MS } from './path-retry';

const tcp = { connected: true, ordered: true, starved: false };
const udp = { connected: true, ordered: false, starved: false };

/** Сколько перезапусков случится за `ms`, если замер — раз в две секунды. */
function restarts(retry: PathRetry, signals: typeof tcp, from: number, ms: number) {
  const at: number[] = [];
  for (let now = from; now <= from + ms; now += 2000) if (retry.observe(signals, now)) at.push(now - from);
  return at;
}

describe('возврат медиа на хороший путь', () => {
  it('на TCP перезапускает ICE через 20 с, дальше — с удвоением до пяти минут', () => {
    const at = restarts(new PathRetry(), tcp, 0, 30 * 60_000);
    expect(at[0]).toBe(ORDERED_RETRY_MS);
    const gaps = at.slice(1).map((value, index) => value - at[index]!);
    expect(gaps.slice(0, 4)).toEqual([40_000, 80_000, 160_000, MAX_RETRY_MS]);
    expect(Math.max(...gaps)).toBe(MAX_RETRY_MS);
  });

  it('на UDP не трогает ничего', () => {
    expect(restarts(new PathRetry(), udp, 0, 10 * 60_000)).toEqual([]);
  });

  it('пока ICE не connected, молчит: переподключение — дело SDK', () => {
    expect(restarts(new PathRetry(), { ...tcp, connected: false }, 0, 5 * 60_000)).toEqual([]);
  });

  it('узкий канал на UDP — повод, но не раньше 45 с', () => {
    const at = restarts(new PathRetry(), { ...udp, starved: true }, 0, 60_000);
    expect(at).toHaveLength(1);
    expect(at[0]).toBeGreaterThanOrEqual(STARVED_RETRY_MS);
    expect(at[0]).toBeLessThan(STARVED_RETRY_MS + 2000);
  });

  it('вернулись на UDP — счёт попыток забывается через две минуты', () => {
    const retry = new PathRetry();
    restarts(retry, tcp, 0, 10 * 60_000);
    restarts(retry, udp, 10 * 60_000 + 2000, 130_000);
    // Снова TCP: опять с короткой паузы, а не с пяти минут.
    expect(restarts(retry, tcp, 13 * 60_000, 60_000)[0]).toBe(ORDERED_RETRY_MS);
  });
});
