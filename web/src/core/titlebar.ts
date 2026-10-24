/**
 * Кнопки окна клиента Windows (R34).
 *
 * Оболочка на Electron прячет системный заголовок (`titleBarStyle: 'hidden'`) и просит Windows
 * нарисовать «— ⧉ ×» поверх страницы (`titleBarOverlay`). Chromium называет эту зону Window Controls
 * Overlay: CSS получает её через `env(titlebar-area-*)` (`styles/tokens.css`), скрипт — через
 * `navigator.windowControlsOverlay`. Здесь — запасной путь: те же `--titlebar-h` и `--titlebar-end`
 * пишутся на `<html>` из прямоугольника зоны, если `env()` почему-то пуст. Скрытая зона (во весь
 * экран) снимает переменные — тогда действуют нули из токенов.
 */
export interface WindowControlsOverlayLike {
  readonly visible: boolean;
  getTitlebarAreaRect(): { x: number; y: number; width: number; height: number };
  addEventListener(type: 'geometrychange', listener: () => void): void;
  removeEventListener(type: 'geometrychange', listener: () => void): void;
}

function current(): WindowControlsOverlayLike | undefined {
  return (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike })
    .windowControlsOverlay;
}

export function watchTitlebar(
  overlay: WindowControlsOverlayLike | undefined = current(),
  viewport: number | (() => number) = () => window.innerWidth,
  root: HTMLElement = document.documentElement,
): () => void {
  const clear = () => {
    root.style.removeProperty('--titlebar-h');
    root.style.removeProperty('--titlebar-end');
  };
  if (!overlay) return () => {};
  const apply = () => {
    const rect = overlay.getTitlebarAreaRect();
    if (!overlay.visible || rect.height <= 0) {
      clear();
      return;
    }
    const width = typeof viewport === 'function' ? viewport() : viewport;
    root.style.setProperty('--titlebar-h', `${Math.round(rect.height)}px`);
    root.style.setProperty('--titlebar-end', `${Math.max(0, Math.round(width - rect.x - rect.width))}px`);
  };
  apply();
  overlay.addEventListener('geometrychange', apply);
  return () => {
    overlay.removeEventListener('geometrychange', apply);
    clear();
  };
}
