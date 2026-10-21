import { describe, expect, it } from 'vitest';
import { CallQuality, codecOf } from './call-quality';
import { unknownLink, type LinkState } from './link-quality';

const link = (patch: Partial<LinkState>): LinkState => ({ ...unknownLink, ...patch });

/** Отчёт getStats одной дорожки: видео приёма с кодеком и замираниями. */
function report(bytes: number, extra: Record<string, unknown> = {}, mime = 'video/VP8') {
  return new Map<string, Record<string, unknown>>([
    [
      'IT01V',
      { id: 'IT01V', type: 'inbound-rtp', kind: 'video', bytesReceived: bytes, codecId: 'C1', ...extra },
    ],
    ['C1', { id: 'C1', type: 'codec', mimeType: mime }],
  ]) as unknown as RTCStatsReport;
}

describe('итог звонка (client-report)', () => {
  it('короткий заход — не звонок, и итога нет', () => {
    const quality = new CallQuality();
    quality.observe(link({ rttMs: 30 }), [], 0);
    quality.observe(link({ rttMs: 30 }), [], 8_000);
    expect(quality.summary()).toBeNull();
  });

  it('медиана оборота, средние потери и джиттер, битрейт, замирания, путь и кодек', () => {
    const quality = new CallQuality();
    const at = (seconds: number) => seconds * 1000;
    quality.observe(link({ rttMs: 20, lossPercent: 0, jitterMs: 4, path: 'direct-udp' }), [report(0)], 0);
    quality.observe(
      link({ rttMs: 40, lossPercent: 10, jitterMs: 8, path: 'relay-udp' }),
      [report(250_000, { freezeCount: 1, totalFreezesDuration: 0.4 })],
      at(2),
    );
    quality.observe(
      link({ rttMs: 300, lossPercent: 2, jitterMs: 12, path: 'relay-udp' }),
      [report(500_000, { freezeCount: 2, totalFreezesDuration: 1.2 })],
      at(10),
    );
    expect(quality.summary()).toEqual({
      seconds: 10,
      rttMs: 40,
      lossPercent: 4,
      jitterMs: 8,
      // 500 000 байт за 10 с — 400 кбит/с.
      bitrateKbps: 400,
      freezes: 2,
      freezeSeconds: 1,
      lossySeconds: 2,
      path: 'relay-udp',
      codec: 'vp8',
    });
  });

  it('уснувшая вкладка и пересборка связи звонком не считаются', () => {
    const quality = new CallQuality();
    quality.observe(link({}), [report(0)], 0);
    quality.observe(link({}), [report(100_000)], 6_000);
    // Минута без опросов: вкладка спала. Байты за неё в битрейт не идут.
    quality.observe(link({}), [report(9_000_000)], 66_000);
    quality.observe(link({}), [report(9_100_000)], 72_000);
    const summary = quality.summary()!;
    expect(summary.seconds).toBe(12);
    expect(summary.bitrateKbps).toBe(133);
    expect(summary).toMatchObject({ rttMs: null, lossPercent: null, jitterMs: null, path: 'unknown' });
  });

  it('кодек — только из перечисления', () => {
    expect(codecOf('video/H264')).toBe('h264');
    expect(codecOf('video/hevc')).toBe('h265');
    expect(codecOf('video/x-my-camera')).toBe('other');
    expect(codecOf('audio/opus')).toBeNull();
    expect(codecOf(undefined)).toBeNull();
  });
});
