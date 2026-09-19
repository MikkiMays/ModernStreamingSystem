import { describe, expect, it } from 'vitest';
import {
  audioChoices,
  captionChoices,
  languageName,
  pickAudio,
  pickCaption,
  sameLanguage,
  type MediaTrack,
} from './watch-tracks';

/**
 * То, что YouTube правда кладёт в плейлист ролика с озвучками: два десятка дорожек по коду
 * языка и оригинал в самом конце. Основной не помечена ни одна — `DEFAULT=NO` у всех.
 */
const dubbed: MediaTrack[] = [
  { name: 'العربية - dubbed', lang: 'ar' },
  { name: 'Deutsch - dubbed', lang: 'de' },
  { name: 'Français - dubbed', lang: 'fr' },
  { name: 'Русский - dubbed', lang: 'ru' },
  { name: 'American English - original', lang: 'en-US' },
];

describe('язык озвучки', () => {
  it('по умолчанию говорит голосом автора, а не первым по алфавиту', () => {
    // Жалоба была ровно про это: английский ролик начинал говорить по-французски.
    expect(pickAudio(dubbed, '', 'en-US')).toBe(4);
  });

  it('выбранный язык сильнее оригинала', () => {
    expect(pickAudio(dubbed, 'ru', 'en-US')).toBe(3);
  });

  it('без такой озвучки выбор молча уступает оригиналу', () => {
    expect(pickAudio(dubbed, 'ja', 'en-US')).toBe(4);
  });

  it('без подписи «original» оригинал узнаётся по языку самого ролика', () => {
    const plain = dubbed.map((track) => ({ ...track, name: track.name.replace(/ - .*/, '') }));
    expect(pickAudio(plain, '', 'en-US')).toBe(4);
    expect(pickAudio(plain, '', 'ru')).toBe(3);
  });

  it('когда не сошлось ничего, остаётся первая дорожка', () => {
    const plain = dubbed.map((track) => ({ ...track, name: track.name.replace(/ - .*/, '') }));
    expect(pickAudio(plain, '', '')).toBe(0);
    expect(pickAudio([], '', 'en')).toBe(-1);
  });

  it('в меню язык назван по-русски, а пометка оригинала остаётся', () => {
    const list = audioChoices(dubbed);
    // Последняя строка у разных движков написана по-разному («Американский английский» или
    // «Английский (США)»), и это не важно: важно, что она на русском и не «English - original».
    expect(list.slice(0, 4).map((item) => item.label)).toEqual([
      'Арабский',
      'Немецкий',
      'Французский',
      'Русский',
    ]);
    expect(list[4]?.label).toMatch(/английский/i);
    expect(list.filter((item) => item.original).map((item) => item.index)).toEqual([4]);
  });

  it('язык без названия остаётся подписью площадки', () => {
    expect(languageName('zz-orig', 'Klingon')).toBe('Klingon');
    expect(languageName('', 'Korean (Original)')).toBe('Korean (Original)');
  });

  it('код языка сравнивается так же, как это делает плеер', () => {
    expect(sameLanguage('en', 'en-US')).toBe(true);
    expect(sameLanguage('ru', 'ru')).toBe(true);
    expect(sameLanguage('zh-Hans', 'zh-Hant')).toBe(false);
    expect(sameLanguage('', 'ru')).toBe(false);
  });
});

describe('субтитры', () => {
  const written: MediaTrack[] = [{ name: 'English', lang: 'en' }];
  const recognised = [{ lang: 'ko', label: 'Korean', auto: true, url: '/api/v1/services/cinema/fetch?u=ko' }];

  it('написанные и распознанные стоят одним списком', () => {
    expect(captionChoices(written, recognised)).toEqual([
      { id: 'en', label: 'Английский', auto: false, track: 0 },
      { id: 'ko~auto', label: 'Корейский', auto: true, track: -1, url: '/api/v1/services/cinema/fetch?u=ko' },
    ]);
  });

  it('помнится язык, а не строка меню', () => {
    const list = captionChoices(written, recognised);
    // Выбирали написанные корейские у прошлого ролика — здесь они распознанные, но корейские.
    expect(pickCaption(list, 'ko')).toBe('ko~auto');
    expect(pickCaption(list, 'en~auto')).toBe('en');
    expect(pickCaption(list, 'ru')).toBe('');
    expect(pickCaption(list, '')).toBe('');
  });
});
