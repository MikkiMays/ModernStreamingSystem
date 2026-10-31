import { describe, expect, it } from 'vitest';
import { t } from '../i18n';
import { SHELF, musicHint, shelfHint, shelfName, telegramNote } from './integration-shelf';

describe('витрина интеграций (T30, T12, T13, R158)', () => {
  it('порядок: игры, кинозал, музыка, затем «Скоро», Telegram — в самом низу', () => {
    expect(SHELF.map((item) => item.id)).toEqual([
      'games',
      'cinema',
      'music',
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
    expect(soon.map((item) => shelfName(t, item.id))).toEqual([
      'Сцена стендап',
      'Доска рисования',
      'Telegram',
    ]);
    for (const item of soon) {
      expect(shelfHint(t, item.id).length).toBeGreaterThan(10);
      expect(shelfHint(t, item.id)).not.toContain('\n');
    }
  });

  it('Telegram видят все, а подсказка про создателя — у всех, кроме него', () => {
    expect(telegramNote(t, false)).toBe('Подключит создатель встречи');
    expect(telegramNote(t, true)).toBeNull();
  });

  it('подсказка музыки называет включённые источники', () => {
    expect(musicHint(t, ['upload', 'telegram', 'yandex', 'youtube', 'soundcloud'])).toBe(
      'YouTube, SoundCloud, Яндекс Музыка и свои файлы',
    );
    expect(musicHint(t, ['upload', 'yandex'])).toBe('Яндекс Музыка и свои файлы');
    expect(musicHint(t, ['youtube'])).toBe('YouTube');
    expect(musicHint(t, ['upload'])).toBe('Свои аудиофайлы');
    expect(musicHint(t, [])).toBe('Общая очередь на всю встречу');
  });
});
