import { describe, expect, it } from 'vitest';
import { MEMORY_DAYS, MEMORY_KEY, StoredCodecMemory } from './codec-memory';

function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    raw: () => map.get(MEMORY_KEY),
  };
}
const p720 = { width: 1280, height: 720, fps: 30, bitrate: 3_000_000 };
const p1080 = { width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 };
const p360 = { width: 640, height: 360, fps: 30, bitrate: 800_000 };

describe('память машины о кодеках (R189, И2)', () => {
  it('отвергнутая ступень действует на свой уровень и всё, что не легче; на лёгком — нет', () => {
    const memory = new StoredCodecMemory(storage(), () => 1000);
    memory.remember('camera', 'ua|gpu', p720, 'av1:hw', 'cpu');
    expect(memory.failed('camera', 'ua|gpu', p720).get('av1:hw')).toBe('cpu');
    expect(memory.failed('camera', 'ua|gpu', p1080).get('av1:hw')).toBe('cpu');
    expect(memory.failed('camera', 'ua|gpu', p360).size).toBe(0);
    // Другая машина, другой источник — своя память.
    expect(memory.failed('camera', 'ua|other', p720).size).toBe(0);
    expect(memory.failed('screen-sharp', 'ua|gpu', p720).size).toBe(0);
  });

  it('запись стареет через неделю, повтор той же ступени обновляет её, хранилище может молчать', () => {
    let now = 1000;
    const store = storage();
    const memory = new StoredCodecMemory(store, () => now);
    memory.remember('camera', 's', p720, 'vp9:sw', 'encode-time');
    now += MEMORY_DAYS * 86_400_000 - 1;
    expect(memory.failed('camera', 's', p720).size).toBe(1);
    memory.remember('camera', 's', p720, 'vp9:sw', 'cpu');
    expect(JSON.parse(store.raw()!)).toHaveLength(1);
    now += MEMORY_DAYS * 86_400_000 + 1;
    expect(memory.failed('camera', 's', p720).size).toBe(0);
    const silent = new StoredCodecMemory(null);
    silent.remember('camera', 's', p720, 'vp9:sw', 'cpu');
    expect(silent.failed('camera', 's', p720).size).toBe(0);
  });
});
