import { useCallback, useEffect, useState, type RefObject } from 'react';

/**
 * Полный экран там, где он есть, и его замена там, где его нет.
 *
 * ПОЧЕМУ ЗАМЕНА. На iPhone полноэкранного режима для обычных элементов нет вовсе: Safari (а
 * значит, и всякий браузер на этом телефоне) умеет разворачивать только собственный плеер
 * `<video>` и ничего больше. `requestFullscreen` там либо отсутствует, либо отказывает — и
 * кнопка «развернуть» превращалась в кнопку, которая не делает ничего. Со стороны это и
 * читается как «полноэкранный режим недоступен».
 *
 * Разворачивать средствами самого телефона нечего, но то, ради чего кнопку и нажимают —
 * кадр во весь экран без чужих полей, — достижимо и без него: элемент раскладывается на всё
 * окно поверх страницы. Полоса адреса браузера при этом остаётся; убрать её со страницы
 * нельзя ничем, и обещать этого не стоит.
 *
 * Разворачивать **свой** плеер, а не `<video>`, важно: родной полный экран телефона рисует
 * собственные кнопки и собственные субтитры, а у нас и те, и другие свои — общая пауза на
 * всю комнату и дорожка текста, которую мы рисуем сами.
 */
let fallbackTarget: HTMLElement | null = null;
const listeners = new Set<() => void>();
const mountedTargets = new Set<HTMLElement>();
const publish = () => listeners.forEach((listener) => listener());

export function fullscreenAvailable(): boolean {
  return typeof document !== 'undefined' && document.fullscreenEnabled === true;
}

function status(target: HTMLElement | null) {
  const nativeTarget = document.fullscreenElement;
  return {
    full: !!nativeTarget || !!fallbackTarget,
    targetFull: !!target && (nativeTarget === target || fallbackTarget === target),
  };
}

/**
 * Состояние «развёрнуто» и переключатель к нему.
 *
 * Снаружи разницы между настоящим полным экраном и его заменой нет: один флаг, одна кнопка.
 * Внутри — `data-full` на самом элементе, по которому замена и раскладывается; у настоящего
 * полного экрана тот же атрибут ничего не меняет, потому что браузер уже всё сделал сам.
 */
export function useFullscreen(target: RefObject<HTMLElement | null>): {
  full: boolean;
  targetFull: boolean;
  toggle: () => void;
} {
  const [current, setCurrent] = useState(() => status(null));
  useEffect(() => {
    const element = target.current;
    const changed = () => setCurrent(status(element));
    changed();
    if (element) mountedTargets.add(element);
    listeners.add(changed);
    document.addEventListener('fullscreenchange', changed);
    return () => {
      listeners.delete(changed);
      document.removeEventListener('fullscreenchange', changed);
      if (element) mountedTargets.delete(element);
      if (fallbackTarget === element) {
        fallbackTarget = null;
        publish();
      }
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
    };
  }, [target]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !fallbackTarget) return;
      fallbackTarget = null;
      publish();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  const toggle = useCallback(() => {
    const element = target.current;
    if (!element) return;
    if (fallbackTarget) {
      fallbackTarget = null;
      publish();
      return;
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (!fullscreenAvailable()) {
      fallbackTarget = element;
      publish();
      return;
    }
    void element.requestFullscreen().catch(() => {
      if (mountedTargets.has(element) && !document.fullscreenElement) {
        fallbackTarget = element;
        publish();
      }
    });
  }, [target]);
  return { ...current, toggle };
}
