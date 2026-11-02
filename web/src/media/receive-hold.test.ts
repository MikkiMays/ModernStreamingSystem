import { describe, expect, it } from 'vitest';
import { HoldGate, opusStereo } from './receive-hold-core';
import { holdFor } from './receive-hold';

/** Кадр тишины издателя музыки: TOC 0xFC — CELT, fullband, 20 мс, стерео (`services/publisher`). */
const STEREO = Uint8Array.of(0xfc, 0xff, 0xfe);
/** Речь из браузера: TOC 0x78 — CELT/гибрид, моно. */
const MONO = Uint8Array.of(0x78, 0x01, 0x02, 0x03);

/** Пакет RED (RFC 2198): повторы впереди, основной кадр в конце. */
function red(primary: Uint8Array, ...redundant: Uint8Array[]) {
  const header: number[] = [];
  for (const [i, block] of redundant.entries()) {
    const offset = (redundant.length - i) * 960;
    header.push(
      0x80 | 111,
      (offset >> 6) & 0xff,
      ((offset << 2) & 0xfc) | (block.length >> 8),
      block.length & 0xff,
    );
  }
  header.push(111);
  return Uint8Array.from([...header, ...redundant.flatMap((b) => [...b]), ...primary]);
}

describe('стерео ли кадр', () => {
  it('Opus без обёртки — по биту s байта TOC', () => {
    expect(opusStereo(STEREO, false)).toBe(true);
    expect(opusStereo(MONO, false)).toBe(false);
  });
  it('RED — по основному кадру за повторами, а не по первому байту пакета', () => {
    expect(opusStereo(red(STEREO, MONO, MONO), true)).toBe(true);
    expect(opusStereo(red(MONO, STEREO, STEREO), true)).toBe(false);
    expect(opusStereo(red(STEREO), true)).toBe(true);
  });
  it('обрезанный или пустой кадр — не знаем, и тогда не держим', () => {
    expect(opusStereo(new Uint8Array(0), false)).toBeNull();
    expect(opusStereo(Uint8Array.of(0x80 | 111, 0, 0), true)).toBeNull();
    expect(opusStereo(Uint8Array.of(0x80 | 111, 0, 0x00, 0x09, 111), true)).toBeNull();
  });
});

const frames = (ssrc: number, stereo: boolean | null, count: number, from = 0, at = from * 20) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${ssrc}:${from + i}`,
    meta: { ssrc, stereo, rtpTimestamp: (from + i) * 960, arrivalMs: at + i * 20 },
  }));

function feed(gate: HoldGate<string>, list: ReturnType<typeof frames>) {
  const out: string[][] = [];
  for (const f of list) out.push(gate.push(f.id, f.meta));
  return out;
}

describe('задержка начала стерео-дорожки', () => {
  it('речь (моно) идёт насквозь с первого кадра', () => {
    const gate = new HoldGate<string>(640);
    const out = feed(gate, frames(1, false, 5));
    expect(out.map((x) => x.length)).toEqual([1, 1, 1, 1, 1]);
  });

  it('музыка: первые 640 мс копятся и уходят пачкой, дальше — насквозь', () => {
    const gate = new HoldGate<string>(640);
    const out = feed(gate, frames(7, true, 40));
    // 640 мс между первым и последним кадром пачки — это 33 кадра по 20 мс.
    expect(out.slice(0, 32).every((x) => x.length === 0)).toBe(true);
    expect(out[32]).toHaveLength(33);
    expect(out[32]![0]).toBe('7:0');
    expect(out.slice(33).every((x) => x.length === 1)).toBe(true);
  });

  it('новый поток на той же секции (новая подписка) снова держится, а недоотданное уходит сразу', () => {
    const gate = new HoldGate<string>(100);
    feed(gate, frames(1, true, 3));
    expect(gate.pending).toBe(3);
    const out = gate.push('2:0', { ssrc: 2, stereo: true, rtpTimestamp: 5, arrivalMs: 60 });
    expect(out).toEqual(['1:0', '1:1', '1:2']);
    expect(gate.pending).toBe(1);
  });

  it('сессия может отпустить держание раньше: дорожка оказалась речью', () => {
    const gate = new HoldGate<string>(640);
    feed(gate, frames(3, true, 4));
    expect(gate.release()).toEqual(['3:0', '3:1', '3:2', '3:3']);
    expect(gate.push('3:4', { ssrc: 3, stereo: true, rtpTimestamp: 4 * 960, arrivalMs: 80 })).toEqual([
      '3:4',
    ]);
  });

  it('нулевое держание — выключено: стерео тоже насквозь', () => {
    const gate = new HoldGate<string>(0);
    expect(feed(gate, frames(1, true, 3)).map((x) => x.length)).toEqual([1, 1, 1]);
  });

  it('неразобранный кадр не держится', () => {
    const gate = new HoldGate<string>(640);
    expect(feed(gate, frames(1, null, 2)).map((x) => x.length)).toEqual([1, 1]);
  });

  it('переход метки RTP через 2^32 не ломает счёт', () => {
    const gate = new HoldGate<string>(40);
    const start = 0xffffffff - 960;
    expect(gate.push('a', { ssrc: 9, stereo: true, rtpTimestamp: start, arrivalMs: 0 })).toEqual([]);
    expect(gate.push('b', { ssrc: 9, stereo: true, rtpTimestamp: start + 960, arrivalMs: 20 })).toEqual([]);
    expect(
      gate.push('c', { ssrc: 9, stereo: true, rtpTimestamp: (start + 1920) >>> 0, arrivalMs: 40 }),
    ).toEqual(['a', 'b', 'c']);
  });

  it('метки RTP не растут — держание кончается по часам, через два запаса, а не никогда', () => {
    const gate = new HoldGate<string>(100);
    const meta = (i: number) => ({ ssrc: 4, stereo: true, rtpTimestamp: 0, arrivalMs: i * 20 });
    const out = Array.from({ length: 12 }, (_, i) => gate.push(`4:${i}`, meta(i)));
    expect(out.slice(0, 10).every((x) => x.length === 0)).toBe(true);
    expect(out[10]).toHaveLength(11);
  });

  it('тот же источник после тишины дольше запаса — снова держится (переподписка, обрыв)', () => {
    const gate = new HoldGate<string>(640);
    feed(gate, frames(5, true, 40));
    expect(gate.pending).toBe(0);
    // Секунда без кадров: NetEq выбрал всё и набирал бы запас заново растяжением.
    const out = feed(gate, frames(5, true, 40, 100, 40 * 20 + 1000));
    expect(out.slice(0, 32).every((x) => x.length === 0)).toBe(true);
    expect(out[32]).toHaveLength(33);
  });

  it('перерыв короче запаса — задержка пакетов: не держится, иначе буфер опустеет', () => {
    const gate = new HoldGate<string>(640);
    feed(gate, frames(5, true, 40));
    const out = feed(gate, frames(5, true, 5, 40, 40 * 20 + 400));
    expect(out.map((x) => x.length)).toEqual([1, 1, 1, 1, 1]);
  });
});

describe('сколько держать', () => {
  it('чуть меньше цели: пачка приносит ещё последний кадр и повторы RED, а лишнее NetEq сжал бы', () => {
    expect(holdFor(600)).toBe(580);
    expect(holdFor(10)).toBe(0);
  });
});
