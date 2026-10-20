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

  it('язык браузера берётся сам, если на него переведено; незнакомый — русский', () => {
    // E14-B: все восемь языков переведены (TRANSLATED), браузер на английском получает английский.
    expect(detectLanguage(null, ['en-US', 'en'])).toBe('en');
    expect(detectLanguage(null, ['zh-CN'])).toBe('zh-Hans');
    expect(detectLanguage(null, ['ja-JP', 'it-IT'])).toBe('it');
    expect(detectLanguage(null, ['ja-JP'])).toBe('ru');
    expect(detectLanguage('de', ['en-US'])).toBe('de');
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
    expect(t(($) => $.common.close)).toBe('Close');
    expect(locale()).toBe('en');
    // Ключ, который появился в ru, а перевести его ещё не успели, показывается по-русски.
    i18next.addResource('ru', 'translation', 'test.fresh', 'Новая строка');
    expect(i18next.t('test.fresh' as never)).toBe('Новая строка');
  });

  it('формы числа — по правилам языка: английский one/other, китайский одна, французский с many', async () => {
    await applyLanguage('en');
    expect(t(($) => $.durak.cards, { count: 1 })).toBe('1 card');
    expect(t(($) => $.durak.cards, { count: 21 })).toBe('21 cards');
    await applyLanguage('zh-Hans');
    expect(t(($) => $.durak.cards, { count: 3 })).toBe('3 张牌');
    await applyLanguage('fr');
    expect(t(($) => $.durak.cards, { count: 1 })).toBe('1\u00a0carte');
    expect(t(($) => $.durak.cards, { count: 1_000_000 })).toBe('1000000\u00a0cartes');
  });

  it('ошибку сервера по-русски показывает как есть, иначе — по коду, а без перевода — как есть', async () => {
    expect(errorText('ROOM_FULL', 'Во встрече уже 20 участников')).toBe('Во встрече уже 20 участников');
    await i18next.changeLanguage('en');
    expect(errorText('ROOM_FULL', 'Во встрече уже 20 участников')).toBe('The meeting is full');
    // Код, которого в языке нет, — слово сервера: русский шаблон реестра с «…» хуже точного текста.
    expect(errorText('NO_SUCH_CODE', 'Текст сервера')).toBe('Текст сервера');
    expect(errorText(undefined, 'Текст сервера')).toBe('Текст сервера');
  });
});
