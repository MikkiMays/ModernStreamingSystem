import { describe, expect, it } from 'vitest';
import {
  applyPlayoutTarget,
  measuredDelayMs,
  PlayoutBuffer,
  profileFor,
  MAX_TARGET_MS,
  type PlayoutSample,
} from './playout';
import { unknownLink, type LinkState } from './link-quality';

const RATE = 48000;
/** Отчёт inbound-rtp через `seconds` секунд непрерывного звука. */
function audio(seconds: number, extra: Partial<PlayoutSample> = {}): PlayoutSample {
  return {
    timestamp: seconds * 1000,
    totalSamplesReceived: Math.round(seconds * RATE),
    concealedSamples: 0,
    silentConcealedSamples: 0,
    removedSamplesForAcceleration: 0,
    jitterBufferEmittedCount: Math.round(seconds * RATE),
    jitterBufferDelay: 0,
    ...extra,
  };
}
const link = (patch: Partial<LinkState>): LinkState => ({ ...unknownLink, ...patch });

describe('профиль запаса', () => {
  it('никогда не просит нулевой буфер — даже в режиме минимальной задержки', () => {
    for (const mode of ['auto', 'low-latency', 'stable'] as const)
      for (const kind of ['conversation', 'media', 'video'] as const)
        expect(profileFor(kind, mode).floorMs).toBeGreaterThan(0);
  });
  it('музыке даёт запас на порядок больше, чем разговору', () => {
    expect(profileFor('media', 'auto').startMs).toBeGreaterThan(profileFor('conversation', 'auto').ceilingMs);
  });
  it('разговор остаётся разговором: полсекунды — потолок, а не цель', () => {
    expect(profileFor('conversation', 'auto').ceilingMs).toBeLessThanOrEqual(500);
    expect(profileFor('conversation', 'low-latency').startMs).toBeLessThan(
      profileFor('conversation', 'auto').startMs,
    );
    expect(profileFor('conversation', 'stable').floorMs).toBeGreaterThan(
      profileFor('conversation', 'auto').floorMs,
    );
  });
  it('на упорядоченном пути пол поднимается до полутора оборотов', () => {
    // TURN поверх TLS переспрашивает потерянный пакет и задерживает всё, что пришло следом.
    // Запас меньше оборота там не спасает ни от чего.
    const profile = profileFor('conversation', 'auto', link({ ordered: true, rttMs: 200 }));
    expect(profile.floorMs).toBe(450);
    expect(profile.startMs).toBeGreaterThanOrEqual(profile.floorMs);
    expect(profile.ceilingMs).toBeGreaterThan(profile.floorMs);
  });
  it('прямой UDP не доплачивает за чужую проблему', () => {
    expect(profileFor('conversation', 'auto', link({ path: 'direct-udp' })).floorMs).toBe(
      profileFor('conversation', 'auto').floorMs,
    );
  });
  it('ни один профиль не выходит за то, что браузер способен удержать', () => {
    for (const mode of ['auto', 'low-latency', 'stable'] as const) {
      const profile = profileFor('media', mode, link({ ordered: true, rttMs: 5000 }));
      expect(profile.ceilingMs).toBeLessThanOrEqual(MAX_TARGET_MS);
      expect(profile.floorMs).toBeLessThanOrEqual(profile.ceilingMs);
    }
  });
});

describe('решение по дорожке', () => {
  it('признаёт задержку, которую сеть уже создала, вместо гонки за ней', () => {
    // Это и есть «музыка то ускоряется»: пакеты пришли пачкой, буфер полон на 1,6 с,
    // а цель — 800 мс, поэтому NetEq выбрасывает звук, догоняя её. Слышно как плывущий темп.
    const buffer = new PlayoutBuffer('media', profileFor('media', 'auto'), 0);
    buffer.observe(audio(0), 0);
    const decision = buffer.observe(
      audio(2, {
        removedSamplesForAcceleration: 0.02 * 2 * RATE,
        jitterBufferDelay: 1.6 * 2 * RATE,
      }),
      2000,
    );
    expect(decision.measuredMs).toBeCloseTo(1600, 0);
    expect(decision.accelerationRatio).toBeCloseTo(0.02, 3);
    expect(decision.targetMs).toBe(1600);
  });
  it('разговору такого послабления не делает: там лучше подъесть паузу, чем уехать на секунды', () => {
    const buffer = new PlayoutBuffer('conversation', profileFor('conversation', 'auto'), 0);
    buffer.observe(audio(0), 0);
    const decision = buffer.observe(
      audio(2, {
        removedSamplesForAcceleration: 0.02 * 2 * RATE,
        jitterBufferDelay: 1.6 * 2 * RATE,
      }),
      2000,
    );
    expect(decision.targetMs).toBe(profileFor('conversation', 'auto').startMs);
  });
  it('на первую же слышимую заглушку добавляет запас сразу, а не шагами', () => {
    const buffer = new PlayoutBuffer('conversation', profileFor('conversation', 'auto'), 0);
    buffer.observe(audio(0), 0);
    const before = buffer.target;
    const decision = buffer.observe(audio(2, { concealedSamples: 0.01 * 2 * RATE }), 2000);
    expect(decision.concealRatio).toBeCloseTo(0.01, 3);
    expect(decision.targetMs).toBe(before + 150);
  });
  it('замирание картинки для видео — то же, что треск для звука', () => {
    const profile = profileFor('video', 'auto');
    const buffer = new PlayoutBuffer('video', profile, 0);
    buffer.observe({ timestamp: 0, freezeCount: 0 }, 0);
    const decision = buffer.observe({ timestamp: 2000, freezeCount: 2 }, 2000);
    expect(decision.freezes).toBe(2);
    expect(decision.targetMs).toBe(profile.startMs + 150);
    // Первый отчёт сравнивать не с чем, и накопленный счётчик за интервал не выдаётся.
    const fresh = new PlayoutBuffer('video', profile, 0);
    expect(fresh.observe({ timestamp: 0, freezeCount: 17 }, 0).freezes).toBe(0);
  });
  it('тишину DTX за поломку не считает', () => {
    const buffer = new PlayoutBuffer('conversation', profileFor('conversation', 'auto'), 0);
    buffer.observe(audio(0), 0);
    const decision = buffer.observe(
      audio(2, { concealedSamples: 0.3 * 2 * RATE, silentConcealedSamples: 0.3 * 2 * RATE }),
      2000,
    );
    expect(decision.concealRatio).toBe(0);
    expect(decision.targetMs).toBe(profileFor('conversation', 'auto').startMs);
  });
  it('на спокойной линии снижает запас маленькими шагами и не ниже пола', () => {
    const profile = profileFor('conversation', 'auto');
    const buffer = new PlayoutBuffer('conversation', profile, 0);
    buffer.observe(audio(0), 0);
    // Пока спокойствие не выдержано, цель не двигается.
    expect(buffer.observe(audio(2), 2000).targetMs).toBe(profile.startMs);
    let now = 2000;
    let previous = buffer.target;
    for (let step = 0; step < 60; step++) {
      now += profile.calmMs;
      const target = buffer.observe(audio(2 + step * 10 + 10), now).targetMs;
      expect(previous - target).toBeLessThanOrEqual(profile.stepMs);
      previous = target;
    }
    expect(previous).toBe(profile.floorMs);
  });
  it('держит запас в четыре джиттера и забывает всплеск постепенно', () => {
    const buffer = new PlayoutBuffer('conversation', profileFor('conversation', 'auto'), 0);
    buffer.observe(audio(0), 0);
    const spike = buffer.observe(audio(2, { jitter: 0.09 }), 2000).targetMs;
    expect(spike).toBe(360);
    // Всплеск ушёл, но цель не обрушивается следом: пик затухает, а не исчезает.
    const after = buffer.observe(audio(4, { jitter: 0 }), 4000).targetMs;
    expect(after).toBe(spike);
  });
  it('перезапуск счётчиков дорожки не сбрасывает уже набранный запас', () => {
    const buffer = new PlayoutBuffer('media', profileFor('media', 'auto'), 0);
    buffer.observe(audio(0), 0);
    buffer.observe(audio(2, { concealedSamples: 0.05 * 2 * RATE }), 2000);
    const raised = buffer.target;
    expect(raised).toBeGreaterThan(profileFor('media', 'auto').startMs);
    // Переподписка обнуляет счётчики: сравнивать не с чем, но канал лучше не стал.
    expect(buffer.observe(audio(0.1), 4000).targetMs).toBe(raised);
  });
  it('смена режима подрезает уже выбранную цель под новые границы', () => {
    const buffer = new PlayoutBuffer('media', profileFor('media', 'auto'), 0);
    buffer.observe(audio(0), 0);
    buffer.observe(audio(2, { concealedSamples: 0.05 * 2 * RATE }), 2000);
    buffer.retune(profileFor('media', 'low-latency'));
    expect(buffer.target).toBeLessThanOrEqual(profileFor('media', 'low-latency').ceilingMs);
    expect(buffer.target).toBeGreaterThanOrEqual(profileFor('media', 'low-latency').floorMs);
  });
});

describe('измерение фактического буфера', () => {
  it('считает по разнице, а не по накопленной сумме', () => {
    expect(measuredDelayMs(audio(2, { jitterBufferDelay: 96000 }), audio(0))).toBeCloseTo(1000, 0);
  });
  it('без новых выданных отсчётов ничего не выдумывает', () => {
    expect(measuredDelayMs(audio(1), audio(1))).toBeNull();
  });
});

describe('передача запаса приёмнику', () => {
  it('стандартное поле получает миллисекунды', () => {
    const receiver = { jitterBufferTarget: 0, playoutDelayHint: 0 };
    expect(applyPlayoutTarget(receiver as unknown as RTCRtpReceiver, 450)).toBe(true);
    expect(receiver.jitterBufferTarget).toBe(450);
    // Старое поле измеряется в секундах и умеет задержку закреплять, а не только поднимать,
    // поэтому пока работает стандартное, трогать его нельзя.
    expect(receiver.playoutDelayHint).toBe(0);
  });
  it('старое поле получает секунды и только когда стандартного нет', () => {
    const receiver = { playoutDelayHint: 0 };
    expect(applyPlayoutTarget(receiver as unknown as RTCRtpReceiver, 450)).toBe(true);
    expect(receiver.playoutDelayHint).toBeCloseTo(0.45, 5);
  });
  it('не просит больше, чем браузер способен удержать', () => {
    const receiver = { jitterBufferTarget: 0 };
    applyPlayoutTarget(receiver as unknown as RTCRtpReceiver, 99000);
    expect(receiver.jitterBufferTarget).toBe(MAX_TARGET_MS);
  });
  it('частично поддержанный API не мешает подписке и воспроизведению', () => {
    expect(applyPlayoutTarget(undefined, 200)).toBe(false);
    expect(applyPlayoutTarget({} as RTCRtpReceiver, 200)).toBe(false);
    const broken = {
      set jitterBufferTarget(_: number) {
        throw new Error('Unsupported');
      },
      playoutDelayHint: 0,
    };
    expect(applyPlayoutTarget(broken as unknown as RTCRtpReceiver, 200)).toBe(true);
    expect(broken.playoutDelayHint).toBeCloseTo(0.2, 5);
    const ended = {
      set playoutDelayHint(_: number) {
        throw new Error('Ended');
      },
    };
    expect(() => applyPlayoutTarget(ended as unknown as RTCRtpReceiver, 200)).not.toThrow();
  });
});
