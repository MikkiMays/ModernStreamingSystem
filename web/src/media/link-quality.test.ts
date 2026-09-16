import { describe, expect, it } from 'vitest';
import { gradeLink, isOrdered, linkChanged, LinkMonitor, readPath, unknownLink } from './link-quality';

type Stat = Record<string, unknown> & { id: string; type: string };
const report = (stats: Stat[]) => new Map(stats.map((s) => [s.id, s])) as unknown as RTCStatsReport;

const pair = (patch: Record<string, unknown> = {}) => ({
  id: 'pair',
  type: 'candidate-pair',
  state: 'succeeded',
  nominated: true,
  localCandidateId: 'local',
  remoteCandidateId: 'remote',
  currentRoundTripTime: 0.12,
  ...patch,
});
const candidate = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  type: id === 'local' ? 'local-candidate' : 'remote-candidate',
  candidateType: 'srflx',
  protocol: 'udp',
  ...patch,
});

describe('какой путь выбрал ICE', () => {
  it('прямой UDP', () => {
    expect(readPath(report([pair(), candidate('local'), candidate('remote')]))).toBe('direct-udp');
  });
  it('ретранслятор поверх TLS различается по relayProtocol, а не по protocol', () => {
    // У ретранслирующего кандидата `protocol` описывает участок TURN → собеседник. Наш
    // участок — тот, что назван relayProtocol, и именно он решает, будет ли головная блокировка.
    const path = readPath(
      report([
        pair(),
        candidate('local', { candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls' }),
        candidate('remote'),
      ]),
    );
    expect(path).toBe('relay-tcp');
    expect(isOrdered(path)).toBe(true);
  });
  it('ретранслятор поверх UDP остаётся неупорядоченным', () => {
    const path = readPath(
      report([
        pair(),
        candidate('local', { candidateType: 'relay', relayProtocol: 'udp' }),
        candidate('remote'),
      ]),
    );
    expect(path).toBe('relay-udp');
    expect(isOrdered(path)).toBe(false);
  });
  it('пару, названную транспортом, предпочитает всякой другой', () => {
    const chosen = readPath(
      report([
        { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
        pair(),
        { ...pair({ id: 'stale', localCandidateId: 'old' }), nominated: true },
        candidate('local', { protocol: 'udp' }),
        candidate('remote'),
        { ...candidate('old', { protocol: 'tcp' }), id: 'old' },
      ]),
    );
    expect(chosen).toBe('direct-udp');
  });
  it('когда согласованных пар несколько и транспорт молчит — не гадает', () => {
    expect(readPath(report([pair(), pair({ id: 'second' }), candidate('local'), candidate('remote')]))).toBe(
      'unknown',
    );
  });
  it('пустой отчёт — это отсутствие данных, а не хороший канал', () => {
    expect(readPath(report([]))).toBe('unknown');
    expect(gradeLink(unknownLink)).toBe('unknown');
  });
});

describe('оценка канала', () => {
  it('упорядоченный путь никогда не считается хорошим', () => {
    expect(gradeLink({ ...unknownLink, ordered: true, rttMs: 40, jitterMs: 2, lossPercent: 0 })).toBe('fair');
  });
  it('потери и джиттер опускают оценку', () => {
    expect(gradeLink({ ...unknownLink, rttMs: 50, jitterMs: 5, lossPercent: 0 })).toBe('good');
    expect(gradeLink({ ...unknownLink, rttMs: 50, jitterMs: 30, lossPercent: 0 })).toBe('fair');
    expect(gradeLink({ ...unknownLink, rttMs: 50, jitterMs: 5, lossPercent: 4 })).toBe('poor');
  });
});

describe('накопление по отчётам', () => {
  const inbound = (patch: Record<string, unknown>) => ({
    id: 'in',
    type: 'inbound-rtp',
    kind: 'audio',
    packetsReceived: 0,
    packetsLost: 0,
    jitter: 0,
    ...patch,
  });
  it('джиттер запоминается пиком и затухает, а не усредняется', () => {
    const monitor = new LinkMonitor(0.5);
    monitor.observe(report([pair(), candidate('local'), candidate('remote'), inbound({ jitter: 0.08 })]));
    expect(monitor.current.jitterMs).toBeCloseTo(80, 5);
    monitor.observe(report([pair(), candidate('local'), candidate('remote'), inbound({ jitter: 0 })]));
    expect(monitor.current.jitterMs).toBeCloseTo(40, 5);
  });
  it('потери считаются за интервал, а перезапуск счётчиков не выдаёт всплеска', () => {
    const monitor = new LinkMonitor();
    const stats = (received: number, lost: number) =>
      report([
        pair(),
        candidate('local'),
        candidate('remote'),
        inbound({ packetsReceived: received, packetsLost: lost }),
      ]);
    monitor.observe(stats(1000, 0));
    expect(monitor.observe(stats(1100, 10)).lossPercent).toBeCloseTo((10 / 110) * 100, 5);
    // Дорожка переподписана: счётчики пошли с нуля. Это не стопроцентная потеря.
    expect(monitor.observe(stats(5, 0)).lossPercent).toBeNull();
  });
  it('мелкое дрожание чисел не считается изменением, а смена пути считается', () => {
    const base = { ...unknownLink, path: 'direct-udp' as const, rttMs: 100, jitterMs: 10 };
    expect(linkChanged(base, { ...base, rttMs: 101 })).toBe(false);
    expect(linkChanged(base, { ...base, rttMs: 180 })).toBe(true);
    expect(linkChanged(base, { ...base, path: 'relay-tcp' })).toBe(true);
    expect(linkChanged(base, { ...base, grade: 'poor' })).toBe(true);
    expect(linkChanged(base, { ...base, rttMs: null })).toBe(true);
  });
  it('сброс возвращает состояние к «данных нет»', () => {
    const monitor = new LinkMonitor();
    monitor.observe(report([pair(), candidate('local'), candidate('remote'), inbound({ jitter: 0.05 })]));
    monitor.reset();
    expect(monitor.current).toEqual(unknownLink);
  });
});
