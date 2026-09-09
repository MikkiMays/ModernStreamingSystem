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
export function hotkeyLabel(key: Hotkey | null) {
  if (!key) return 'Не назначено';
  return [
    key.ctrl && 'Ctrl',
    key.alt && 'Alt',
    key.shift && 'Shift',
    key.meta && 'Meta',
    key.code === 'Space' ? 'Пробел' : key.code.replace(/^(Key|Digit)/, ''),
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
