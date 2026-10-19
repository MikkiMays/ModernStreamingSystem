import { describe, expect, it } from 'vitest';
import { ROWS, SECTIONS, placeFor, searchSettings, type RowSpec } from './sections';

describe('куда ведёт имя раздела (мост settings.open, ссылка «О программе», прежние вкладки)', () => {
  it('прежние вкладки открывают свои новые разделы, а не пустоту', () => {
    expect(placeFor('audio')).toEqual({ section: 'voice', anchor: 'microphone' });
    expect(placeFor('video')).toEqual({ section: 'voice', anchor: 'camera' });
    expect(placeFor('connection')).toEqual({ section: 'server' });
    for (const same of ['profile', 'accounts', 'hotkeys', 'about'] as const)
      expect(placeFor(same)).toEqual({ section: same });
  });

  it('понимает подраздел через решётку и не верит чужому', () => {
    expect(placeFor('voice#screen')).toEqual({ section: 'voice', anchor: 'screen' });
    expect(placeFor('voice#nowhere')).toEqual({ section: 'voice' });
    expect(placeFor('appearance')).toEqual({ section: 'appearance' });
  });

  it('без имени и с незнакомым именем — «Голос и видео»', () => {
    expect(placeFor(undefined)).toEqual({ section: 'voice' });
    expect(placeFor('chat')).toEqual({ section: 'voice' });
  });
});

describe('карта строк', () => {
  it('каждая строка стоит в существующем разделе и подразделе', () => {
    for (const [id, spec] of Object.entries(ROWS) as [string, RowSpec][]) {
      const home = SECTIONS.find((section) => section.id === spec.section);
      expect(home, id).toBeDefined();
      if (spec.anchor)
        expect(
          home!.anchors.map((anchor) => anchor.id),
          id,
        ).toContain(spec.anchor);
    }
  });

  it('пояснения короткие: одна строка, без точки в конце (T29)', () => {
    for (const [id, spec] of Object.entries(ROWS) as [string, RowSpec][]) {
      if (!spec.hint) continue;
      expect(spec.hint.length, id).toBeLessThanOrEqual(56);
      expect(spec.hint.endsWith('.'), id).toBe(false);
    }
  });
});

describe('поиск по настройкам', () => {
  it('находит строку по подписи и называет, где она', () => {
    const [hit] = searchSettings('эхо', 'browser');
    expect(hit).toMatchObject({ row: 'echo', section: 'voice', anchor: 'processing' });
    expect(hit?.where).toBe('Голос и видео › Обработка звука');
  });

  it('ё и е — одно и то же, регистр не важен', () => {
    expect(searchSettings('ТЕМНАЯ', 'browser').map((hit) => hit.row)).toContain('appearance-theme');
    expect(searchSettings('тёмная', 'browser').map((hit) => hit.row)).toContain('appearance-theme');
  });

  it('ищет по ключевым словам и началам слов, все слова сразу', () => {
    expect(searchSettings('токен', 'browser')[0]?.row).toBe('account-yandex-music');
    const [section] = searchSettings('горяч', 'browser');
    expect(section?.section).toBe('hotkeys');
    expect(section?.row).toBeUndefined();
    // «Подстраивать громкость» лежит в подразделе «Микрофон» — подраздел тоже ищется.
    expect(searchSettings('громк микро', 'browser').map((hit) => hit.row)).toEqual([
      'mic-volume',
      'mic-auto',
    ]);
  });

  it('пустой запрос и непохожее ничего не находят', () => {
    expect(searchSettings('   ', 'browser')).toEqual([]);
    expect(searchSettings('шифрование', 'browser')).toEqual([]);
  });

  it('не больше восьми ответов', () => {
    expect(searchSettings('голос', 'browser', 3)).toHaveLength(3);
    expect(searchSettings('в', 'browser').length).toBeLessThanOrEqual(8);
  });
});
