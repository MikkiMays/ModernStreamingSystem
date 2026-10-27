import { describe, expect, it } from 'vitest';
import {
  EPISODE_END_MS,
  MAX_ATTEMPTS,
  ORDERED_RETRY_MS,
  PathRetry,
  STARVED_RETRY_MS,
  starvedUplink,
} from './path-retry';

const tcp = { connected: true, ordered: true, starved: false };
const udp = { connected: true, ordered: false, starved: false };
const narrow = { ...udp, starved: true };

/** Когда случатся перезапуски за `ms`, если замер — раз в две секунды (мс от начала). */
function restarts(retry: PathRetry, signals: (now: number) => typeof tcp, from: number, ms: number) {
  const at: number[] = [];
  for (let now = from; now <= from + ms; now += 2000)
    if (retry.observe(signals(now), now)) at.push(now - from);
  return at;
}
const always = (signals: typeof tcp) => () => signals;

describe('возврат медиа на хороший путь', () => {
  it('на TCP — четыре попытки за пять минут, дальше молчит хоть десять часов', () => {
    const at = restarts(new PathRetry(), always(tcp), 0, 10 * 3600_000);
    expect(at).toHaveLength(MAX_ATTEMPTS);
    expect(at[0]).toBe(ORDERED_RETRY_MS);
    expect(at.slice(1).map((value, index) => value - at[index]!)).toEqual([40_000, 80_000, 160_000]);
  });

  it('на хорошем UDP за десять часов — ни одной попытки', () => {
    expect(restarts(new PathRetry(), always(udp), 0, 10 * 3600_000)).toEqual([]);
  });

  it('пока ICE не connected, молчит: переподключение — дело SDK', () => {
    expect(restarts(new PathRetry(), always({ ...tcp, connected: false }), 0, 3600_000)).toEqual([]);
  });

  it('узкий канал — первая попытка не раньше 45 с', () => {
    const [first] = restarts(new PathRetry(), always(narrow), 0, 60_000);
    expect(first).toBeGreaterThanOrEqual(STARVED_RETRY_MS);
    expect(first).toBeLessThan(STARVED_RETRY_MS + 2000);
  });

  it('мигающий «канал душит» не начинает серию заново: попыток всё так же четыре', () => {
    const flapping = (now: number) => (Math.floor(now / 6000) % 2 ? narrow : udp);
    expect(restarts(new PathRetry(), flapping, 0, 10 * 3600_000)).toHaveLength(MAX_ATTEMPTS);
  });

  it('событие после молчания — новая серия, и первая попытка сразу', () => {
    const retry = new PathRetry();
    restarts(retry, always(tcp), 0, 3600_000);
    retry.wake();
    const at = restarts(retry, always(tcp), 3600_000 + 2000, 3600_000);
    expect(at[0]).toBe(0);
    expect(at).toHaveLength(MAX_ATTEMPTS);
  });

  it('событие на хорошем пути ничего не запускает', () => {
    const retry = new PathRetry();
    retry.wake();
    expect(restarts(retry, always(udp), 0, 60_000)).toEqual([]);
  });

  it('минута хорошего пути заканчивает эпизод: новый плохой — с короткой паузы', () => {
    const retry = new PathRetry();
    restarts(retry, always(tcp), 0, 3600_000);
    restarts(retry, always(udp), 3600_000 + 2000, EPISODE_END_MS);
    expect(restarts(retry, always(tcp), 3600_000 + EPISODE_END_MS + 4000, 60_000)[0]).toBe(ORDERED_RETRY_MS);
  });
});

describe('отдачу душит канал', () => {
  const sending = {
    limitation: 'none',
    fps: 60,
    targetFps: 60,
    sourceFps: 60,
    settling: false,
    dormant: false,
  };

  it('Chrome и Firefox называют причину сами', () => {
    expect(starvedUplink({ ...sending, limitation: 'bandwidth', fps: 50 })).toBe(true);
    expect(starvedUplink({ ...sending, limitation: 'cpu', fps: 5 })).toBe(false);
    expect(starvedUplink({ ...sending, limitation: 'none', fps: 5 })).toBe(false);
  });

  it('Safari причину не называет — признак по частоте: меньше половины ожидаемой', () => {
    const safari = { ...sending, limitation: 'unknown' };
    expect(starvedUplink({ ...safari, fps: 5 })).toBe(true);
    expect(starvedUplink({ ...safari, fps: 40 })).toBe(false);
    // Камера сама даёт 30 при выставленных 60 — это не канал.
    expect(starvedUplink({ ...safari, fps: 28, sourceFps: 30 })).toBe(false);
    expect(starvedUplink({ ...safari, fps: 10, sourceFps: 30 })).toBe(true);
  });

  it('разгон, спящий слой, ноль кадров и нет видео — не повод', () => {
    const safari = { ...sending, limitation: 'unknown', fps: 5 };
    expect(starvedUplink({ ...safari, settling: true })).toBe(false);
    expect(starvedUplink({ ...safari, dormant: true })).toBe(false);
    expect(starvedUplink({ ...safari, fps: 0 })).toBe(false);
    expect(starvedUplink({ ...sending, limitation: 'bandwidth', settling: true })).toBe(false);
    expect(starvedUplink(null)).toBe(false);
  });
});

describe('путь плохой — следим, не появилась ли другая сеть', () => {
  it('плохой замер — неприятности; минута хорошего — кончились', () => {
    const retry = new PathRetry();
    expect(retry.troubled).toBe(false);
    retry.observe(tcp, 0);
    expect(retry.troubled).toBe(true);
    retry.observe(udp, 2000);
    expect(retry.troubled).toBe(true);
    retry.observe(udp, 2000 + EPISODE_END_MS);
    expect(retry.troubled).toBe(false);
  });
});
