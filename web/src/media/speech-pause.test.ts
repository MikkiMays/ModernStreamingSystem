import { afterEach, describe, expect, it, vi } from 'vitest';
import { receivedLevel, waitForPause } from './speech-pause';

afterEach(() => vi.useRealTimers());

describe('пауза говорящего для переподписки речи (R107)', () => {
  it('ждёт 300 мс тишины подряд, а не одно тихое мгновение между слогами', async () => {
    vi.useFakeTimers();
    // Говорит, на 100 мс затих (слог), снова говорит, потом пауза.
    const levels = [0.3, 0.2, 0.005, 0.3, 0.25, 0.004, 0.003, 0.002, 0.2];
    let i = 0;
    const read = vi.fn(() => levels[Math.min(i++, levels.length - 1)]);
    const result = waitForPause(read);
    await vi.advanceTimersByTimeAsync(800);
    await expect(result).resolves.toBe(true);
    // Пауза признана на восьмом взгляде (третий тихий подряд), не на третьем.
    expect(read).toHaveBeenCalledTimes(8);
  });

  it('человек говорит без пауз — не переподписываем вовсе', async () => {
    vi.useFakeTimers();
    const result = waitForPause(() => 0.2, { withinMs: 2000 });
    await vi.advanceTimersByTimeAsync(2100);
    await expect(result).resolves.toBe(false);
  });

  it('пакетов нет (DTX молчит) — это тоже пауза', async () => {
    vi.useFakeTimers();
    const result = waitForPause(() => undefined);
    await vi.advanceTimersByTimeAsync(300);
    await expect(result).resolves.toBe(true);
  });

  it('отмена — без переподписки', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const result = waitForPause(() => 0.2, { signal: abort.signal });
    abort.abort();
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toBe(false);
  });

  it('громкость — у самого свежего пакета; без API — неизвестно', () => {
    const receiver = {
      getSynchronizationSources: () => [
        { timestamp: 10, audioLevel: 0.5 },
        { timestamp: 20, audioLevel: 0.001 },
      ],
    } as unknown as RTCRtpReceiver;
    expect(receivedLevel(receiver)).toBe(0.001);
    expect(receivedLevel({} as RTCRtpReceiver)).toBeUndefined();
    expect(receivedLevel(undefined)).toBeUndefined();
  });
});
