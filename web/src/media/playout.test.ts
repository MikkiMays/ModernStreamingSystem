import { describe, expect, it } from 'vitest';
import {
  applyPlayoutTarget,
  classifyTrouble,
  measuredDelayMs,
  PlayoutBuffer,
  profileFor,
  MAX_TARGET_MS,
  SAMPLE_RATE,
  type PlayoutSample,
} from './playout';
import { unknownLink, type LinkState } from './link-quality';

const RATE = SAMPLE_RATE;
/** Отчёт inbound-rtp через `seconds` секунд непрерывного звука. */
function audio(seconds: number, extra: Partial<PlayoutSample> = {}): PlayoutSample {
  return {
    timestamp: seconds * 1000,
    totalSamplesReceived: Math.round(seconds * RATE),
    concealedSamples: 0,
    silentConcealedSamples: 0,
    concealmentEvents: 0,
    packetsLost: 0,
    removedSamplesForAcceleration: 0,
    jitterBufferEmittedCount: Math.round(seconds * RATE),
    jitterBufferDelay: 0,
    ...extra,
  };
}
const link = (patch: Partial<LinkState>): LinkState => ({ ...unknownLink, ...patch });
/** Опоздавшие пакеты: много коротких заглушек по 40 мс. */
const jittery = (events: number) => ({
  concealedSamples: Math.round(events * 0.04 * RATE),
  concealmentEvents: events,
});

describe('профиль запаса', () => {
  it('никогда не просит нулевой буфер', () => {
    for (const kind of ['conversation', 'media', 'video'] as const)
      expect(profileFor(kind).floorMs).toBeGreaterThan(0);
  });
  it('музыка живёт в одной секунде для всех: потолок 1000, пол 500', () => {
    const media = profileFor('media');
    expect(media.ceilingMs).toBe(1000);
    expect(media.floorMs).toBe(500);
    expect(media.ceilingMs - media.floorMs).toBeLessThanOrEqual(500);
  });
  it('разговор остаётся разговором: 400 мс — потолок, а не цель', () => {
    expect(profileFor('conversation').ceilingMs).toBeLessThanOrEqual(400);
    expect(profileFor('conversation').startMs).toBeLessThan(profileFor('media').floorMs);
  });
  it('на упорядоченном пути пол поднимается до полутора оборотов', () => {
    const profile = profileFor('conversation', link({ ordered: true, rttMs: 200 }));
    expect(profile.floorMs).toBe(450);
    expect(profile.startMs).toBeGreaterThanOrEqual(profile.floorMs);
    expect(profile.ceilingMs).toBeGreaterThan(profile.floorMs);
  });
  it('прямой UDP не доплачивает за чужую проблему', () => {
    expect(profileFor('conversation', link({ path: 'direct-udp' })).floorMs).toBe(
      profileFor('conversation').floorMs,
    );
  });
  it('ни один профиль не выходит за то, что браузер способен удержать', () => {
    const profile = profileFor('media', link({ ordered: true, rttMs: 5000 }));
    expect(profile.ceilingMs).toBeLessThanOrEqual(MAX_TARGET_MS);
    expect(profile.floorMs).toBeLessThanOrEqual(profile.ceilingMs);
  });
});

describe('чем была заглушка', () => {
  it('частые короткие события — опоздания, то есть джиттер', () => {
    expect(classifyTrouble({ concealedSamples: 5 * 0.04 * RATE, events: 5, lost: 0 })).toBe('jitter');
  });
  it('события, которые объясняются потерями, — потери, а не джиттер', () => {
    expect(classifyTrouble({ concealedSamples: 5 * 0.04 * RATE, events: 5, lost: 5 })).toBe('loss');
    expect(classifyTrouble({ concealedSamples: 5 * 0.04 * RATE, events: 5, lost: 3 })).toBe('loss');
  });
  it('одно длинное событие — обрыв', () => {
    expect(classifyTrouble({ concealedSamples: 2 * RATE, events: 1, lost: 0 })).toBe('outage');
    expect(classifyTrouble({ concealedSamples: 30 * RATE, events: 1, lost: 0 })).toBe('outage');
  });
  it('заглушка без новых событий — продолжение обрыва', () => {
    expect(classifyTrouble({ concealedSamples: 2 * RATE, events: 0, lost: 0 })).toBe('outage');
  });
  it('без заглушки беды нет', () => {
    expect(classifyTrouble({ concealedSamples: 0, events: 0, lost: 7 })).toBe('none');
  });
});

describe('решение по дорожке', () => {
  it('потери 1 % десять минут не двигают цель музыки: запас против потерь бессилен', () => {
    // Сценарий со скрина владельца: VPN, потери, заглушка на каждом опросе. Раньше это
    // уводило цель к 2500 мс за 24 секунды и навсегда.
    const profile = profileFor('media');
    const buffer = new PlayoutBuffer('media', profile, 0);
    let seconds = 0;
    let lost = 0;
    let events = 0;
    let concealed = 0;
    buffer.observe(audio(0), 0);
    let top = 0;
    for (let tick = 1; tick <= 300; tick++) {
      seconds += 2;
      lost += 1; // 1 пакет из 100 за 2 с
      events += 1;
      concealed += 0.02 * RATE;
      const d = buffer.observe(
        audio(seconds, { packetsLost: lost, concealmentEvents: events, concealedSamples: concealed }),
        seconds * 1000,
      );
      expect(d.trouble).toBe('loss');
      top = Math.max(top, d.targetMs);
    }
    expect(top).toBe(profile.startMs);
    // Спокойный спуск при этом идёт: потери — не повод держать запас.
    expect(buffer.target).toBe(profile.floorMs);
  });

  it('замирание на 30 с — обрыв: цель не растёт, а после него музыка играет с тем же запасом', () => {
    const profile = profileFor('media');
    const buffer = new PlayoutBuffer('media', profile, 0);
    buffer.observe(audio(0), 0);
    let seconds = 0;
    for (let tick = 1; tick <= 15; tick++) {
      seconds += 2;
      // Весь интервал — одна заглушка: пакетов нет вовсе.
      const d = buffer.observe(
        audio(seconds, { concealedSamples: seconds * RATE, concealmentEvents: 1 }),
        seconds * 1000,
      );
      expect(d.trouble).toBe('outage');
    }
    expect(buffer.target).toBeLessThanOrEqual(profile.startMs);
  });

  it('опоздавшие пакеты поднимают запас — на riseMs за опрос, до потолка', () => {
    const profile = profileFor('media');
    const buffer = new PlayoutBuffer('media', profile, 0);
    buffer.observe(audio(0), 0);
    const first = buffer.observe(audio(2, jittery(5)), 2000);
    expect(first.trouble).toBe('jitter');
    expect(first.targetMs).toBe(profile.startMs + profile.riseMs);
    let seconds = 2;
    let events = 5;
    for (let tick = 0; tick < 20; tick++) {
      seconds += 2;
      events += 5;
      buffer.observe(audio(seconds, jittery(events)), seconds * 1000);
    }
    expect(buffer.target).toBe(profile.ceilingMs);
  });

  it('после подъёма спуск идёт шагом stepMs каждые calmMs, а не за семнадцать минут', () => {
    const profile = profileFor('media');
    const buffer = new PlayoutBuffer('media', profile, 0);
    buffer.observe(audio(0), 0);
    buffer.observe(audio(2, jittery(5)), 2000);
    buffer.observe(audio(4, jittery(10)), 4000);
    const raised = buffer.target;
    expect(raised).toBe(profile.startMs + 2 * profile.riseMs);
    let now = 4000;
    let seconds = 4;
    let steps = 0;
    while (buffer.target > profile.floorMs && steps < 100) {
      now += 2000;
      seconds += 2;
      const before = buffer.target;
      buffer.observe(audio(seconds, jittery(10)), now);
      if (buffer.target < before) {
        expect(before - buffer.target).toBeLessThanOrEqual(profile.stepMs);
        steps++;
      }
    }
    // (600+200-500)/100 = 3 шага по 10 с спокойствия — меньше минуты.
    expect(steps).toBe(3);
    expect(now - 4000).toBeLessThanOrEqual(3 * profile.calmMs + 6000);
  });

  it('пачка после задержки не становится целью: NetEq ускорится сам, а за потолком — переподписка', () => {
    const profile = profileFor('media');
    const buffer = new PlayoutBuffer('media', profile, 0);
    buffer.observe(audio(0), 0);
    const burst = buffer.observe(
      audio(2, { removedSamplesForAcceleration: 0.02 * 2 * RATE, jitterBufferDelay: 1.6 * 2 * RATE }),
      2000,
    );
    expect(burst.measuredMs).toBeCloseTo(1600, 0);
    expect(burst.targetMs).toBe(profile.startMs);
    expect(burst.resync).toBe(false);
    const flooded = buffer.observe(audio(4, { jitterBufferDelay: 1.6 * 2 * RATE + 3 * 2 * RATE }), 4000);
    expect(flooded.measuredMs).toBeCloseTo(3000, 0);
    expect(flooded.resync).toBe(true);
    expect(flooded.targetMs).toBe(profile.startMs);
  });

  /**
   * R107: переподписка — это обрыв на полсекунды-секунду (новый приёмник, новый NetEq с нуля).
   * Музыке он дешевле, чем жить с отставанием в секунды, а речи — нет: раздутый буфер разговора
   * NetEq догоняет сам ускорением за пару секунд, а переподписку человек слышит как «обрезало».
   */
  it('разговор не переподписывается, как бы ни раздуло буфер: обрыв хуже догоняющего ускорения', () => {
    const profile = profileFor('conversation');
    const buffer = new PlayoutBuffer('conversation', profile, 0);
    buffer.observe(audio(0), 0);
    const flooded = buffer.observe(audio(2, { jitterBufferDelay: 3 * 2 * RATE }), 2000);
    expect(flooded.measuredMs).toBeCloseTo(3000, 0);
    expect(flooded.resync).toBe(false);
  });

  it('разговор на джиттере поднимается на 60 мс и не выше 400', () => {
    const profile = profileFor('conversation');
    const buffer = new PlayoutBuffer('conversation', profile, 0);
    buffer.observe(audio(0), 0);
    expect(buffer.observe(audio(2, jittery(4)), 2000).targetMs).toBe(profile.startMs + 60);
    let seconds = 2;
    let events = 4;
    for (let tick = 0; tick < 20; tick++) {
      seconds += 2;
      events += 4;
      buffer.observe(audio(seconds, jittery(events)), seconds * 1000);
    }
    expect(buffer.target).toBe(400);
  });

  it('замирание картинки для видео — то же, что джиттер для звука', () => {
    const profile = profileFor('video');
    const buffer = new PlayoutBuffer('video', profile, 0);
    buffer.observe({ timestamp: 0, freezeCount: 0 }, 0);
    const decision = buffer.observe({ timestamp: 2000, freezeCount: 2 }, 2000);
    expect(decision.freezes).toBe(2);
    expect(decision.targetMs).toBe(profile.startMs + profile.riseMs);
    const fresh = new PlayoutBuffer('video', profile, 0);
    expect(fresh.observe({ timestamp: 0, freezeCount: 17 }, 0).freezes).toBe(0);
  });

  it('тишину DTX за поломку не считает', () => {
    const buffer = new PlayoutBuffer('conversation', profileFor('conversation'), 0);
    buffer.observe(audio(0), 0);
    const decision = buffer.observe(
      audio(2, {
        concealedSamples: 0.3 * 2 * RATE,
        silentConcealedSamples: 0.3 * 2 * RATE,
        concealmentEvents: 20,
      }),
      2000,
    );
    expect(decision.concealRatio).toBe(0);
    expect(decision.trouble).toBe('none');
    expect(decision.targetMs).toBe(profileFor('conversation').startMs);
  });

  it('на спокойной линии снижает запас маленькими шагами и не ниже пола', () => {
    const profile = profileFor('conversation');
    const buffer = new PlayoutBuffer('conversation', profile, 0);
    buffer.observe(audio(0), 0);
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
    const buffer = new PlayoutBuffer('conversation', profileFor('conversation'), 0);
    buffer.observe(audio(0), 0);
    const spike = buffer.observe(audio(2, { jitter: 0.09 }), 2000).targetMs;
    expect(spike).toBe(360);
    const after = buffer.observe(audio(4, { jitter: 0 }), 4000).targetMs;
    expect(after).toBe(spike);
  });

  it('перезапуск счётчиков дорожки не сбрасывает уже набранный запас', () => {
    const buffer = new PlayoutBuffer('media', profileFor('media'), 0);
    buffer.observe(audio(0), 0);
    buffer.observe(audio(2, jittery(5)), 2000);
    const raised = buffer.target;
    expect(raised).toBeGreaterThan(profileFor('media').startMs);
    expect(buffer.observe(audio(0.1), 4000).targetMs).toBe(raised);
  });

  it('смена пути подрезает уже выбранную цель под новые границы', () => {
    const buffer = new PlayoutBuffer('media', profileFor('media'), 0);
    buffer.observe(audio(0), 0);
    const ordered = profileFor('media', link({ ordered: true, rttMs: 300 }));
    buffer.retune(ordered);
    expect(buffer.target).toBeGreaterThanOrEqual(ordered.floorMs);
    expect(buffer.target).toBeLessThanOrEqual(ordered.ceilingMs);
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
