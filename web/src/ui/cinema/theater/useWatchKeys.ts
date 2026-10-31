import { useEffect, useRef, type RefObject } from 'react';
import { hotkeyLabel, matchesHotkey, type Hotkey } from '../../../core/hotkeys';
import { t } from '../../../i18n';
import { focusKind, watchKey, type FocusPlace, type KeyContext, type WatchAction } from './watch-keys';
import { modalOpen } from '../../modal';

/** Фокус нигде: на самой странице, а не на каком-то её элементе. */
function onPage(target: EventTarget | null): boolean {
  return (
    target === null ||
    target === window ||
    target === document ||
    target === document.body ||
    target === document.documentElement
  );
}

/** `:focus-visible` знают не все движки (в тестах его может не быть) — тогда «не видно». */
function focusVisible(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  try {
    return target.matches(':focus-visible');
  } catch {
    return false;
  }
}

/**
 * Клавиатура плеера (T20): слушает окно, пока плеер открыт, и исполняет решение `watchKey`.
 *
 * Слушает окно, а не сам плеер: после нажатия по кадру фокус уходит на страницу (`<video>` фокуса не
 * берёт), и пробел, нажатый «по фильму», пришёл бы мимо плеера. Чья клавиша — решает `watchKey` по
 * тому, где фокус: в плеере, нигде или в другом месте экрана (тогда клавиша не его).
 *
 * Микрофон: обработчик встречи (`MeetingView`) слушает то же окно. Если сочетание микрофона совпало с
 * клавишей плеера, клавиша — микрофона: плеер её не гасит и только показывает подсказку.
 */
export function useWatchKeys({
  screen,
  context,
  micHotkey,
  onAction,
  onHint,
  wake,
  disabled = false,
}: {
  /** Плеер целиком: фокус внутри него — клавиша плеера. */
  screen: RefObject<HTMLElement | null>;
  context: Pick<KeyContext, 'live' | 'canControl' | 'seekable' | 'menuOpen'>;
  micHotkey: Hotkey | null | undefined;
  onAction: (action: WatchAction) => void;
  onHint: (text: string) => void;
  /** Нажатие — тоже движение: пульт возвращается (T19). */
  wake: () => void;
  /**
   * Плеер спрятан: зритель ушёл к участникам (R121). Фильм идёт, но клавиши — не его: пробел, нажатый
   * над сеткой, не должен ставить паузу всей комнате.
   */
  disabled?: boolean;
}) {
  const latest = useRef({ context, micHotkey, onAction, onHint, wake, disabled });
  useEffect(() => {
    latest.current = { context, micHotkey, onAction, onHint, wake, disabled };
  });
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      const section = screen.current;
      if (!section) return;
      const now = latest.current;
      if (now.disabled) return;
      const target = event.target;
      const place: FocusPlace =
        target instanceof Node && section.contains(target)
          ? 'theater'
          : onPage(target)
            ? 'page'
            : 'elsewhere';
      const mic = now.micHotkey ?? null;
      const verdict = watchKey(event, {
        ...now.context,
        dialog: modalOpen(),
        place,
        focus: focusKind(target),
        focusVisible: focusVisible(target),
        micHotkey: !!matchesHotkey(event, mic),
        micLabel: hotkeyLabel(t, mic),
      });
      if (!verdict) return;
      now.wake();
      if ('action' in verdict) {
        event.preventDefault();
        now.onAction(verdict.action);
        return;
      }
      if (!verdict.yield) event.preventDefault();
      now.onHint(verdict.hint);
    };
    window.addEventListener('keydown', listen);
    return () => window.removeEventListener('keydown', listen);
  }, [screen]);
}
