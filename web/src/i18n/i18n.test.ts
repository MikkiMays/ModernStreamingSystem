import { afterEach, describe, expect, it } from 'vitest';
import { applyLanguage, detectLanguage, errorText, i18next, locale, matchLanguage, t } from './index';

describe('языки', () => {
  afterEach(async () => {
    await i18next.changeLanguage('ru');
  });

  it('сопоставляет язык браузера с языками Cord', () => {
    expect(matchLanguage('en-US')).toBe('en');
    expect(matchLanguage('zh-CN')).toBe('zh-Hans');
    expect(matchLanguage('pt-PT')).toBe('pt-BR');
    expect(matchLanguage('pt-BR')).toBe('pt-BR');
    expect(matchLanguage('ja')).toBeNull();
  });

  it('выбор человека важнее браузера, без обоих — русский', () => {
    expect(detectLanguage('de', ['fr-FR'])).toBe('de');
    expect(detectLanguage(null, ['ja-JP', 'ru-RU'])).toBe('ru');
    expect(detectLanguage(null, ['ja-JP'])).toBe('ru');
  });

  it('язык браузера без перевода не выбирается сам: русский текст под чужим locale хуже русского', () => {
    // До E14-B у en…pt-BR только подпись выбора языка: английский браузер давал «Субтитры Russian».
    expect(detectLanguage(null, ['en-US', 'en'])).toBe('ru');
    expect(detectLanguage(null, ['it-IT'])).toBe('ru');
    expect(detectLanguage('en', ['en-US'])).toBe('en');
  });

  it('по-русски сразу, без ожидания загрузки', () => {
    expect(i18next.language).toBe('ru');
    expect(t(($) => $.language.system)).toBe('Как в браузере');
    expect(locale()).toBe('ru-RU');
  });

  it('русский считает формы числа по-русски', () => {
    i18next.addResource('ru', 'translation', 'test.people_one', '{{count}} человек');
    i18next.addResource('ru', 'translation', 'test.people_few', '{{count}} человека');
    i18next.addResource('ru', 'translation', 'test.people_many', '{{count}} человек');
    expect(i18next.t('test.people' as never, { count: 3, lng: 'ru' })).toBe('3 человека');
    expect(i18next.t('test.people' as never, { count: 11, lng: 'ru' })).toBe('11 человек');
    expect(i18next.t('test.people' as never, { count: 21, lng: 'ru' })).toBe('21 человек');
  });

  it('другой язык приходит своим файлом; чего в нём нет — по-русски', async () => {
    expect(await applyLanguage('en')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(t(($) => $.language.label)).toBe('Language');
    expect(t(($) => $.common.close)).toBe('Закрыть');
    expect(locale()).toBe('en');
  });

  it('ошибку сервера по-русски показывает как есть, иначе — по коду, а без перевода — как есть', async () => {
    expect(errorText('ROOM_FULL', 'Во встрече уже 20 участников')).toBe('Во встрече уже 20 участников');
    await i18next.changeLanguage('en');
    // Русский текст реестра — не перевод: без английского остаётся слово сервера.
    expect(errorText('ROOM_FULL', 'Во встрече уже 20 участников')).toBe('Во встрече уже 20 участников');
    i18next.addResourceBundle('en', 'translation', { errors: { ROOM_FULL: 'The meeting is full' } }, true);
    expect(errorText('ROOM_FULL', 'Во встрече уже 20 участников')).toBe('The meeting is full');
    expect(errorText(undefined, 'Текст сервера')).toBe('Текст сервера');
  });
});
