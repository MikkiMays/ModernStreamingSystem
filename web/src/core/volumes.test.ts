import { beforeEach, describe, expect, it } from 'vitest';
import { recallVolume, rememberVolume, volumeKey } from './volumes';

describe('память громкостей', () => {
  beforeEach(() => localStorage.clear());

  /**
   * Вернувшегося узнают не по номеру участника: на каждый вход он новый. Музыку узнают по
   * виду службы — её имя принадлежит серверу, а «музыка этой встречи» одна и та же.
   */
  it('узнаёт человека по имени, а службу — по её виду', () => {
    expect(volumeKey({ name: ' Петя ', service: null })).toBe('name:петя');
    expect(volumeKey({ name: 'Петя', service: 'music' })).toBe('service:music');
    expect(volumeKey({ name: '  ', service: null })).toBeNull();
  });

  it('помнит громкость по встречам и не путает соседние', () => {
    rememberVolume('room-a', 'name:петя', 0.3);
    rememberVolume('room-b', 'name:петя', 1);
    expect(recallVolume('room-a', 'name:петя')).toBe(0.3);
    expect(recallVolume('room-b', 'name:петя')).toBe(1);
    expect(recallVolume('room-c', 'name:петя')).toBeUndefined();
    rememberVolume('room-a', 'name:петя', 0);
    expect(recallVolume('room-a', 'name:петя')).toBe(0);
  });

  /** Список вспомогательный: он не должен расти, пока браузер не кончится. */
  it('держит два десятка последних встреч, вытесняя самые давние', () => {
    for (let i = 0; i < 25; i++) rememberVolume(`room-${i}`, 'service:music', 0.05);
    expect(recallVolume('room-0', 'service:music')).toBeUndefined();
    expect(recallVolume('room-4', 'service:music')).toBeUndefined();
    expect(recallVolume('room-24', 'service:music')).toBe(0.05);
    expect(recallVolume('room-5', 'service:music')).toBe(0.05);
  });

  it('переживает испорченную запись, а не падает на ней', () => {
    localStorage.setItem('cord:volumes:v1', 'не json');
    expect(recallVolume('room-a', 'name:петя')).toBeUndefined();
    rememberVolume('room-a', 'name:петя', 0.5);
    expect(recallVolume('room-a', 'name:петя')).toBe(0.5);
  });
});
