/**
 * Тема Telegram (`themeParams`) → токены E16 (`styles/tokens.css`).
 *
 * Mini App выглядит частью Telegram: фон, текст, поверхности и кнопки — цветами клиента человека.
 * Но токены Cord держат контраст WCAG 2.2 AA (`scripts/check-contrast.mjs`), а тема Telegram бывает
 * любой (свои темы чатов). Поэтому цвет Telegram берётся, только если с соседним он даёт 4,5:1, иначе
 * остаётся токен Cord. Сцена встречи (`--stage-*`) не трогается: видео — на тёмном в любой теме.
 *
 * Схема (`data-theme`) — по яркости фона Telegram: всё, чего тема не дала, берётся из светлой или
 * тёмной темы Cord, и смешения «светлый фон Telegram + тёмные поверхности Cord» не бывает.
 */
export type TelegramThemeKey =
  | 'bg_color'
  | 'secondary_bg_color'
  | 'section_bg_color'
  | 'text_color'
  | 'hint_color'
  | 'link_color'
  | 'accent_text_color'
  | 'button_color'
  | 'button_text_color'
  | 'destructive_text_color'
  | 'section_separator_color';
export type TelegramTheme = Partial<Record<TelegramThemeKey, string>>;

export interface CordTheme {
  scheme: 'light' | 'dark';
  /** CSS-переменные для `:root` — только те, что пришли от Telegram и прошли проверку. */
  vars: Record<string, string>;
  /** Цвет шапки, фона и нижней панели Telegram — фон страницы, чтобы шва не было. */
  background: string;
}

/** Фон загрузки `tg.html` и заставки BotFather — `--palette-ink-900`. */
export const BOOT_BACKGROUND = '#111419';
/** Порог AA для обычного текста. */
const AA = 4.5;

function hex(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return null;
}

/** Относительная яркость по WCAG 2.2. */
export function luminance(color: string): number {
  const channel = (offset: number) => {
    const c = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Текст Cord по умолчанию в каждой схеме (`--text`): с ним сверяются поверхности без своего текста. */
const CORD_TEXT = { light: '#1b1f27', dark: '#eef0f4' } as const;

export function cordTheme(params: TelegramTheme): CordTheme {
  const bg = hex(params.bg_color);
  if (!bg) return { scheme: 'dark', vars: {}, background: BOOT_BACKGROUND };
  const scheme = luminance(bg) < 0.18 ? 'dark' : 'light';
  const vars: Record<string, string> = { '--bg': bg, '--loader-bg': bg };
  const readable = (color: string | null, on: string) => (color && contrast(color, on) >= AA ? color : null);

  const text = readable(hex(params.text_color), bg);
  if (text) vars['--text'] = text;
  const ink = text ?? CORD_TEXT[scheme];
  // Поверхности: карточки и панели — «секция» Telegram, второй слой — его вторичный фон.
  const surface = readable(hex(params.section_bg_color) ?? hex(params.secondary_bg_color), ink);
  if (surface) vars['--surface-1'] = surface;
  const second = readable(hex(params.secondary_bg_color), ink);
  if (second) vars['--surface-2'] = second;
  const muted = readable(hex(params.hint_color), bg);
  if (muted) vars['--muted'] = muted;
  const accent = readable(hex(params.accent_text_color) ?? hex(params.link_color), bg);
  if (accent) vars['--accent'] = accent;
  const button = hex(params.button_color);
  const onButton = button ? readable(hex(params.button_text_color), button) : null;
  if (button && onButton) {
    vars['--accent-fill'] = button;
    vars['--accent-fill-hover'] = button;
    vars['--accent-fill-active'] = button;
    vars['--on-accent'] = onButton;
  }
  const danger = readable(hex(params.destructive_text_color), bg);
  if (danger) vars['--danger'] = danger;
  const line = hex(params.section_separator_color);
  if (line) vars['--line'] = line;
  return { scheme, vars, background: bg };
}

/** Применить к документу: схема, переменные, фон под страницей (видно при перетягивании). */
export function applyTheme(theme: CordTheme, root: HTMLElement = document.documentElement) {
  root.dataset.theme = theme.scheme;
  for (const [name, value] of Object.entries(theme.vars)) root.style.setProperty(name, value);
  // `tg.html` красит `html` и `body` тёмным до JS — оба и перекрашиваются.
  root.style.background = theme.background;
  if (root === document.documentElement) document.body.style.background = theme.background;
}
