/**
 * Клавиши плеера кинозала (T20): что значит нажатие и почему иногда оно не делает ничего.
 *
 * Здесь только решение — чистая функция от нажатия и обстановки. Слушает клавиатуру и исполняет
 * решение `useWatchKeys`; так таблица клавиш проверяется без плеера, как правила пульта в
 * `watch-controls.ts`.
 *
 * ЧЬЯ КЛАВИША. Плеер берёт клавишу, только когда она адресована ему: фокус в самом плеере или нигде
 * (на странице). Фокус в чате, в панели или в поле ввода — клавиша не его: стрелка там листает список,
 * пробел печатает пробел. Открытый диалог и открытое меню плеера держат клавиши у себя (стрелки ходят
 * по пунктам, Esc закрывает). Ctrl, Alt и Meta плеер не трогает вовсе — это сочетания браузера и
 * системы.
 *
 * ОБЩЕЕ И СВОЁ. Пауза и перемотка — общие для комнаты (как кнопки пульта): только с правом на пульт и
 * не у эфира, иначе — подсказка, почему нет. Громкость, звук и полный экран — свои, их можно всем.
 */

/** Строки клавиш — в одном месте, до слоя переводов (E14). */
export const KEY_TEXT = {
  locked: 'Ведущий разрешил пульт только себе — пауза и перемотка у него',
  live: 'Эфир не ставят на паузу и не перематывают',
  micPause: (label: string) => `${label} включает микрофон — пауза на K`,
  micOther: (label: string) => `${label} включает микрофон — у плеера эта клавиша не работает`,
  seek: (deltaMs: number) => `${deltaMs > 0 ? '+' : '−'}${Math.round(Math.abs(deltaMs) / 1000)} с`,
  volume: (volume: number) => (volume <= 0 ? 'Звук выключен' : `Громкость ${volume} %`),
} as const;

/** Шаг перемотки стрелкой и стрелкой с Shift, миллисекунды. */
export const SEEK_MS = 10_000;
export const SEEK_LONG_MS = 30_000;
/** Шаг громкости стрелкой, проценты. */
export const VOLUME_STEP = 5;

/** Куда смотрит фокус: в поле ввода, на ползунок, на кнопку или никуда в особенности. */
export type FocusKind = 'text' | 'range' | 'button' | 'other';

/** Где фокус относительно плеера: внутри него, нигде (на странице) или в другом месте экрана. */
export type FocusPlace = 'theater' | 'page' | 'elsewhere';

export type WatchAction =
  | { type: 'toggle' }
  | { type: 'seek'; deltaMs: number }
  | { type: 'volume'; delta: number }
  | { type: 'mute' }
  | { type: 'fullscreen' };

/**
 * Решение: выполнить действие, показать подсказку вместо него — или клавиша не плеера (`null`).
 * `yield` у подсказки — клавишу уже взял кто-то другой (микрофон): её нельзя гасить.
 */
export type KeyVerdict = { action: WatchAction } | { hint: string; yield?: boolean } | null;

export interface KeyPress {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
}

export interface KeyContext {
  live: boolean;
  canControl: boolean;
  /** Длительность известна: перемотке есть куда вставать. */
  seekable: boolean;
  /** Открыто меню плеера (качество, звук, субтитры). */
  menuOpen: boolean;
  /** Открыт диалог поверх встречи. */
  dialog: boolean;
  place: FocusPlace;
  focus: FocusKind;
  /** Кнопка в фокусе с клавиатуры (`:focus-visible`), а не после нажатия мышью. */
  focusVisible: boolean;
  /** Это нажатие совпало с сочетанием микрофона (настройки) — им уже включают микрофон. */
  micHotkey: boolean;
  /** Как сочетание микрофона называется для глаз: «Пробел», «M». */
  micLabel: string;
}

/** Что делает клавиша сама по себе, без обстановки; `null` — не клавиша плеера. */
function intent(press: KeyPress): WatchAction | null {
  if (press.key === 'ArrowLeft' || press.key === 'ArrowRight') {
    const step = press.shiftKey ? SEEK_LONG_MS : SEEK_MS;
    return { type: 'seek', deltaMs: press.key === 'ArrowLeft' ? -step : step };
  }
  if (press.key === 'ArrowUp' || press.key === 'ArrowDown')
    return { type: 'volume', delta: press.key === 'ArrowUp' ? VOLUME_STEP : -VOLUME_STEP };
  // Буквы — по месту на клавиатуре (`code`), а не по символу: в русской раскладке K — это «л».
  if (press.code === 'Space' || press.key === ' ' || press.code === 'KeyK') return { type: 'toggle' };
  if (press.code === 'KeyM') return { type: 'mute' };
  if (press.code === 'KeyF') return { type: 'fullscreen' };
  return null;
}

/** Нажатие → решение плеера. */
export function watchKey(press: KeyPress, context: KeyContext): KeyVerdict {
  if (press.ctrlKey || press.altKey || press.metaKey || press.defaultPrevented) return null;
  if (context.dialog || context.menuOpen || context.place === 'elsewhere') return null;
  if (context.focus === 'text') return null;
  const action = intent(press);
  if (!action) return null;
  const arrow = action.type === 'seek' || action.type === 'volume';
  // Ползунок (лента, громкость) стрелками двигается сам — это его клавиши.
  if (arrow && context.focus === 'range') return null;
  // Пробел на кнопке, до которой дошли с клавиатуры, — нажатие этой кнопки, как везде.
  if (press.code === 'Space' && context.focus === 'button' && context.focusVisible) return null;
  // Держат стрелку — перемотка и громкость идут дальше; паузу и полный экран удержание не дёргает.
  if (press.repeat && !arrow) return null;
  if (context.micHotkey)
    return {
      hint:
        action.type === 'toggle' ? KEY_TEXT.micPause(context.micLabel) : KEY_TEXT.micOther(context.micLabel),
      yield: true,
    };
  if (action.type === 'toggle' || action.type === 'seek') {
    if (context.live) return { hint: KEY_TEXT.live };
    if (!context.canControl) return { hint: KEY_TEXT.locked };
    if (action.type === 'seek' && !context.seekable) return null;
  }
  return { action };
}

/** Куда смотрит фокус: поле ввода, ползунок, кнопка или ничего особенного. */
export function focusKind(target: EventTarget | null): FocusKind {
  if (!(target instanceof HTMLElement)) return 'other';
  if (target.closest('textarea, select, [contenteditable="true"], [data-hotkey-recorder]')) return 'text';
  const input = target.closest('input');
  if (input) {
    if (input.type === 'range') return 'range';
    return ['checkbox', 'radio', 'button', 'submit', 'reset'].includes(input.type) ? 'button' : 'text';
  }
  if (target.closest('button, a[href], [role="button"], [role="menuitem"], [role="tab"]')) return 'button';
  return 'other';
}

/** Громкость после шага стрелкой: от 0 до 100. */
export function volumeAfter(volume: number, delta: number): number {
  return Math.max(0, Math.min(100, Math.round(volume + delta)));
}

/**
 * «Без звука» и обратно. Возвращается та громкость, что была до «без звука» (`loudness`), но не
 * тише восьми процентов — иначе «включить звук» включало бы шёпот.
 */
export function muteToggle(volume: number, loudness: number): { volume: number; loudness: number } {
  if (volume > 0) return { volume: 0, loudness: volume };
  return { volume: Math.max(8, loudness || 70), loudness };
}
