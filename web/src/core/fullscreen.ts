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
 * ВО ВКЛАДКЕ SAFARI НА IPHONE — РОДНОЙ ПЛЕЕР (R144, Р-41). Замена оставляет полосу адреса, и
 * владелец просил именно её убрать. Единственный путь к ней — `video.webkitEnterFullscreen()`: пульт
 * там системный, но пауза и пуск и так уходят в комнату (`onPlay`/`onPause`), а перемотку родного
 * пульта ловит `seeked` (с правом пульта — для всех). С экрана «Домой» (standalone) полосы адреса
 * нет вовсе — там своя замена и есть полный экран, и пульт остаётся наш.
 *
 * НА ТЕЛЕФОНЕ С ANDROID — ещё и поворот: кадр горизонтальный, а телефон держат вертикально
 * (`screen.orientation.lock('landscape')` в полном экране, отпуск на выходе; где нельзя — молча).
 */
let fallbackTarget: HTMLElement | null = null;
/** `<video>`, развёрнутый родным плеером iPhone (`webkitEnterFullscreen`). */
let nativeVideo: HTMLVideoElement | null = null;
/**
 * Что разворачивать по кнопке пульта встречи (R144): если на сцене фильм — его плеер, а не всю
 * встречу. Плеер регистрирует себя здесь, пока он на сцене; кнопок с разным смыслом больше нет.
 */
let stageToggle: (() => void) | null = null;
export function setStageFullscreen(toggle: (() => void) | null) {
  stageToggle = toggle;
}
export function stageFullscreen(): (() => void) | null {
  return stageToggle;
}
/** Какой `<video>` сейчас во весь экран родным плеером iPhone (его перемотку шлют в комнату). */
export function nativeFullscreenVideo(): HTMLVideoElement | null {
  return nativeVideo;
}

type IosVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
};
/** Открыт ли Cord с экрана «Домой»: там полосы адреса нет вовсе. */
function standalone(): boolean {
  return (
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}
/** Поворот в альбомную на телефоне в полном экране; где нельзя (компьютер, WebView) — молча. */
function lockLandscape(element: HTMLElement) {
  if (typeof matchMedia !== 'function' || !matchMedia('(pointer: coarse)').matches) return;
  const video = element instanceof HTMLVideoElement ? element : element.querySelector('video');
  if (video && video.videoWidth && video.videoWidth < video.videoHeight) return;
  const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
  void orientation?.lock?.('landscape').catch(() => {});
}
function unlockOrientation() {
  try {
    screen.orientation?.unlock?.();
  } catch {
    /* Не заперто — нечего отпускать. */
  }
}
const listeners = new Set<() => void>();
const mountedTargets = new Set<HTMLElement>();
const publish = () => listeners.forEach((listener) => listener());

export function fullscreenAvailable(): boolean {
  return typeof document !== 'undefined' && document.fullscreenEnabled === true;
}

function status(target: HTMLElement | null) {
  const nativeTarget = document.fullscreenElement;
  return {
    full: !!nativeTarget || !!fallbackTarget || !!nativeVideo,
    targetFull:
      !!target &&
      (nativeTarget === target ||
        fallbackTarget === target ||
        (!!nativeVideo && target.contains(nativeVideo))),
  };
}

/**
 * Состояние «развёрнуто» и переключатель к нему.
 *
 * Снаружи разницы между настоящим полным экраном и его заменой нет: один флаг, одна кнопка.
 * Внутри — `data-full` на самом элементе, по которому замена и раскладывается; у настоящего
 * полного экрана тот же атрибут ничего не меняет, потому что браузер уже всё сделал сам.
 */
export function useFullscreen(
  target: RefObject<HTMLElement | null>,
  /** Свой `<video>` внутри цели — для родного плеера iPhone во вкладке Safari (R144). */
  video?: RefObject<HTMLVideoElement | null>,
): {
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
    const orientation = () => {
      if (!document.fullscreenElement) unlockOrientation();
    };
    document.addEventListener('fullscreenchange', changed);
    document.addEventListener('fullscreenchange', orientation);
    return () => {
      listeners.delete(changed);
      document.removeEventListener('fullscreenchange', changed);
      document.removeEventListener('fullscreenchange', orientation);
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
      // iPhone во вкладке: родной плеер, если метаданные уже пришли; иначе — замена.
      const own = video?.current as IosVideo | null | undefined;
      if (
        own &&
        !standalone() &&
        typeof own.webkitEnterFullscreen === 'function' &&
        own.webkitSupportsFullscreen
      ) {
        const ended = () => {
          own.removeEventListener('webkitendfullscreen', ended);
          if (nativeVideo === own) nativeVideo = null;
          publish();
        };
        own.addEventListener('webkitendfullscreen', ended);
        try {
          own.webkitEnterFullscreen();
          nativeVideo = own;
          publish();
          return;
        } catch {
          own.removeEventListener('webkitendfullscreen', ended);
        }
      }
      fallbackTarget = element;
      publish();
      return;
    }
    // Одна цепочка на успех и отказ: вторая ветка `.then` без своего отказа всплывала бы наружу.
    void Promise.resolve(element.requestFullscreen({ navigationUI: 'hide' })).then(
      () => lockLandscape(element),
      () => {
        if (mountedTargets.has(element) && !document.fullscreenElement) {
          fallbackTarget = element;
          publish();
        }
      },
    );
  }, [target, video]);
  return { ...current, toggle };
}

/**
 * Свернуть полный экран, если развёрнуто что-то внутри `root` (R121): стол и плеер разворачиваются сами, и
 * уйти из такой интеграции к участникам значило бы оставить во весь экран спрятанный слой.
 */
export function exitFullscreenWithin(root: Element | null) {
  if (!root || typeof document === 'undefined') return;
  if (fallbackTarget && root.contains(fallbackTarget)) {
    fallbackTarget = null;
    publish();
  }
  const native = document.fullscreenElement;
  if (native && root.contains(native)) void document.exitFullscreen().catch(() => {});
}
