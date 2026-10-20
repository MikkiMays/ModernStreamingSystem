import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import tokens from '../styles/tokens.css?raw';
import { BOOT_BACKGROUND } from './theme';

/**
 * `tg.html` — второй HTML-вход (Mini App Telegram). Сцена загрузки у него та же, что у `index.html`
 * (её сверяет с React `ui/loader/loader.test.ts`), но всегда тёмная: заставка BotFather одна на обе
 * темы. Разойтись с `index.html` им нельзя — сверяется здесь.
 */
const read = (name: string) => readFileSync(join(process.cwd(), name), 'utf8');
const tg = read('tg.html');
const index = read('index.html');
const boot = (html: string) =>
  (/<div id="cord-boot"[\s\S]*?(?=<div id="root")/.exec(html)?.[0] ?? '').replace(/aria-label="[^"]*"/, '');
const style = (html: string) => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
const rules = (css: string) =>
  Object.fromEntries(
    [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [
      selector!.trim(),
      body!.replace(/\s+/g, ' ').trim(),
    ]),
  );

describe('tg.html — вход Mini App', () => {
  it('скрипт — только модуль входа Telegram, встроенного нет (CSP)', () => {
    expect(tg.match(/<script(?![^>]*type="module")/g)).toBeNull();
    expect(tg).toMatch(/<script type="module" src="\/src\/telegram\/main.tsx">/);
    expect(tg).not.toContain('telegram.org');
  });

  it('разметка загрузки — та же, что в index.html', () => {
    expect(boot(tg)).not.toBe('');
    expect(boot(tg)).toBe(boot(index));
  });

  it('сцена и кадры — те же, что в index.html', () => {
    const ours = rules(style(tg));
    const theirs = rules(style(index));
    for (const selector of [
      '.fl__fade',
      '.fl__stage',
      '.fl__scene',
      '.fl__shadow',
      '.fl-cord__plate',
      '.fl-cord__bar',
    ])
      expect(ours[selector], selector).toEqual(theirs[selector]);
    for (const name of ['fl-in', 'fl-sway', 'fl-breathe', 'fl-bob'])
      expect(style(tg)).toContain(`@keyframes ${name}`);
  });

  it('фон до JS — всегда тёмный токен, без светлой темы (белой вспышки нет)', () => {
    const ink = /--palette-ink-900:\s*(#[0-9a-f]{6})/.exec(tokens)?.[1];
    expect(ink).toBe(BOOT_BACKGROUND);
    expect(style(tg)).toMatch(new RegExp(`html,\\s*body\\s*\\{\\s*background: ${BOOT_BACKGROUND};`));
    expect(style(tg)).not.toContain('prefers-color-scheme');
    expect(style(tg)).not.toContain('#f6f7fa');
    expect(tg).toContain('<meta name="color-scheme" content="dark" />');
  });
});
