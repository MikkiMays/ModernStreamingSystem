import { describe, expect, it } from 'vitest';
import type { PlayoutSample } from './playout';
import { INTERVAL_MS, RxQuality, type RxObservation } from './rx-quality';

const sample = (patch: Partial<PlayoutSample>): PlayoutSample => ({ timestamp: 0, ...patch });

const music = (sample: PlayoutSample, targetMs = 800): RxObservation => ({
  id: 'TR_music',
  kind: 'media',
  sample,
  targetMs,
});
const voice = (sample: PlayoutSample, targetMs = 120): RxObservation => ({
  id: 'TR_voice',
  kind: 'conversation',
  sample,
  targetMs,
});

describe('сводка приёма раз в 10 с (rooms/{id}/quality)', () => {
  it('до первого окна сводки нет, затем — разности по классам без номеров дорожек', () => {
    const rx = new RxQuality();
    rx.observe(
      [
        music(
          sample({
            concealedSamples: 100,
            silentConcealedSamples: 20,
            totalSamplesReceived: 1000,
            concealmentEvents: 1,
            packetsLost: 0,
            jitterBufferDelay: 0.8,
            jitterBufferEmittedCount: 1000,
          }),
        ),
        voice(
          sample({ concealedSamples: 0, totalSamplesReceived: 1000, concealmentEvents: 0, packetsLost: 0 }),
        ),
      ],
      0,
    );
    expect(rx.flush(2_000)).toBeNull();
    rx.observe(
      [
        // 480 заглушки, из них 80 — тишина DTX: слышно 400; 96 000 отсчётов — две секунды 48 кГц.
        music(
          sample({
            concealedSamples: 580,
            silentConcealedSamples: 100,
            totalSamplesReceived: 97_000,
            concealmentEvents: 4,
            packetsLost: 2,
            jitterBufferDelay: 0.8 + 96_000 * 0.65,
            jitterBufferEmittedCount: 97_000,
          }),
          800,
        ),
        voice(
          sample({ concealedSamples: 0, totalSamplesReceived: 97_000, concealmentEvents: 0, packetsLost: 0 }),
          120,
        ),
      ],
      2_000,
    );
    expect(rx.flush(9_999)).toBeNull();
    const summary = rx.flush(INTERVAL_MS);
    expect(summary).toEqual({
      tracks: [
        { kind: 'media', concealed: 400, total: 96_000, events: 3, lost: 2, targetMs: 800, delayMs: 650 },
        {
          kind: 'conversation',
          concealed: 0,
          total: 96_000,
          events: 0,
          lost: 0,
          targetMs: 120,
          delayMs: null,
        },
      ],
    });
    expect(JSON.stringify(summary).length).toBeLessThan(2048);
    // Следующее окно начинается с нуля; счётчики продолжают расти с прежней точки.
    expect(rx.flush(INTERVAL_MS + 1)).toBeNull();
    rx.observe(
      [
        music(
          sample({
            concealedSamples: 580,
            silentConcealedSamples: 100,
            totalSamplesReceived: 193_000,
            concealmentEvents: 4,
            packetsLost: 2,
          }),
          850,
        ),
      ],
      12_000,
    );
    expect(rx.flush(2 * INTERVAL_MS)).toEqual({
      tracks: [
        { kind: 'media', concealed: 0, total: 96_000, events: 0, lost: 0, targetMs: 850, delayMs: null },
      ],
    });
  });

  it('сброс соединения и исчезнувшая дорожка не дают отрицательных разностей', () => {
    const rx = new RxQuality();
    rx.observe([music(sample({ totalSamplesReceived: 50_000, concealedSamples: 300 }))], 0);
    rx.reset();
    // Счётчики новой дорожки начались с нуля: первый отчёт после сброса — точка отсчёта, не разность.
    rx.observe([music(sample({ totalSamplesReceived: 1_000, concealedSamples: 0 }))], 1_000);
    rx.observe([music(sample({ totalSamplesReceived: 2_000, concealedSamples: 10 }))], 3_000);
    expect(rx.flush(11_000)).toEqual({
      tracks: [
        { kind: 'media', concealed: 10, total: 1_000, events: 0, lost: 0, targetMs: 800, delayMs: null },
      ],
    });
    // Дорожка ушла и вернулась под тем же номером с меньшими счётчиками — разность не отрицательная.
    rx.observe([], 12_000);
    rx.observe([music(sample({ totalSamplesReceived: 100, concealedSamples: 0 }))], 13_000);
    rx.observe([music(sample({ totalSamplesReceived: 50, concealedSamples: 0 }))], 15_000);
    expect(rx.flush(21_000)).toEqual({
      tracks: [{ kind: 'media', concealed: 0, total: 0, events: 0, lost: 0, targetMs: 800, delayMs: null }],
    });
  });
  it('отдача (R152): секунды по источнику, кодеку и железу, ограничения и смены кодека — в той же сводке', () => {
    const rx = new RxQuality();
    rx.observe([], 0);
    const camera = { source: 'camera', codec: 'av1', hw: 'hw', cpuSeconds: 0, otherSeconds: 0 } as const;
    rx.observeTx({ ...camera, seconds: 3, bandwidthSeconds: 0.5 });
    rx.observeTx({ ...camera, seconds: 3.1, bandwidthSeconds: 1 });
    rx.observeTx({
      source: 'screen',
      codec: 'h264',
      hw: 'sw',
      seconds: 3,
      cpuSeconds: 4,
      bandwidthSeconds: -1,
      otherSeconds: 0,
    });
    rx.observeTx({ ...camera, seconds: 0, bandwidthSeconds: 0 });
    rx.noteSwitches([{ source: 'screen', from: 'h265', to: 'h264', reason: 'cpu' }]);
    expect(rx.flush(5_000)).toBeNull();
    expect(rx.flush(INTERVAL_MS)).toEqual({
      tracks: [],
      tx: [
        { ...camera, seconds: 6.1, bandwidthSeconds: 1.5 },
        // Ограничение не дольше самой отдачи; отрицательное — ноль.
        {
          source: 'screen',
          codec: 'h264',
          hw: 'sw',
          seconds: 3,
          cpuSeconds: 3,
          bandwidthSeconds: 0,
          otherSeconds: 0,
        },
      ],
      switches: [{ source: 'screen', from: 'h265', to: 'h264', reason: 'cpu' }],
    });
    // Окно началось заново; переподключение отдачу не теряет.
    rx.observeTx({ ...camera, seconds: 2, bandwidthSeconds: 0 });
    rx.reset();
    rx.observe([], 2 * INTERVAL_MS);
    expect(rx.flush(3 * INTERVAL_MS)).toEqual({
      tracks: [],
      tx: [{ ...camera, seconds: 2, bandwidthSeconds: 0 }],
    });
    // Ни приёма, ни отдачи — сводки нет.
    expect(rx.flush(4 * INTERVAL_MS)).toBeNull();
  });
});
