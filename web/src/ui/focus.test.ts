import { describe, expect, it } from 'vitest';
import { focusedParticipant } from './focus';

const people = ['аня', 'боря', 'вера'];
const pick = (patch: Partial<Parameters<typeof focusedParticipant>[0]>) =>
  focusedParticipant({ pinned: null, speaking: [], current: null, people, ...patch });

describe('кого показывать крупно', () => {
  it('берёт того, кто говорит', () => {
    expect(pick({ speaking: ['боря'] })).toBe('боря');
  });

  /**
   * Главное свойство. SFU сообщает говорящих несколько раз в секунду, и без залипания
   * крупная плитка прыгала бы на каждом «угу» собеседника.
   */
  it('не отдаёт крупный план чужому «угу», пока прежний говорит', () => {
    expect(pick({ current: 'аня', speaking: ['аня', 'боря'] })).toBe('аня');
  });

  it('передаёт крупный план, когда прежний замолчал, а другой говорит', () => {
    expect(pick({ current: 'аня', speaking: ['боря'] })).toBe('боря');
  });

  it('в тишине оставляет того, на кого и так смотрели', () => {
    expect(pick({ current: 'вера', speaking: [] })).toBe('вера');
  });

  /** Закрепление — прямое указание человека, голос — всего лишь наблюдение. */
  it('закреплённый сильнее говорящего', () => {
    expect(pick({ pinned: 'вера', speaking: ['аня'], current: 'аня' })).toBe('вера');
  });

  it('забывает того, кто вышел: и закреплённого, и крупного', () => {
    expect(pick({ pinned: 'кто-то', speaking: ['боря'] })).toBe('боря');
    expect(pick({ current: 'кто-то', speaking: [] })).toBe('аня');
  });

  it('пустая сцена никого не показывает', () => {
    expect(focusedParticipant({ pinned: null, speaking: [], current: null, people: [] })).toBeNull();
  });

  it('говорящего, которого нет на сцене, не выбирает', () => {
    expect(pick({ speaking: ['служебный-бот'] })).toBe('аня');
  });
});
