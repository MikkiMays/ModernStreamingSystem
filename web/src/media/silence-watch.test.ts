import { describe, expect, it } from 'vitest';
import { SILENCE_MS, STALL_MS, SilenceWatch, transportKeepalives } from './silence-watch';

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

  it('браузер не отдаёт STUN-счётчики пары — молчание RTP не повод: тихая встреча не толкается', () => {
    const watch = new SilenceWatch();
    for (let t = 0; t <= 60_000; t += 2000) expect(watch.observe(sample(t, 1000, 0)), `t=${t}`).toBe(false);
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

describe('SilenceWatch.stall — подсказка ядру о молчании (R200 §5.3, Р-105)', () => {
  /** Опрос раз в 2 с до `until`, как в session.ts; возвращает, что сказал бы ядру каждый опрос. */
  const run = (watch: SilenceWatch, from: number, until: number, rtp: number, keepalives: number) => {
    const said: Array<[number, ReturnType<SilenceWatch['stall']>]> = [];
    for (let t = from; t <= until; t += 2000) {
      watch.observe(sample(t, rtp, keepalives));
      said.push([t, watch.stall()]);
    }
    return said.filter(([, what]) => what !== null);
  };

  it('SFU умер: `begin` ровно один раз через STALL_MS, раньше толчка SILENCE_MS; жизнь вернулась — `end`', () => {
    const watch = new SilenceWatch();
    watch.observe(sample(0, 100, 5));
    expect(watch.stall()).toBeNull();
    expect(run(watch, 2000, 20_000, 100, 5)).toEqual([[STALL_MS + 1000, 'begin']]);
    expect(STALL_MS).toBeLessThan(SILENCE_MS);
    // Жизнь (счётчики пошли) — одно `end`, и дальше тишина.
    watch.observe(sample(22_000, 100, 6));
    expect(watch.stall()).toBe('end');
    watch.observe(sample(24_000, 100, 7));
    expect(watch.stall()).toBeNull();
    // Новая смерть — новый эпизод.
    expect(run(watch, 26_000, 40_000, 100, 7)).toEqual([[24_000 + STALL_MS + 1000, 'begin']]);
  });

  it('тихая встреча с consent раз в 2,5 с — ни одной подсказки за минуту', () => {
    const watch = new SilenceWatch();
    let keepalives = 10;
    for (let t = 0; t <= 60_000; t += 2000) {
      if (t % 4000 === 0) keepalives++;
      watch.observe(sample(t, 1000, keepalives));
      expect(watch.stall(), `t=${t}`).toBeNull();
    }
  });

  it('замирание хоста на 2–4 с не даёт подсказки: счётчики пошли раньше порога', () => {
    const watch = new SilenceWatch();
    watch.observe(sample(0, 100, 5));
    watch.observe(sample(2000, 100, 5));
    expect(watch.stall()).toBeNull();
    watch.observe(sample(4000, 100, 5));
    expect(watch.stall()).toBeNull();
    watch.observe(sample(6000, 100, 6));
    expect(watch.stall()).toBeNull();
  });

  it('скрытая вкладка, нет подписок, ICE или SDK не подключены, STUN не отдаётся — не повод', () => {
    const dead = (patch: Record<string, boolean>, keepalives = 1) => {
      const watch = new SilenceWatch();
      watch.observe(sample(0, 1, keepalives));
      watch.observe(sample(STALL_MS + 1, 1, keepalives, patch));
      return watch.stall();
    };
    expect(dead({ hidden: true })).toBeNull();
    expect(dead({ subscribed: false })).toBeNull();
    expect(dead({ iceConnected: false })).toBeNull();
    expect(dead({ connected: false })).toBeNull();
    expect(dead({}, 0)).toBeNull();
    expect(dead({})).toBe('begin');
  });

  it('переподключение сбрасывает эпизод: ни `end` без `begin`, ни старого отсчёта', () => {
    const watch = new SilenceWatch();
    watch.observe(sample(0, 100, 5));
    watch.observe(sample(STALL_MS + 1000, 100, 5));
    expect(watch.stall()).toBe('begin');
    watch.reset(10_000);
    watch.observe(sample(10_000, 0, 0));
    expect(watch.stall()).toBeNull();
    watch.observe(sample(12_000, 0, 1));
    expect(watch.stall()).toBeNull();
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
