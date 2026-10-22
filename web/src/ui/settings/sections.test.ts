import { describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import {
  ROWS,
  SECTIONS,
  placeFor,
  rowAvailable,
  rowText,
  searchSettings,
  sectionsFor,
  type RowId,
  type RowSpec,
} from './sections';

describe('куда ведёт имя раздела (мост settings.open, ссылка «О программе», прежние вкладки)', () => {
  it('прежние вкладки открывают свои новые разделы, а не пустоту', () => {
    expect(placeFor('audio')).toEqual({ section: 'audio', anchor: 'microphone' });
    expect(placeFor('video')).toEqual({ section: 'video', anchor: 'camera' });
    // «Голос и видео» разделён на «Звук» и «Видео» (R100): старое имя и его подразделы — по смыслу.
    expect(placeFor('voice')).toEqual({ section: 'audio' });
    expect(placeFor('voice#output')).toEqual({ section: 'audio', anchor: 'output' });
    expect(placeFor('voice#processing')).toEqual({ section: 'audio', anchor: 'microphone' });
    expect(placeFor('voice#camera')).toEqual({ section: 'video', anchor: 'camera' });
    expect(placeFor('voice#screen')).toEqual({ section: 'video', anchor: 'screen' });
    expect(placeFor('connection')).toEqual({ section: 'server' });
    for (const same of ['profile', 'accounts', 'hotkeys', 'about'] as const)
      expect(placeFor(same)).toEqual({ section: same });
  });

  it('понимает подраздел через решётку и не верит чужому', () => {
    expect(placeFor('video#screen')).toEqual({ section: 'video', anchor: 'screen' });
    expect(placeFor('video#nowhere')).toEqual({ section: 'video' });
    expect(placeFor('appearance')).toEqual({ section: 'appearance' });
  });

  it('без имени и с незнакомым именем — «Звук»', () => {
    expect(placeFor(undefined)).toEqual({ section: 'audio' });
    expect(placeFor('chat')).toEqual({ section: 'audio' });
  });
});

describe('карта строк', () => {
  it('каждая строка стоит в существующем разделе и подразделе', () => {
    for (const [id, spec] of Object.entries(ROWS) as [string, RowSpec][]) {
      const home = SECTIONS.find((section) => section.id === spec.section);
      expect(home, id).toBeDefined();
      if (spec.anchor) expect(home!.anchors, id).toContain(spec.anchor);
    }
  });

  it('лишних строк нет (R21, X3): ни «Чужого видео», ни «Уступать показу», ни «Ботов справа»', () => {
    for (const gone of ['camera-yields', 'reception', 'playout', 'appearance-bots'])
      expect(Object.keys(ROWS), gone).not.toContain(gone);
  });

  it('пояснения короткие: одна строка, без точки в конце (T29)', () => {
    for (const id of Object.keys(ROWS) as RowId[]) {
      const { hint } = rowText(t, id);
      if (!hint) continue;
      expect(hint.length, id).toBeLessThanOrEqual(56);
      expect(hint.endsWith('.'), id).toBe(false);
    }
  });
});

describe('поиск по настройкам', () => {
  it('находит строку по подписи и называет, где она', () => {
    const [hit] = searchSettings(t, 'эхо', 'browser');
    expect(hit).toMatchObject({ row: 'echo', section: 'audio', anchor: 'microphone' });
    expect(hit?.where).toBe('Звук › Микрофон');
  });

  it('ё и е — одно и то же, регистр не важен', () => {
    expect(searchSettings(t, 'ТЕМНАЯ', 'browser').map((hit) => hit.row)).toContain('appearance-theme');
    expect(searchSettings(t, 'тёмная', 'browser').map((hit) => hit.row)).toContain('appearance-theme');
  });

  it('ищет по ключевым словам и началам слов, все слова сразу', () => {
    expect(searchSettings(t, 'токен', 'browser')[0]?.row).toBe('account-yandex-music');
    const [section] = searchSettings(t, 'горяч', 'browser');
    expect(section?.section).toBe('hotkeys');
    expect(section?.row).toBeUndefined();
    // «Подстраивать громкость» лежит в подразделе «Микрофон» — подраздел тоже ищется.
    expect(searchSettings(t, 'громк микро', 'browser').map((hit) => hit.row)).toEqual([
      'mic-auto',
      'mic-volume',
    ]);
    // Камера и показ — в «Видео»: «превью показа» находит переключатель R80.
    expect(searchSettings(t, 'превью показа', 'browser')[0]).toMatchObject({
      row: 'screen-preview',
      section: 'video',
      anchor: 'screen',
    });
  });

  it('пустой запрос и непохожее ничего не находят', () => {
    expect(searchSettings(t, '   ', 'browser')).toEqual([]);
    expect(searchSettings(t, 'шифрование', 'browser')).toEqual([]);
  });

  it('не больше восьми ответов', () => {
    expect(searchSettings(t, 'голос', 'browser', 3)).toHaveLength(3);
    expect(searchSettings(t, 'в', 'browser').length).toBeLessThanOrEqual(8);
  });
});

describe('раздел «Windows» (E01-B2): только в клиенте и только со своими флагами', () => {
  const has = (flags: string[]) => (feature: string) => flags.includes(feature);
  const ids = (context: 'browser' | 'desktop', flags: string[]) =>
    sectionsFor(context, has(flags)).map((spec) => spec.id);

  it('в браузере и в оболочке без app.settings раздела нет', () => {
    expect(ids('browser', ['app.settings', 'tray'])).not.toContain('desktop');
    expect(ids('desktop', ['tray', 'overlay'])).not.toContain('desktop');
    expect(ids('desktop', ['app.settings'])).not.toContain('desktop');
  });

  it('с app.settings — раздел и ровно те строки, чьи флаги объявлены', () => {
    const flags = has(['app.settings', 'tray', 'overlay']);
    expect(ids('desktop', ['app.settings', 'tray', 'overlay'])).toContain('desktop');
    const shown = (Object.entries(ROWS) as [RowId, RowSpec][])
      .filter(([, spec]) => spec.section === 'desktop' && rowAvailable(spec, 'desktop', flags))
      .map(([id]) => id);
    expect(shown).toEqual(['desktop-tray', 'desktop-overlay', 'desktop-overlay-hotkey']);
  });

  it('поиск находит переключатель только там, где он есть', () => {
    const flags = has(['app.settings', 'tray', 'autostart']);
    const rows = (query: string, context: 'browser' | 'desktop', with_ = flags) =>
      searchSettings(t, query, context, 8, with_).map((hit) => hit.row ?? hit.section);
    expect(rows('автозапуск', 'desktop')).toContain('desktop-autostart');
    expect(rows('автозапуск', 'browser')).toEqual([]);
    expect(rows('трей', 'desktop')).toContain('desktop-tray');
    expect(rows('трей', 'desktop', has(['app.settings', 'autostart']))).not.toContain('desktop-tray');
  });
});
