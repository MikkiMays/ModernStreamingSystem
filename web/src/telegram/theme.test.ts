import { describe, expect, it } from 'vitest';
import { applyTheme, BOOT_BACKGROUND, contrast, cordTheme } from './theme';

// Темы Telegram по умолчанию (Android, 2026): ночная и дневная — как их присылает `themeParams`.
const NIGHT = {
  bg_color: '#212d3b',
  secondary_bg_color: '#151e27',
  section_bg_color: '#1d2733',
  text_color: '#ffffff',
  hint_color: '#7d8b99',
  link_color: '#5eabe1',
  accent_text_color: '#64b5ef',
  button_color: '#2481cc',
  button_text_color: '#ffffff',
  destructive_text_color: '#ee686f',
  section_separator_color: '#0d1620',
};
const DAY = {
  bg_color: '#ffffff',
  secondary_bg_color: '#f0f0f0',
  text_color: '#000000',
  hint_color: '#707579',
  link_color: '#3390ec',
  button_color: '#3390ec',
  button_text_color: '#ffffff',
};

describe('тема Telegram → токены E16', () => {
  it('ночная тема Telegram — тёмная схема Cord с цветами Telegram', () => {
    const theme = cordTheme(NIGHT);
    expect(theme.scheme).toBe('dark');
    expect(theme.background).toBe('#212d3b');
    expect(theme.vars).toMatchObject({
      '--bg': '#212d3b',
      '--loader-bg': '#212d3b',
      '--text': '#ffffff',
      '--surface-1': '#1d2733',
      '--surface-2': '#151e27',
      '--accent': '#64b5ef',
      '--danger': '#ee686f',
      '--line': '#0d1620',
    });
  });

  it('дневная — светлая схема; цвет без контраста AA остаётся токеном Cord', () => {
    const theme = cordTheme(DAY);
    expect(theme.scheme).toBe('light');
    expect(theme.vars['--text']).toBe('#000000');
    // Подсказка #707579 на белом — 4,6:1, проходит; ссылка #3390ec — 3,6:1, нет.
    expect(theme.vars['--muted']).toBe('#707579');
    expect(theme.vars['--accent']).toBeUndefined();
    // Белый текст на кнопке #3390ec — 3,6:1: кнопки остаются синими Cord.
    expect(theme.vars['--accent-fill']).toBeUndefined();
    expect(theme.vars['--on-accent']).toBeUndefined();
  });

  it('каждый принятый цвет текста читается на своём фоне (4,5:1)', () => {
    for (const params of [NIGHT, DAY]) {
      const { vars } = cordTheme(params);
      for (const name of ['--text', '--muted', '--accent', '--danger'] as const)
        if (vars[name]) expect(contrast(vars[name], vars['--bg']!), name).toBeGreaterThanOrEqual(4.5);
      if (vars['--on-accent'])
        expect(contrast(vars['--on-accent'], vars['--accent-fill']!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('без фона или с мусором — тёмная тема Cord и цвет загрузки', () => {
    expect(cordTheme({})).toEqual({ scheme: 'dark', vars: {}, background: BOOT_BACKGROUND });
    expect(cordTheme({ bg_color: 'red', text_color: '#fff' }).vars).toEqual({});
    expect(cordTheme({ bg_color: '#FFF', text_color: '#000' }).vars['--bg']).toBe('#ffffff');
    expect(cordTheme({ bg_color: '#fff', text_color: 'url(x)' }).vars['--text']).toBeUndefined();
  });

  it('применяется к документу: схема, переменные, фон под страницей', () => {
    const root = document.createElement('div');
    applyTheme(cordTheme(NIGHT), root);
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.getPropertyValue('--bg')).toBe('#212d3b');
    expect(root.style.background).toBe('rgb(33, 45, 59)');
  });
});
