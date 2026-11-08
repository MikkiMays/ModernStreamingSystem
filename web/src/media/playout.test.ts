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
  it('музыка живёт в одной секунде для всех: потолок 1000, пол 600 — и начинает с пола (R182)', () => {
    const media = profileFor('media');
    expect(media.ceilingMs).toBe(1000);
    expect(media.floorMs).toBe(600);
    expect(media.startMs).toBe(media.floorMs);
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

  it('после подъёма разговор спускается шагом stepMs каждые calmMs, а не за семнадцать минут', () => {
    const profile = profileFor('conversation');
    const buffer = new PlayoutBuffer('conversation', profile, 0);
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
    // (120 + 120 − 60) / 20 = 9 шагов по 8 с спокойствия — около минуты.
    expect(steps).toBe((raised - profile.floorMs) / profile.stepMs);
    expect(now - 4000).toBeLessThanOrEqual(steps * profile.calmMs + 6000);
  });

  /**
   * R182. Живой замер 02.11.2026: через десять спокойных секунд цель музыки шла 600 → 500, и NetEq
   * 1,2 с догонял её ускорением звука на 8 % — посреди трека это слышно. Музыка вниз не шагает.
   */
  it('музыка вниз не шагает: поднятый запас держится, сколько бы ни было спокойно', () => {
    const profile = profileFor('media');
    const buffer = new PlayoutBuffer('media', profile, 0);
    buffer.observe(audio(0), 0);
    buffer.observe(audio(2, jittery(5)), 2000);
    const raised = buffer.target;
    expect(raised).toBe(profile.startMs + profile.riseMs);
    for (let seconds = 4; seconds <= 600; seconds += 2)
      expect(buffer.observe(audio(seconds, jittery(5)), seconds * 1000).targetMs).toBe(raised);
  });

  it('музыка с начала спокойствия не уходит со стартовой цели', () => {
    const profile = profileFor('media');
    const buffer = new PlayoutBuffer('media', profile, 0);
    for (let seconds = 0; seconds <= 120; seconds += 2)
      expect(buffer.observe(audio(seconds), seconds * 1000).targetMs).toBe(profile.startMs);
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
    let delay = 1.6 * 2 * RATE;
    const flooded = (seconds: number) => {
      delay += 3 * 2 * RATE;
      return buffer.observe(audio(seconds, { jitterBufferDelay: delay }), seconds * 1000);
    };
    expect(flooded(4).measuredMs).toBeCloseTo(3000, 0);
    expect(flooded(6).resync).toBe(false);
    const stuck = flooded(8);
    expect(stuck.resync).toBe(true);
    expect(stuck.targetMs).toBe(profile.startMs);
  });

  /**
   * R118. Живой замер 25.10: при 3 % потерь правило «раздуто — переподписать» дважды за минуту
   * роняло музыку, а раздувал буфер не канал — хост слушателя замирал, и вывод звука отдавал
   * 10–35 тысяч отсчётов в секунду вместо 48. Новая подписка раздувалась так же. Поэтому музыка
   * просит переподписку только за стойкое раздутие (`MEDIA_RESYNC_POLLS`), и никогда — пока
   * вывод звука не успевает за часами (`STARVED_OUTPUT_RATIO`).
   */
  it('музыка: пачку, которую NetEq разобрал за два опроса, не переподписывает', () => {
    const profile = profileFor('media');
    const buffer = new PlayoutBuffer('media', profile, 0);
    buffer.observe(audio(0), 0);
    // Замирание на 2,5 с: буфер 3 с, в следующую секунду NetEq быстро ускоряется, дальше ≈ 100 мс/с.
    let delay = 0;
    const seen = (seconds: number, bufferedMs: number, accelerated = 0) => {
      delay += (bufferedMs / 1000) * 2 * RATE;
      return buffer.observe(
        audio(seconds, { jitterBufferDelay: delay, removedSamplesForAcceleration: accelerated }),
        seconds * 1000,
      );
    };
    expect(seen(2, 3000).resync).toBe(false);
    expect(seen(4, 2300, 0.5 * RATE).resync).toBe(false);
    expect(seen(6, 1900, 0.7 * RATE).resync).toBe(false);
    expect(seen(8, 1700, 0.9 * RATE).resync).toBe(false);
    expect(seen(10, 1500, 1.1 * RATE).resync).toBe(false);
  });

  it('музыка: буфер раздут три опроса подряд и не тает — переподписка, и снова, пока раздут', () => {
    const profile = profileFor('media');
    const buffer = new PlayoutBuffer('media', profile, 0);
    buffer.observe(audio(0), 0);
    let delay = 0;
    const tick = (seconds: number) => {
      delay += 2.5 * 2 * RATE;
      return buffer.observe(audio(seconds, { jitterBufferDelay: delay }), seconds * 1000);
    };
    expect(tick(2).resync).toBe(false);
    expect(tick(4).resync).toBe(false);
    expect(tick(6).resync).toBe(true);
    expect(tick(8).resync).toBe(true);
    // Рассосалось — счёт начинается заново.
    delay += 0.6 * 2 * RATE;
    expect(buffer.observe(audio(10, { jitterBufferDelay: delay }), 10000).resync).toBe(false);
    delay += 2.5 * 2 * RATE;
    expect(buffer.observe(audio(12, { jitterBufferDelay: delay }), 12000).resync).toBe(false);
  });

  it('музыка: пока NetEq ускоряется, раздутый буфер — его работа, а не повод; перестал — счёт пошёл', () => {
    const profile = profileFor('media');
    const buffer = new PlayoutBuffer('media', profile, 0);
    buffer.observe(audio(0), 0);
    let delay = 0;
    let removed = 0;
    const tick = (seconds: number, accelerationPerSecond: number) => {
      delay += 2.5 * 2 * RATE;
      removed += accelerationPerSecond * 2;
      return buffer.observe(
        audio(seconds, { jitterBufferDelay: delay, removedSamplesForAcceleration: removed }),
        seconds * 1000,
      );
    };
    // Обычный темп NetEq ≈ 5 000 отсчётов в секунду (10 %), пачка — до 25 000.
    for (const seconds of [2, 4, 6, 8, 10]) expect(tick(seconds, 5000).resync).toBe(false);
    expect(tick(12, 25000).resync).toBe(false);
    // Ускорение прекратилось, буфер всё ещё раздут: три опроса — и переподписка.
    expect(tick(14, 0).resync).toBe(false);
    expect(tick(16, 500).resync).toBe(false);
    expect(tick(18, 0).resync).toBe(true);
  });

  it('вывод звука не успевает за часами — буфер раздут не сетью, переподписки нет ни музыке, ни разговору', () => {
    for (const kind of ['media', 'conversation'] as const) {
      const profile = profileFor(kind);
      const buffer = new PlayoutBuffer(kind, profile, 0);
      buffer.observe(audio(0), 0);
      // Динамик получает половину секунды звука за секунду (замер 25.10: 8–35 тысяч из 48).
      let emitted = 0;
      let delay = 0;
      const starvedPoll = (seconds: number) => {
        emitted += 0.5 * 2 * RATE;
        delay += 2.5 * 0.5 * 2 * RATE;
        return buffer.observe(
          audio(seconds, {
            totalSamplesReceived: emitted,
            jitterBufferEmittedCount: emitted,
            jitterBufferDelay: delay,
          }),
          seconds * 1000,
        );
      };
      for (const seconds of [2, 4, 6, 8, 10]) {
        const decision = starvedPoll(seconds);
        expect(decision.measuredMs, kind).toBeCloseTo(2500, 0);
        expect(decision.starved, kind).toBe(true);
        expect(decision.resync, kind).toBe(false);
      }
    }
  });

  it('замедление NetEq ради набора запаса (≈ 13 %) за голод вывода не считается', () => {
    const profile = profileFor('media');
    const buffer = new PlayoutBuffer('media', profile, 0);
    buffer.observe(audio(0), 0);
    const slowed = buffer.observe(
      audio(2, {
        totalSamplesReceived: Math.round(0.87 * 2 * RATE),
        jitterBufferEmittedCount: Math.round(0.87 * 2 * RATE),
        insertedSamplesForDeceleration: Math.round(0.13 * 2 * RATE),
      }),
      2000,
    );
    expect(slowed.starved).toBe(false);
  });

  it('без счётчика вывода (не Chrome) голод не выдумывается, а правило раздутия работает как прежде', () => {
    const profile = profileFor('media');
    const buffer = new PlayoutBuffer('media', profile, 0);
    const poll = (seconds: number, delay: number) =>
      buffer.observe(
        { ...audio(seconds, { jitterBufferDelay: delay }), totalSamplesReceived: undefined },
        seconds * 1000,
      );
    poll(0, 0);
    expect(poll(2, 2.5 * 2 * RATE).starved).toBe(false);
    expect(poll(4, 2.5 * 4 * RATE).resync).toBe(false);
    expect(poll(6, 2.5 * 6 * RATE).resync).toBe(true);
  });

  /**
   * R107: переподписка — это провал звука на полсекунды-секунду (новый приёмник, NetEq с нуля).
   * Раньше разговор переподписывался на первом же опросе, где буфер раздуло за 1,4 с, — посреди
   * фразы. Но и не переподписывать нельзя: после «пробки» в сети (bufferbloat) NetEq держит свою
   * цель за секунду ещё десятки секунд (замер `bloat-after`), это рация. Поэтому разговор просит
   * переподписку, только если буфер раздут два опроса подряд, а саму её сессия делает в паузе
   * говорящего (`speech-pause.ts`).
   */
  it('разговор: пачка на один опрос — не повод, NetEq догонит сам', () => {
    const profile = profileFor('conversation');
    const buffer = new PlayoutBuffer('conversation', profile, 0);
    buffer.observe(audio(0), 0);
    const flooded = buffer.observe(audio(2, { jitterBufferDelay: 3 * 2 * RATE }), 2000);
    expect(flooded.measuredMs).toBeCloseTo(3000, 0);
    expect(flooded.resync).toBe(false);
    const drained = buffer.observe(audio(4, { jitterBufferDelay: 3 * 2 * RATE + 0.3 * 2 * RATE }), 4000);
    expect(drained.resync).toBe(false);
  });

  it('разговор: раздут два опроса подряд — просит переподписку, и снова, пока раздут', () => {
    const profile = profileFor('conversation');
    const buffer = new PlayoutBuffer('conversation', profile, 0);
    buffer.observe(audio(0), 0);
    let delay = 0;
    const tick = (seconds: number) => {
      delay += 1.6 * 2 * RATE;
      return buffer.observe(audio(seconds, { jitterBufferDelay: delay }), seconds * 1000);
    };
    expect(tick(2).resync).toBe(false);
    expect(tick(4).resync).toBe(true);
    // Паузы не случилось — просьба повторяется на следующих опросах, пока буфер раздут.
    expect(tick(6).resync).toBe(true);
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

/*
  R191, «выключается быстро, а включается долго»: живой замер 07.11.2026 — у слушателя цель запаса росла
  с 120 до 400 мс за три выключения микрофона говорящего, и голос после включения приходил на 300–450 мс
  позже. SFU перестаёт слать заглушённую дорожку, NetEq полсекунды гасит звук, и Chrome считает это десятками
  «событий заглушки» по 1–9 мс. Для `classifyTrouble` это выглядит как опоздавшие пакеты.
*/
describe('говорящий выключил микрофон (R191)', () => {
  /** Настоящие разности счётчиков соседних опросов из замера. */
  const fadeOut = (
    at: number,
    previous: PlayoutSample,
    events: number,
    concealed: number,
    silent: number,
  ) => ({
    ...audio(at),
    concealedSamples: (previous.concealedSamples ?? 0) + concealed,
    silentConcealedSamples: (previous.silentConcealedSamples ?? 0) + silent,
    concealmentEvents: (previous.concealmentEvents ?? 0) + events,
  });

  it('то, что записано в замере, без признака выглядит как джиттер — поэтому признак и нужен', () => {
    const buffer = new PlayoutBuffer('conversation', profileFor('conversation'), 0);
    const start = audio(0);
    buffer.observe(start, 0);
    const decision = buffer.observe(fadeOut(2, start, 51, 44541, 40320), 2000);
    expect(decision.trouble).toBe('jitter');
  });

  it('хвост заглушки после выключения — не джиттер: цель не растёт, сколько раз ни выключай', () => {
    const profile = profileFor('conversation');
    const buffer = new PlayoutBuffer('conversation', profile, 0);
    let last = audio(0);
    buffer.observe(last, 0);
    for (let press = 0; press < 10; press++) {
      const at = 2 + press * 6;
      // Опрос, попавший на выключение: говорящий уже заглушён.
      const tail = fadeOut(at, last, 42, 55947, 54720);
      const off = buffer.observe(tail, at * 1000, true);
      expect(off.trouble).toBe('none');
      expect(off.targetMs).toBeLessThanOrEqual(profile.startMs);
      // Весь опрос в тишине.
      const quiet = fadeOut(at + 2, tail, 0, 96000, 96000);
      expect(buffer.observe(quiet, (at + 2) * 1000, true).targetMs).toBeLessThanOrEqual(profile.startMs);
      // Опрос, попавший на включение: сам он уже не заглушён, но половина интервала — ещё та тишина.
      buffer.muteChanged();
      const back = fadeOut(at + 4, quiet, 9, 3700, 0);
      const on = buffer.observe(back, (at + 4) * 1000, false);
      expect(on.trouble).toBe('none');
      expect(on.targetMs).toBeLessThanOrEqual(profile.startMs);
      last = back;
    }
  });

  it('выключили и включили между двумя опросами — опрос всё равно не считается', () => {
    const profile = profileFor('conversation');
    const buffer = new PlayoutBuffer('conversation', profile, 0);
    const start = audio(0);
    buffer.observe(start, 0);
    buffer.muteChanged();
    buffer.muteChanged();
    const decision = buffer.observe(fadeOut(2, start, 51, 3700, 2000), 2000, false);
    expect(decision).toMatchObject({ trouble: 'none', targetMs: profile.startMs });
  });

  it('скачок джиттера на первом пакете после тишины не поднимает запас', () => {
    const profile = profileFor('conversation');
    const buffer = new PlayoutBuffer('conversation', profile, 0);
    buffer.observe(audio(0), 0);
    buffer.muteChanged();
    // RFC 3550: разрыв в потоке даёт разовый скачок сглаженного джиттера.
    const decision = buffer.observe(audio(2, { jitter: 0.2 }), 2000, false);
    expect(decision.targetMs).toBe(profile.startMs);
  });

  it('настоящий джиттер у незаглушённого говорящего поднимает запас, как и раньше', () => {
    const profile = profileFor('conversation');
    const buffer = new PlayoutBuffer('conversation', profile, 0);
    buffer.observe(audio(0), 0);
    buffer.muteChanged();
    buffer.observe(audio(2), 2000, false);
    const decision = buffer.observe(audio(4, jittery(5)), 4000, false);
    expect(decision.trouble).toBe('jitter');
    expect(decision.targetMs).toBe(profile.startMs + profile.riseMs);
  });
});
