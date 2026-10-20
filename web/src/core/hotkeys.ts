import type { Translate } from '../i18n';

export interface Hotkey {
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}
export const defaultMicHotkey: Hotkey = { code: 'KeyM', ctrl: true, alt: false, shift: true, meta: false };
export function validHotkey(value: unknown): value is Hotkey {
  if (!value || typeof value !== 'object') return false;
  const key = value as Hotkey;
  return (
    /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Space)$/.test(key.code) &&
    ['ctrl', 'alt', 'shift', 'meta'].every((k) => typeof key[k as keyof Hotkey] === 'boolean')
  );
}
export function hotkeyFromEvent(
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): Hotkey | null {
  const value = {
    code: event.code,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
  return validHotkey(value) ? value : null;
}
export function matchesHotkey(event: KeyboardEvent, key: Hotkey | null) {
  return (
    key &&
    event.code === key.code &&
    event.ctrlKey === key.ctrl &&
    event.altKey === key.alt &&
    event.shiftKey === key.shift &&
    event.metaKey === key.meta
  );
}
export function hotkeyLabel(t: Translate, key: Hotkey | null) {
  if (!key) return t(($) => $.hotkeys.unassigned);
  return [
    key.ctrl && 'Ctrl',
    key.alt && 'Alt',
    key.shift && 'Shift',
    key.meta && 'Meta',
    key.code === 'Space' ? t(($) => $.hotkeys.space) : key.code.replace(/^(Key|Digit)/, ''),
  ]
    .filter(Boolean)
    .join(' + ');
}
export function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    !!target.closest('input, textarea, select, [contenteditable="true"], [data-hotkey-recorder]')
  );
}

/**
 * Где сочетание будет жить: в браузере (только пока вкладка Cord активна) или в приложении
 * (поверх других программ — через системную регистрацию оболочки).
 */
export type HotkeyPlace = 'browser' | 'desktop';

/**
 * Заметка о назначаемом сочетании: `blocked` — назначить нельзя, сработает не Cord, а браузер
 * или система; `warning` — назначить можно, но человек должен знать, где оно не сработает или
 * что ещё сделает то же нажатие.
 */
export interface HotkeyNote {
  level: 'blocked' | 'warning';
  text: string;
}

/** Сочетания, которые Chromium не отдаёт странице: новое окно, вкладка, закрыть вкладку. */
const BROWSER_RESERVED = new Set([
  'ctrl+KeyN',
  'ctrl+KeyT',
  'ctrl+KeyW',
  'ctrl+shift+KeyN',
  'ctrl+shift+KeyT',
  'ctrl+shift+KeyW',
  'ctrl+F4',
]);

/** Клавиши плеера кинозала без Ctrl/Alt (`ui/cinema/theater/watch-keys.ts`); Shift их не отменяет. */
const PLAYER_KEYS: Record<string, 'pause' | 'sound' | 'fullscreen'> = {
  Space: 'pause',
  KeyK: 'pause',
  KeyM: 'sound',
  KeyF: 'fullscreen',
};

/** Клавиши хода за покерным столом без Ctrl/Alt (`ui/PokerTable.tsx`); Shift их тоже не отменяет. */
const POKER_KEYS: Record<string, 'fold' | 'checkCall' | 'bet' | 'allIn'> = {
  KeyF: 'fold',
  KeyC: 'checkCall',
  KeyR: 'bet',
  KeyA: 'allIn',
};

function signature(key: Hotkey) {
  return [key.ctrl && 'ctrl', key.alt && 'alt', key.shift && 'shift', key.meta && 'meta', key.code]
    .filter(Boolean)
    .join('+');
}

/**
 * Что мешает сочетанию микрофона — проверяется при назначении, а не когда оно молча не сработало
 * (T27). Браузер не отдаёт странице свои сочетания; оболочка Windows регистрирует поверх других
 * программ только сочетания с Ctrl или Alt, без клавиши Windows и F12 (`MicrophoneHotkey.TryNative`);
 * плеер кинозала и покерный стол слушают голые буквы и пробел.
 */
export function hotkeyNotes(t: Translate, key: Hotkey, place: HotkeyPlace): HotkeyNote[] {
  const label = hotkeyLabel(t, key);
  if (key.alt && !key.ctrl && !key.meta && key.code === 'F4')
    return [{ level: 'blocked', text: t(($) => $.hotkeys.notes.altF4) }];
  if (place === 'browser' && BROWSER_RESERVED.has(signature(key)))
    return [{ level: 'blocked', text: t(($) => $.hotkeys.notes.browser, { label }) }];
  const notes: HotkeyNote[] = [];
  if (place === 'desktop') {
    const local = key.meta
      ? t(($) => $.hotkeys.notes.windowsKey)
      : key.code === 'F12'
        ? t(($) => $.hotkeys.notes.f12)
        : !key.ctrl && !key.alt
          ? t(($) => $.hotkeys.notes.noModifier)
          : null;
    if (local) notes.push({ level: 'warning', text: local });
  }
  const bare = !key.ctrl && !key.alt && !key.meta;
  const player = bare ? PLAYER_KEYS[key.code] : undefined;
  if (player)
    notes.push({
      level: 'warning',
      text: t(($) => $.hotkeys.notes.player, { label, action: t(($) => $.hotkeys.player[player]) }),
    });
  const poker = bare ? POKER_KEYS[key.code] : undefined;
  if (poker)
    notes.push({
      level: 'warning',
      text: t(($) => $.hotkeys.notes.poker, { label, action: t(($) => $.hotkeys.poker[poker]) }),
    });
  return notes;
}
