import type { CSSProperties } from 'react';

/**
 * Цвета интеграций — один реестр на всё приложение (R33, DESIGN.md → «Цвета интеграций»).
 *
 * Владелец: «везде все интеграции отрисовать по цветам». Раньше цвета жили в трёх реестрах (кинозал,
 * музыка, игры) и расходились между собой (YouTube `#e33b3b` во вкладке и `#ff3d3d` на плитке), а
 * витрина, аккаунты и плеер были синими, цветом приложения. Теперь у каждой площадки, игры и категории
 * — одна запись: заливка плашки значка (`color`), знак на ней (`ink` — тёмный на светлых заливках:
 * жёлтом Яндекса, золотом дурака) и цвет текста бренда на поверхности светлой и тёмной темы (`text`).
 *
 * Значения повторены в `styles/tokens.css` (`--palette-brand-<id>…` и `--brand-<id>`, `-ink`, `-text`):
 * CSS берёт цвет переменной, а этот файл — источник для проверок. Их совпадение и контраст держит
 * `brands.test.ts`, белую подпись на затемнённом цвете вкладок — `scripts/check-contrast.mjs`
 * (`BRAND` собирается отсюда же).
 *
 * Цвет бренда красит только интеграцию — плашку значка, полосу и кнопку плеера, выбранную вкладку
 * площадки, — но никогда не кнопки самого приложения: они остаются цветом Cord.
 */
export type BrandId =
  | 'youtube'
  | 'soundcloud'
  | 'yandex'
  | 'twitch'
  | 'rutube'
  | 'vk'
  | 'ivi'
  | 'link'
  | 'telegram'
  | 'cinema'
  | 'music'
  | 'games'
  | 'poker'
  | 'durak'
  | 'chess'
  | 'gartic';

export interface Brand {
  /** Заливка плашки значка и полосы. */
  color: string;
  /** Знак на заливке: значку хватает 3:1. */
  ink: string;
  /** Текст цветом бренда на `--surface-1` светлой и тёмной темы: не меньше 4,5:1. */
  text: { light: string; dark: string };
}

const WHITE = '#ffffff';
const DARK = '#1b1f27';

export const BRANDS: Record<BrandId, Brand> = {
  youtube: { color: '#ff3d3d', ink: WHITE, text: { light: '#c81e1e', dark: '#ff6b6b' } },
  soundcloud: { color: '#ff5500', ink: WHITE, text: { light: '#b63c00', dark: '#ff8a4d' } },
  yandex: { color: '#ffcc00', ink: DARK, text: { light: '#7a5d00', dark: '#ffd633' } },
  twitch: { color: '#9147ff', ink: WHITE, text: { light: '#6f2fd6', dark: '#b48aff' } },
  rutube: { color: '#1c80e3', ink: WHITE, text: { light: '#1a66b8', dark: '#5aa8ff' } },
  vk: { color: '#0077ff', ink: WHITE, text: { light: '#0a5fd1', dark: '#4f9dff' } },
  ivi: { color: '#ea003d', ink: WHITE, text: { light: '#bf0030', dark: '#ff5c84' } },
  // «По ссылке» — не площадка, а дверь для любой страницы: нейтральный серый, а не чужой бренд.
  link: { color: '#6b7585', ink: WHITE, text: { light: '#4d5566', dark: '#b3bbc9' } },
  telegram: { color: '#1b8ad0', ink: WHITE, text: { light: '#0f7bb3', dark: '#6cc7f6' } },
  // Категории витрины: кинозал, музыка (и свои файлы — это вход музыки, а не чужая площадка), игры.
  cinema: { color: '#0f97ab', ink: WHITE, text: { light: '#0e7a8a', dark: '#4fd0e2' } },
  music: { color: '#2b9459', ink: WHITE, text: { light: '#1f7a47', dark: '#4fd48a' } },
  games: { color: '#8a5cf6', ink: WHITE, text: { light: '#6a3fd0', dark: '#b59bff' } },
  poker: { color: '#8a5cf6', ink: WHITE, text: { light: '#6a3fd0', dark: '#b59bff' } },
  durak: { color: '#c9a227', ink: DARK, text: { light: '#7a5d00', dark: '#e3c04f' } },
  chess: { color: '#5271a3', ink: WHITE, text: { light: '#3f5a87', dark: '#9db4dc' } },
  gartic: { color: '#8d65c5', ink: WHITE, text: { light: '#6a45a3', dark: '#bca6ff' } },
};

export const BRAND_IDS = Object.keys(BRANDS) as BrandId[];

/** Заливка бренда для CSS — переменной темы, а не самим цветом: так её меняет один `tokens.css`. */
export function brandColor(id: BrandId): string {
  return `var(--brand-${id})`;
}

/**
 * Бренд для CSS разметки: `--platform` (заливка), `--platform-ink` (знак на ней), `--platform-text`
 * (текст цветом бренда). Им красятся плитка и вкладка площадки, плашки витрины, аккаунтов и чипов,
 * полоса и кнопка плеера — каждое место берёт нужную из трёх переменных.
 */
export function paint(id: BrandId): CSSProperties {
  return {
    '--platform': `var(--brand-${id})`,
    '--platform-ink': `var(--brand-${id}-ink)`,
    '--platform-text': `var(--brand-${id}-text)`,
  } as CSSProperties;
}
