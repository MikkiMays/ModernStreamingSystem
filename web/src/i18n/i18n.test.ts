import { describe, expect, it } from 'vitest';
import { detectLanguage, errorText, i18next, matchLanguage } from './index';

describe('языки', () => {
  it('сопоставляет язык браузера с языками Cord', () => {
    expect(matchLanguage('en-US')).toBe('en');
    expect(matchLanguage('zh-CN')).toBe('zh-Hans');
    expect(matchLanguage('pt-PT')).toBe('pt-BR');
    expect(matchLanguage('pt-BR')).toBe('pt-BR');
    expect(matchLanguage('ja')).toBeNull();
  });

  it('выбор человека важнее браузера, без обоих — русский', () => {
    expect(detectLanguage('de', ['fr-FR'])).toBe('de');
    expect(detectLanguage(null, ['ja-JP', 'it-IT'])).toBe('it');
    expect(detectLanguage(null, ['ja-JP'])).toBe('ru');
  });

  it('русский считает формы числа по-русски', () => {
    i18next.addResource('ru', 'translation', 'test.people_one', '{{count}} человек');
    i18next.addResource('ru', 'translation', 'test.people_few', '{{count}} человека');
    i18next.addResource('ru', 'translation', 'test.people_many', '{{count}} человек');
    expect(i18next.t('test.people' as never, { count: 3, lng: 'ru' })).toBe('3 человека');
    expect(i18next.t('test.people' as never, { count: 11, lng: 'ru' })).toBe('11 человек');
  });

  it('ошибку сервера по-русски показывает как есть, иначе — по коду', async () => {
    expect(errorText('ROOM_FULL', 'Во встрече уже 20 участников')).toBe('Во встрече уже 20 участников');
    i18next.addResourceBundle('en', 'translation', { errors: { ROOM_FULL: 'The meeting is full' } }, true);
    await i18next.changeLanguage('en');
    expect(errorText('ROOM_FULL', 'Во встрече уже 20 участников')).toBe('The meeting is full');
    expect(errorText('NO_SUCH_CODE', 'Текст сервера')).toBe('Текст сервера');
    await i18next.changeLanguage('ru');
  });
});
