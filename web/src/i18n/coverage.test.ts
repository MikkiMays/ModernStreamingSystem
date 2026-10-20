import { describe, expect, it } from 'vitest';
import { audit, pluralCategories } from '../../scripts/i18n/coverage.mjs';
import { LANGUAGES, SOURCE_LANGUAGE, TRANSLATED } from './languages';
import ru from './locales/ru.json';

const catalogs = import.meta.glob<Record<string, unknown>>('./locales/*.json', {
  eager: true,
  import: 'default',
});
const others = LANGUAGES.filter((language) => language !== SOURCE_LANGUAGE);

describe('полнота переводов (E14-B)', () => {
  it.each(others)('%s: каждый ключ ru, те же вставки и разметка, свои формы числа', (language) => {
    const result = audit(ru, catalogs[`./locales/${language}.json`]!, language);
    expect(result.problems).toEqual([]);
    expect(result.covered).toBe(result.total);
  });

  it('браузер выбирает сам только полностью переведённые языки — сейчас это все восемь', () => {
    expect([...TRANSLATED].sort()).toEqual([...LANGUAGES].sort());
  });

  it('формы числа — как у Intl.PluralRules, которым считает i18next', () => {
    expect(pluralCategories('ru')).toEqual(['one', 'few', 'many', 'other']);
    expect(pluralCategories('en')).toEqual(['one', 'other']);
    expect(pluralCategories('de')).toEqual(['one', 'other']);
    expect(pluralCategories('zh-Hans')).toEqual(['other']);
    for (const language of ['es', 'fr', 'it', 'pt-BR'])
      expect(pluralCategories(language)).toEqual(['one', 'many', 'other']);
  });

  it('ловит пропуск, лишний ключ, чужую вставку, потерянную разметку, кириллицу и не те формы', () => {
    const source = {
      a: 'Привет, {{name}}',
      b: 'Нажмите <b>Далее</b>',
      cards_one: '{{count}} карта',
      cards_few: '{{count}} карты',
      cards_many: '{{count}} карт',
      cards_other: '{{count}} карты',
      empty: '',
    };
    const good = {
      a: 'Hi, {{name}}',
      b: 'Click <b>Next</b>',
      cards_one: '{{count}} card',
      cards_other: '{{count}} cards',
      empty: '',
    };
    expect(audit(source, good, 'en').problems).toEqual([]);
    const bad = {
      a: 'Hi, {{user}}',
      b: 'Click Next',
      cards_other: '{{count}} cards',
      cards_few: '{{count}} cards',
      empty: 'x',
      extra: 'Привет',
    };
    const { problems } = audit(source, bad, 'en');
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('a: лишние вставки user'),
        expect.stringContaining('b: разметка'),
        'cards_one: нет перевода',
        'cards_few: лишний ключ (в ru нет)',
        'empty: в ru пусто',
        'extra: лишний ключ (в ru нет)',
      ]),
    );
    // Французский требует ещё и «many» (1 000 000): без неё i18next ушёл бы к русскому тексту.
    expect(audit(source, good, 'fr').problems).toContain('cards_many: нет перевода');
  });
});
