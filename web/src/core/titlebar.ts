/**
 * Кнопки окна клиента Windows (R34, R122).
 *
 * Оболочка на Electron прячет системный заголовок (`titleBarStyle: 'hidden'`) и просит Windows
 * нарисовать «— ⧉ ×» поверх страницы (`titleBarOverlay`). Chromium называет эту зону Window Controls
 * Overlay: CSS получает её через `env(titlebar-area-*)` (`styles/tokens.css`), скрипт — через
 * `navigator.windowControlsOverlay`. Здесь те же `--titlebar-h` и `--titlebar-end` пишутся на `<html>`.
 *
 * R122: в развёрнутом окне клиента 1.0.8 (Electron 44.9) кнопки окна лежали прямо на звезде, ссылке и
 * гарнитуре шапки — зона пришла пустой или во всю ширину, и правое поле стало нулём, хотя «— ⧉ ×»
 * нарисованы (фото владельца: «☐» — поле есть, «⧉» — поля нет). С Electron 44.4 зона доходит до
 * страницы новым путём (`WebContentsView::SendWindowControlsOverlay`: перевод в координаты вида и
 * обрезка по его границам, electron#53811), и этот путь уже ломал окна с `titleBarOverlay`
 * (electron#54025). Поэтому в клиенте Windows зона из Chromium — не единственный источник: пока
 * окно не во весь экран, кнопки окна там нарисованы всегда, и поле не бывает уже их самих
 * (`CAPTION_BUTTONS` — нижняя граница). Пересчёт — и по `geometrychange`, и по смене размера окна:
 * развёртывание событием зоны может не прийти. Во весь экран кнопок нет — переменные снимаются.
 */
export interface WindowControlsOverlayLike {
  readonly visible: boolean;
  getTitlebarAreaRect(): { x: number; y: number; width: number; height: number };
  addEventListener(type: 'geometrychange', listener: () => void): void;
  removeEventListener(type: 'geometrychange', listener: () => void): void;
}

/**
 * Кнопки «— ⧉ ×» Electron в DIP: три по 45 и зазор 1 между ними (`WinCaptionButton`,
 * `WindowFrameUtil::kWindowsCaptionButtonWidth`), высота — `titleBarOverlay.height` оболочки
 * (`desktop/src/main/windows/main.ts`). 36 — у оболочек до 1.0.10; с 1.0.10 оболочка называет свою
 * высоту сама (`bootstrap.titlebarHeight`, 56 — по шапке встречи).
 */
export const CAPTION_BUTTONS = { width: 137, height: 36 } as const;

/** Что знает страница об окне, в котором её показывают. */
export interface TitlebarEnvironment {
  /** Ширина окна страницы в CSS-пикселях. */
  viewport(): number;
  /** Кнопки окна нарисованы поверх страницы, пока она не во весь экран (клиент Windows на Electron). */
  readonly captionButtons: boolean;
  /** Высота кнопок окна в DIP, если оболочка её назвала; иначе — `CAPTION_BUTTONS.height`. */
  readonly captionHeight?: number;
  /** Страница во весь экран — кнопок окна нет. */
  fullscreen(): boolean;
  /** Масштаб страницы: сколько DIP в одном CSS-пикселе (Ctrl + плюс/минус в клиенте). */
  zoom(): number;
  /** Окно сменило размер или ушло во весь экран и обратно. */
  subscribe(listener: () => void): () => void;
}

/**
 * Масштаб страницы по окну: `outerWidth` — в DIP, `innerWidth` — в CSS-пикселях. Рамки развёрнутого
 * окна (до 2 × 8 DIP невидимой рамки) масштабом не считаются: меньше 3 % — это 100 %.
 */
export function pageZoom(outer: number, inner: number): number {
  if (!(outer > 0) || !(inner > 0)) return 1;
  const ratio = outer / inner;
  return Math.abs(ratio - 1) < 0.03 ? 1 : ratio;
}

/** Высота полосы кнопок и ширина их колонки справа — в CSS-пикселях; `null` — кнопок нет. */
export function titlebarArea(
  overlay: WindowControlsOverlayLike | undefined,
  env: TitlebarEnvironment,
): { height: number; end: number } | null {
  if (env.captionButtons && env.fullscreen()) return null;
  let reported: { height: number; end: number } | null = null;
  if (overlay?.visible) {
    const rect = overlay.getTitlebarAreaRect();
    if (rect.height > 0)
      reported = {
        height: Math.round(rect.height),
        end: Math.max(0, Math.round(env.viewport() - rect.x - rect.width)),
      };
  }
  if (!env.captionButtons) return reported;
  const zoom = env.zoom() > 0 ? env.zoom() : 1;
  return {
    height: Math.max(reported?.height ?? 0, Math.ceil((env.captionHeight ?? CAPTION_BUTTONS.height) / zoom)),
    end: Math.max(reported?.end ?? 0, Math.ceil(CAPTION_BUTTONS.width / zoom)),
  };
}

function current(): WindowControlsOverlayLike | undefined {
  return (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike })
    .windowControlsOverlay;
}

/** Клиент Windows на Electron: мост v2 и Windows в строке браузера. WinUI (v1) рисует заголовок сам. */
function electronOnWindows(): boolean {
  const bridge = (window as Window & { cordDesktop?: { protocol?: { major?: number } } }).cordDesktop;
  return bridge?.protocol?.major === 2 && /Windows/i.test(navigator.userAgent);
}

/** Высота кнопок окна из моста оболочки (`bootstrap.titlebarHeight`, с 1.0.10) — только разумное число. */
export function captionHeight(
  bridge: { bootstrap?: { titlebarHeight?: unknown } } | undefined,
): number | undefined {
  const value = bridge?.bootstrap?.titlebarHeight;
  return typeof value === 'number' && value >= 24 && value <= 96 ? value : undefined;
}

/** Окно браузера, в котором открыта страница. */
export function browserEnvironment(): TitlebarEnvironment {
  return {
    viewport: () => window.innerWidth,
    captionButtons: electronOnWindows(),
    captionHeight: captionHeight(
      (window as Window & { cordDesktop?: { bootstrap?: { titlebarHeight?: unknown } } }).cordDesktop,
    ),
    fullscreen: () =>
      !!document.fullscreenElement ||
      (typeof matchMedia === 'function' && matchMedia('(display-mode: fullscreen)').matches),
    zoom: () => pageZoom(window.outerWidth, window.innerWidth),
    subscribe(listener) {
      window.addEventListener('resize', listener);
      document.addEventListener('fullscreenchange', listener);
      return () => {
        window.removeEventListener('resize', listener);
        document.removeEventListener('fullscreenchange', listener);
      };
    },
  };
}

export function watchTitlebar(
  overlay: WindowControlsOverlayLike | undefined = current(),
  env: TitlebarEnvironment = browserEnvironment(),
  root: HTMLElement = document.documentElement,
): () => void {
  const clear = () => {
    root.style.removeProperty('--titlebar-h');
    root.style.removeProperty('--titlebar-end');
    root.removeAttribute('data-titlebar');
  };
  if (!overlay && !env.captionButtons) return () => {};
  const apply = () => {
    const area = titlebarArea(overlay, env);
    if (!area) {
      clear();
      return;
    }
    root.style.setProperty('--titlebar-h', `${area.height}px`);
    root.style.setProperty('--titlebar-end', `${area.end}px`);
    // Кнопки окна поверх страницы: шапка предвхода — той же высоты, что шапка встречи (`prejoin.css`).
    root.setAttribute('data-titlebar', '');
  };
  apply();
  overlay?.addEventListener('geometrychange', apply);
  const unsubscribe = env.subscribe(apply);
  return () => {
    overlay?.removeEventListener('geometrychange', apply);
    unsubscribe();
    clear();
  };
}
