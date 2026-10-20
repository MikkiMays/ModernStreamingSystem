import { describe, expect, it } from 'vitest';
import { SHELF, musicHint, telegramNote } from './integration-shelf';

describe('витрина интеграций (T30, T08, T12, T13)', () => {
  it('порядок: игры, кинозал, музыка, затем «Скоро», Telegram — в самом низу', () => {
    expect(SHELF.map((item) => item.id)).toEqual([
      'games',
      'cinema',
      'music',
      'any-game',
      'standup',
      'board',
      'telegram',
    ]);
    expect(SHELF.filter((item) => !item.soon).map((item) => item.id)).toEqual(['games', 'cinema', 'music']);
    expect(SHELF.at(-1)).toMatchObject({ id: 'telegram', soon: true, apart: true });
    expect(SHELF.filter((item) => item.apart).map((item) => item.id)).toEqual(['telegram']);
  });

  it('у каждой «Скоро» — одна строка о том, что это будет', () => {
    const soon = SHELF.filter((item) => item.soon);
    expect(soon.map((item) => item.name)).toEqual([
      'Любая игра',
      'Сцена стендап',
      'Доска рисования',
      'Telegram',
    ]);
    for (const item of soon) {
      expect(item.hint.length).toBeGreaterThan(10);
      expect(item.hint).not.toContain('\n');
    }
  });

  it('Telegram видят все, а подсказка про создателя — у всех, кроме него', () => {
    expect(telegramNote(false)).toBe('Подключит создатель встречи');
    expect(telegramNote(true)).toBeNull();
  });

  it('подсказка музыки называет включённые источники', () => {
    expect(musicHint(['upload', 'telegram', 'yandex', 'youtube', 'soundcloud'])).toBe(
      'YouTube, SoundCloud, Яндекс Музыка и свои файлы',
    );
    expect(musicHint(['upload', 'yandex'])).toBe('Яндекс Музыка и свои файлы');
    expect(musicHint(['youtube'])).toBe('YouTube');
    expect(musicHint(['upload'])).toBe('Свои аудиофайлы');
    expect(musicHint([])).toBe('Общая очередь на всю встречу');
  });
});
