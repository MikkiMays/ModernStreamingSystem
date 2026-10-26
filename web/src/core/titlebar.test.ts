import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPTION_BUTTONS,
  captionHeight,
  pageZoom,
  titlebarArea,
  watchTitlebar,
  type TitlebarEnvironment,
  type WindowControlsOverlayLike,
} from './titlebar';

/** Зона кнопок окна, как её отдаёт Chromium: прямоугольник заголовка слева от «— ⧉ ×». */
function overlay(visible: boolean, rect = { x: 0, y: 0, width: 1142, height: 36 }) {
  const listeners = new Set<() => void>();
  const fake: { -readonly [K in keyof WindowControlsOverlayLike]: WindowControlsOverlayLike[K] } & {
    move(next: typeof rect, shown?: boolean): void;
  } = {
    visible,
    getTitlebarAreaRect: () => rect,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    move(next, shown = fake.visible) {
      rect = next;
      fake.visible = shown;
      listeners.forEach((listener) => listener());
    },
  };
  return fake;
}

/** Окно страницы: ширина, полный экран, масштаб и события «окно поменялось» — руками теста. */
function environment(
  options: Partial<{
    width: number;
    captionButtons: boolean;
    captionHeight: number;
    fullscreen: boolean;
    zoom: number;
  }> = {},
) {
  const state = {
    width: 1280,
    captionButtons: false,
    captionHeight: undefined as number | undefined,
    fullscreen: false,
    zoom: 1,
    ...options,
  };
  const listeners = new Set<() => void>();
  const env: TitlebarEnvironment & { set(next: Partial<typeof state>): void; listeners: Set<() => void> } = {
    viewport: () => state.width,
    get captionButtons() {
      return state.captionButtons;
    },
    get captionHeight() {
      return state.captionHeight;
    },
    fullscreen: () => state.fullscreen,
    zoom: () => state.zoom,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      Object.assign(state, next);
      listeners.forEach((listener) => listener());
    },
    listeners,
  };
  return env;
}

const root = document.documentElement;
const vars = () => [
  root.style.getPropertyValue('--titlebar-h'),
  root.style.getPropertyValue('--titlebar-end'),
];
/** Кнопки окна поверх страницы — шапки становятся заголовком окна (`data-titlebar`, R122). */
const titlebar = () => root.hasAttribute('data-titlebar');
afterEach(() => {
  root.style.removeProperty('--titlebar-h');
  root.style.removeProperty('--titlebar-end');
  root.removeAttribute('data-titlebar');
});

describe('кнопки окна Electron (R34)', () => {
  it('видимая зона: высота полосы и ширина кнопок справа — в переменные корня', () => {
    const stop = watchTitlebar(overlay(true), environment(), root);
    expect(vars()).toEqual(['36px', '138px']);
    stop();
  });

  it('окно поменяло размер или ушло во весь экран — переменные следуют, а снятые не остаются', () => {
    const wco = overlay(true);
    const env = environment();
    const stop = watchTitlebar(wco, env, root);
    env.set({ width: 1920 });
    wco.move({ x: 0, y: 0, width: 1782, height: 36 });
    expect(vars()).toEqual(['36px', '138px']);
    wco.move({ x: 0, y: 0, width: 0, height: 0 }, false);
    expect(vars()).toEqual(['', '']);
    stop();
  });

  it('браузер без зоны — ничего не пишет и не подписывается', () => {
    const env = environment();
    const stop = watchTitlebar(undefined, env, root);
    expect(vars()).toEqual(['', '']);
    expect(titlebar()).toBe(false);
    expect(env.listeners.size).toBe(0);
    stop();
  });

  it('отписка убирает и слушателей, и переменные', () => {
    const wco = overlay(true);
    const env = environment({ captionButtons: true });
    const stop = watchTitlebar(wco, env, root);
    stop();
    expect(vars()).toEqual(['', '']);
    expect(env.listeners.size).toBe(0);
    wco.move({ x: 0, y: 0, width: 100, height: 36 });
    expect(vars()).toEqual(['', '']);
  });
});

describe('кнопки окна клиента Windows не перекрывают шапку ни в каком состоянии окна (R122)', () => {
  it('развёрнутое окно: Chromium снял зону (visible = false), а «— ⧉ ×» нарисованы — нижняя граница', () => {
    const wco = overlay(false, { x: 0, y: 0, width: 0, height: 0 });
    const stop = watchTitlebar(wco, environment({ captionButtons: true }), root);
    expect(vars()).toEqual([`${CAPTION_BUTTONS.height}px`, `${CAPTION_BUTTONS.width}px`]);
    expect(titlebar()).toBe(true);
    stop();
    expect(titlebar()).toBe(false);
  });

  it('зона на всю ширину окна (правое поле 0) — всё равно не уже кнопок', () => {
    const wco = overlay(true, { x: 0, y: 0, width: 1280, height: 36 });
    const stop = watchTitlebar(wco, environment({ captionButtons: true }), root);
    expect(vars()).toEqual(['36px', `${CAPTION_BUTTONS.width}px`]);
    stop();
  });

  it('зона шире и выше нижней границы — верим зоне', () => {
    const wco = overlay(true, { x: 0, y: 0, width: 1100, height: 40 });
    const stop = watchTitlebar(wco, environment({ captionButtons: true }), root);
    expect(vars()).toEqual(['40px', '180px']);
    stop();
  });

  it('развернули без geometrychange — пересчёт по смене окна', () => {
    const wco = overlay(true);
    const env = environment({ captionButtons: true });
    const stop = watchTitlebar(wco, env, root);
    expect(vars()).toEqual(['36px', '138px']);
    // Окно развернули: зона в Chromium пропала молча, событие пришло только от окна.
    wco.visible = false;
    env.set({ width: 1920 });
    expect(vars()).toEqual(['36px', `${CAPTION_BUTTONS.width}px`]);
    stop();
  });

  it('во весь экран кнопок окна нет — и нижней границы нет', () => {
    const env = environment({ captionButtons: true, fullscreen: true });
    const stop = watchTitlebar(overlay(false, { x: 0, y: 0, width: 0, height: 0 }), env, root);
    expect(vars()).toEqual(['', '']);
    expect(titlebar()).toBe(false);
    env.set({ fullscreen: false });
    expect(vars()).toEqual(['36px', `${CAPTION_BUTTONS.width}px`]);
    expect(titlebar()).toBe(true);
    stop();
  });

  it('масштаб страницы: кнопки окна в DIP, поле — в CSS-пикселях страницы', () => {
    expect(titlebarArea(undefined, environment({ captionButtons: true, zoom: 0.8 }))).toEqual({
      height: 45,
      end: Math.ceil(CAPTION_BUTTONS.width / 0.8),
    });
    expect(titlebarArea(undefined, environment({ captionButtons: true, zoom: 1.25 }))).toEqual({
      height: 29,
      end: Math.ceil(CAPTION_BUTTONS.width / 1.25),
    });
  });

  it('масштаб узнаётся по окну, а рамки развёрнутого окна его не сбивают', () => {
    expect(pageZoom(1280, 1280)).toBe(1);
    expect(pageZoom(1936, 1920)).toBe(1);
    expect(pageZoom(1536, 1920)).toBeCloseTo(0.8, 2);
    expect(pageZoom(1600, 1280)).toBeCloseTo(1.25, 2);
    expect(pageZoom(0, 1280)).toBe(1);
  });
});

describe('высоту кнопок окна называет оболочка (1.0.10: 56 — по шапке встречи)', () => {
  it('зона пустая, оболочка сказала 56 — полоса 56, а не 36', () => {
    const wco = overlay(false, { x: 0, y: 0, width: 0, height: 0 });
    const stop = watchTitlebar(wco, environment({ captionButtons: true, captionHeight: 56 }), root);
    expect(vars()).toEqual(['56px', `${CAPTION_BUTTONS.width}px`]);
    stop();
  });

  it('оболочка до 1.0.10 высоту не называет — прежние 36', () => {
    const wco = overlay(false, { x: 0, y: 0, width: 0, height: 0 });
    const stop = watchTitlebar(wco, environment({ captionButtons: true }), root);
    expect(vars()).toEqual(['36px', `${CAPTION_BUTTONS.width}px`]);
    stop();
  });

  it('масштаб страницы 125 % — 56 DIP это 45 CSS-пикселей', () => {
    const wco = overlay(false, { x: 0, y: 0, width: 0, height: 0 });
    const stop = watchTitlebar(
      wco,
      environment({ captionButtons: true, captionHeight: 56, zoom: 1.25 }),
      root,
    );
    expect(vars()[0]).toBe('45px');
    stop();
  });
});

describe('captionHeight из моста', () => {
  it('берёт только разумное число', () => {
    expect(captionHeight({ bootstrap: { titlebarHeight: 56 } })).toBe(56);
    expect(captionHeight({ bootstrap: {} })).toBeUndefined();
    expect(captionHeight({ bootstrap: { titlebarHeight: 0 } })).toBeUndefined();
    expect(captionHeight({ bootstrap: { titlebarHeight: 500 } })).toBeUndefined();
    expect(captionHeight({ bootstrap: { titlebarHeight: '56' } })).toBeUndefined();
    expect(captionHeight(undefined)).toBeUndefined();
  });
});
