import { describe, expect, it } from 'vitest';
import { t } from '../i18n';
import {
  defaultMicHotkey,
  hotkeyFromMouse,
  hotkeyLabel,
  hotkeyNotes,
  matchesMouseHotkey,
  releasesHotkey,
  validHotkey,
  type Hotkey,
} from './hotkeys';

const key = (code: string, mods: Partial<Omit<Hotkey, 'code'>> = {}): Hotkey => ({
  code,
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  ...mods,
});

describe('hotkeyNotes — что мешает сочетанию, проверяется при назначении (T27)', () => {
  it('сочетание по умолчанию чистое и в браузере, и в приложении', () => {
    expect(hotkeyNotes(t, defaultMicHotkey, 'browser')).toEqual([]);
    expect(hotkeyNotes(t, defaultMicHotkey, 'desktop')).toEqual([]);
  });

  it('то, что браузер оставляет себе, не назначается в браузере, но годится в приложении', () => {
    for (const reserved of [
      key('KeyW', { ctrl: true }),
      key('KeyT', { ctrl: true }),
      key('KeyN', { ctrl: true }),
      key('KeyN', { ctrl: true, shift: true }),
    ]) {
      expect(hotkeyNotes(t, reserved, 'browser')[0]?.level, hotkeyLabel(t, reserved)).toBe('blocked');
      expect(hotkeyNotes(t, reserved, 'desktop').some((note) => note.level === 'blocked')).toBe(false);
    }
  });

  it('Alt + F4 закрывает окно — не назначается нигде', () => {
    const close = key('F4', { alt: true });
    expect(hotkeyNotes(t, close, 'browser')[0]?.level).toBe('blocked');
    expect(hotkeyNotes(t, close, 'desktop')[0]?.level).toBe('blocked');
  });

  it('в приложении без Ctrl или Alt, с клавишей Windows и с F12 — только в окне Cord', () => {
    for (const local of [
      key('KeyM'),
      key('KeyM', { shift: true }),
      key('KeyM', { ctrl: true, meta: true }),
      key('F12', { ctrl: true }),
    ]) {
      const notes = hotkeyNotes(t, local, 'desktop');
      expect(
        notes.map((note) => note.level),
        hotkeyLabel(t, local),
      ).toContain('warning');
      expect(notes.map((note) => note.text).join(' '), hotkeyLabel(t, local)).toMatch(/только в окне Cord/);
    }
    // В браузере то же сочетание о «поверх программ» не говорит: там его нет вовсе.
    expect(
      hotkeyNotes(t, key('KeyM', { shift: true }), 'browser')
        .map((note) => note.text)
        .join(' '),
    ).not.toMatch(/окне Cord/);
  });

  it('пробел и клавиши плеера без Ctrl/Alt предупреждают о кинозале', () => {
    for (const code of ['Space', 'KeyK', 'KeyM']) {
      const notes = hotkeyNotes(t, key(code), 'browser');
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ level: 'warning' });
      expect(notes[0]?.text).toMatch(/плеер/);
    }
    // С Shift плеер клавишу всё равно ловит; с Ctrl — уже нет.
    expect(hotkeyNotes(t, key('Space', { shift: true }), 'browser')[0]?.text).toMatch(/плеер/);
    expect(hotkeyNotes(t, key('Space', { ctrl: true }), 'browser')).toEqual([]);
  });

  it('буквы покерного стола предупреждают, что сработает и ход', () => {
    // F — и плеер, и «пас»: обе заметки.
    const both = hotkeyNotes(t, key('KeyF'), 'browser').map((note) => note.text);
    expect(both).toHaveLength(2);
    expect(both.join(' ')).toMatch(/плеер/);
    expect(both.join(' ')).toMatch(/пас/);
    const fold = hotkeyNotes(t, key('KeyR', { shift: true }), 'browser');
    expect(fold).toHaveLength(1);
    expect(fold[0]?.text).toMatch(/покер/);
    expect(hotkeyNotes(t, key('KeyA', { alt: true }), 'browser')).toEqual([]);
  });

  it('подписывает пробел словом, а не кодом', () => {
    expect(hotkeyNotes(t, key('Space'), 'browser')[0]?.text).toMatch(/^Пробел/);
  });
});

describe('кнопки мыши и Raw Input (E01-B3, cord-native)', () => {
  it('Mouse3–Mouse5 — допустимые сочетания, остальные кнопки — нет', () => {
    for (const code of ['Mouse3', 'Mouse4', 'Mouse5']) expect(validHotkey(key(code))).toBe(true);
    expect(validHotkey(key('Mouse1'))).toBe(false);
    expect(validHotkey(key('Mouse6'))).toBe(false);
  });

  it('кнопка события → сочетание: средняя — Mouse3, боковые — Mouse4 и Mouse5, левая и правая — ничего', () => {
    const press = (button: number, mods: Partial<MouseEventInit> = {}) =>
      hotkeyFromMouse({ button, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
    expect(press(1)).toEqual(key('Mouse3'));
    expect(press(3, { ctrlKey: true })).toEqual(key('Mouse4', { ctrl: true }));
    expect(press(4)).toEqual(key('Mouse5'));
    expect(press(0)).toBeNull();
    expect(press(2)).toBeNull();
    const event = { button: 3, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    expect(matchesMouseHotkey(event, key('Mouse4'))).toBe(true);
    expect(matchesMouseHotkey(event, key('Mouse4', { shift: true }))).toBe(false);
    expect(matchesMouseHotkey(event, key('KeyM'))).toBe(false);
  });

  it('подписывает кнопки мыши словами', () => {
    expect(hotkeyLabel(t, key('Mouse3'))).toBe('Средняя кнопка мыши');
    expect(hotkeyLabel(t, key('Mouse4', { ctrl: true }))).toBe('Ctrl + Кнопка мыши 4');
  });

  it('отпускание: сама клавиша или любой модификатор сочетания', () => {
    const combo = key('KeyV', { ctrl: true });
    const up = (code: string) => releasesHotkey({ code } as KeyboardEvent, combo);
    expect(up('KeyV')).toBe(true);
    expect(up('ControlLeft')).toBe(true);
    expect(up('ShiftLeft')).toBe(false);
    expect(up('KeyB')).toBe(false);
    expect(releasesHotkey({ code: 'KeyV' } as KeyboardEvent, null)).toBe(false);
  });

  it('Raw Input: без Ctrl/Alt, с F12 и с клавишей Windows работает и поверх программ — заметок «только в окне» нет', () => {
    for (const any of [
      key('KeyM', { shift: true }),
      key('F12'),
      key('KeyM', { ctrl: true, meta: true }),
      key('Mouse4'),
    ])
      expect(
        hotkeyNotes(t, any, 'native')
          .map((note) => note.text)
          .join(' '),
        hotkeyLabel(t, any),
      ).not.toMatch(/только в окне Cord/);
  });

  it('Raw Input: голая буква предупреждает, что сработает и при наборе текста; кнопка мыши и F-клавиша — нет', () => {
    const notes = hotkeyNotes(t, key('KeyV'), 'native');
    expect(notes).toEqual([{ level: 'warning', text: expect.stringMatching(/набор/) }]);
    expect(hotkeyNotes(t, key('Mouse5'), 'native')).toEqual([]);
    expect(hotkeyNotes(t, key('F8'), 'native')).toEqual([]);
    expect(hotkeyNotes(t, key('KeyV', { ctrl: true }), 'native')).toEqual([]);
    // Клавиши плеера предупреждают и здесь: правило E03-7 то же.
    expect(
      hotkeyNotes(t, key('Space'), 'native')
        .map((note) => note.text)
        .join(' '),
    ).toMatch(/плеер/);
  });
});
