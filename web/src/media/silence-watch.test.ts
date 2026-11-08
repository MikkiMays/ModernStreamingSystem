import { describe, expect, it } from 'vitest';
import { SILENCE_MS, SilenceWatch, transportKeepalives } from './silence-watch';

const sample = (
  now: number,
  rtpBytes: number,
  keepalives: number,
  patch: Partial<Parameters<SilenceWatch['observe']>[0]> = {},
) => ({
  now,
  rtpBytes,
  keepalives,
  hidden: false,
  connected: true,
  iceConnected: true,
  subscribed: true,
  ...patch,
});

describe('SilenceWatch', () => {
  it('тихая встреча с выключенными микрофонами: RTP стоит, consent идёт — толчка нет', () => {
    const watch = new SilenceWatch();
    let keepalives = 10;
    for (let t = 0; t <= 60_000; t += 2000) {
      // Chrome пингует пару раз в ≈ 2,5 с: счётчик растёт не на каждом опросе, но в любые 6 с — да.
      if (t % 4000 === 0) keepalives++;
      expect(watch.observe(sample(t, 1000, keepalives)), `t=${t}`).toBe(false);
    }
  });

  it('всё умерло: ровно один толчок на эпизод, следующий — только после возврата жизни', () => {
    const watch = new SilenceWatch();
    expect(watch.observe(sample(0, 100, 5))).toBe(false);
    expect(watch.observe(sample(2000, 100, 5))).toBe(false);
    expect(watch.observe(sample(4000, 100, 5))).toBe(false);
    expect(watch.observe(sample(SILENCE_MS, 100, 5))).toBe(true);
    expect(watch.observe(sample(SILENCE_MS + 2000, 100, 5))).toBe(false);
    expect(watch.observe(sample(SILENCE_MS + 20_000, 100, 5))).toBe(false);
    // Переподключение само эпизод не кончает…
    watch.reset(30_000);
    expect(watch.observe(sample(30_000, 0, 0))).toBe(false);
    expect(watch.observe(sample(30_000 + SILENCE_MS, 0, 0))).toBe(false);
    // …его кончает увиденная жизнь; потом новая смерть — новый толчок.
    expect(watch.observe(sample(40_000, 0, 1))).toBe(false);
    expect(watch.observe(sample(40_000 + SILENCE_MS, 0, 1))).toBe(true);
  });

  it('скрытая вкладка, нет подписок, ICE или SDK не подключены — молчание не повод', () => {
    const dead = (patch: Record<string, boolean>) => {
      const watch = new SilenceWatch();
      watch.observe(sample(0, 1, 1));
      return watch.observe(sample(SILENCE_MS + 1, 1, 1, patch));
    };
    expect(dead({ hidden: true })).toBe(false);
    expect(dead({ subscribed: false })).toBe(false);
    expect(dead({ iceConnected: false })).toBe(false);
    expect(dead({ connected: false })).toBe(false);
    expect(dead({})).toBe(true);
  });

  it('после переподключения счётчики начинаются с нуля — падение тоже считается жизнью', () => {
    const watch = new SilenceWatch();
    watch.observe(sample(0, 5000, 300));
    watch.reset(1000);
    expect(watch.observe(sample(1000, 20, 2))).toBe(false);
    expect(watch.observe(sample(3000, 20, 3))).toBe(false);
    expect(watch.observe(sample(1000 + SILENCE_MS + 1, 20, 3))).toBe(false);
  });
});

describe('transportKeepalives', () => {
  const report = (stats: Record<string, unknown>[]) =>
    ({
      forEach: (fn: (s: Record<string, unknown>) => void) => stats.forEach(fn),
    }) as unknown as RTCStatsReport;

  it('берёт выбранную пару по transport.selectedCandidatePairId, иначе — nominated, максимум по отчётам', () => {
    const a = report([
      { type: 'transport', selectedCandidatePairId: 'p2' },
      { type: 'candidate-pair', id: 'p1', nominated: true, requestsReceived: 100, responsesReceived: 100 },
      { type: 'candidate-pair', id: 'p2', requestsReceived: 7, responsesReceived: 8 },
    ]);
    const b = report([
      { type: 'candidate-pair', id: 'x', nominated: true, requestsReceived: 3, responsesReceived: 4 },
    ]);
    expect(transportKeepalives([a])).toBe(15);
    expect(transportKeepalives([b])).toBe(7);
    expect(transportKeepalives([a, b])).toBe(15);
    expect(transportKeepalives([])).toBe(0);
  });
});
