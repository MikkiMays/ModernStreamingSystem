import { describe, expect, it } from 'vitest';
import { t } from '../i18n';
import { defaultMicHotkey, hotkeyLabel, hotkeyNotes, type Hotkey } from './hotkeys';

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
