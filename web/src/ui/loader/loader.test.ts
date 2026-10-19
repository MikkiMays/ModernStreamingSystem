import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { theme } from '../../../scripts/check-contrast.mjs';
import tokens from '../../styles/tokens.css?raw';
import loader from './loader.css?raw';

/**
 * Сцена загрузки живёт дважды: в `index.html` до JS (литералы) и в `loader.css` (токены).
 * Разойтись им нельзя — кадры, цвета и разметка сверяются здесь, а не глазами.
 */
// vitest запускается из `web/`; `import.meta.url` в его воркере — не file:, поэтому путь от cwd.
const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
const inline = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';

const keyframes = (css: string) =>
  Object.fromEntries(
    [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\s*\}\n/g)].map(([, name, body]) => [
      name,
      body!.replace(/\s+/g, ' ').trim(),
    ]),
  );

describe('загрузка до JS', () => {
  it('в index.html нет встроенного скрипта: CSP разрешает только стиль', () => {
    expect(html.match(/<script(?![^>]*type="module")/g)).toBeNull();
    expect(html).toMatch(/<script type="module" src="\/src\/main.tsx">/);
  });

  it('фон страницы задан до JS в обеих темах и равен токенам', () => {
    const light = theme(tokens, 'light');
    const dark = theme(tokens, 'dark');
    expect(inline).toContain(`html {\n        background: ${light['--palette-mist-50']};`);
    expect(inline).toContain(`background: ${dark['--palette-ink-900']};`);
    expect(inline).toContain(`--fl-accent: ${light['--palette-blue-500']};`);
    expect(html).toContain(`content="${light['--palette-mist-50']}"`);
    expect(html).toContain(`content="${dark['--palette-ink-900']}"`);
  });

  it('кадры сцены марки в index.html и loader.css совпадают', () => {
    const boot = keyframes(inline);
    const react = keyframes(loader);
    for (const name of ['fl-in', 'fl-sway', 'fl-breathe', 'fl-bob'])
      expect(boot[name], name).toEqual(react[name]);
  });

  it('геометрия сцены одна и та же', () => {
    // Первое объявление селектора: в обоих файлах оно вне @media.
    const rule = (css: string, selector: string) =>
      [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(([, sel]) => sel?.trim() === selector)
        .map(([, , body]) => body!.replace(/\s+/g, ' ').trim())[0];
    for (const selector of [
      '.fl__fade',
      '.fl__stage',
      '.fl__scene',
      '.fl__shadow',
      '.fl-cord__plate',
      '.fl-cord__bar',
    ])
      expect(rule(inline, selector), selector).toEqual(rule(loader, selector));
  });

  it('разметка сцены марки в index.html — та же, что рисует React', () => {
    expect(html).toContain('class="fl__scene fl-cord"');
    expect(html.match(/class="fl-cord__bar"/g)).toHaveLength(3);
    expect(html).toContain('--i: 0; --x: 33.75%; --h: 22.5%');
    expect(html).toContain('--i: 1; --x: 46.25%; --h: 36.25%');
    expect(html).toContain('--i: 2; --x: 58.75%; --h: 27.5%');
  });

  it('reduced-motion останавливает сцену, но не проявление', () => {
    expect(inline).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{\s*\.fl__scene,\s*\.fl__scene \*,\s*\.fl__shadow\s*\{\s*animation: none;/,
    );
    expect(loader).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{\s*\.fl__scene,\s*\.fl__scene \*,\s*\.fl__shadow\s*\{\s*animation: none;/,
    );
  });

  it('марка под сценой — рисунок, не текст (T24)', () => {
    const boot = /<div id="cord-boot"[\s\S]*?(?=<div id="root")/.exec(html)?.[0] ?? '';
    expect(boot.replace(/<[^>]+>/g, '').trim()).toBe('');
    expect(boot).toContain('<svg class="fl__brand"');
  });

  it('#root недоступен, пока загрузка висит', () => {
    expect(html).toContain('<div id="root" inert aria-busy="true"></div>');
  });
});
