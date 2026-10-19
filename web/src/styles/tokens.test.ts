import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check, declarations, resolve, theme } from '../../scripts/check-contrast.mjs';
import tokens from './tokens.css?raw';

/**
 * Токены — договор для всех экранных эпиков: имена, обе темы, контраст. Тёмная тема записана
 * дважды (ручной выбор и «как в системе»), и расхождение между блоками никто не заметил бы
 * глазами — только так.
 */
describe('tokens.css', () => {
  it('два тёмных блока совпадают дословно', () => {
    const manual = declarations(tokens, (s) => s === "[data-theme='dark']");
    const system = declarations(tokens, (s) => s === ":root:not([data-theme='light'])");
    expect(Object.keys(manual).length).toBeGreaterThan(20);
    expect(system).toEqual(manual);
  });

  it('светлая тема задаёт те же смысловые имена, что и тёмная', () => {
    const light = declarations(tokens, (s) => s === ":root,\n[data-theme='light']");
    const dark = declarations(tokens, (s) => s === "[data-theme='dark']");
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
  });

  it('прежние имена продолжают работать в обеих темах', () => {
    for (const name of ['light', 'dark'] as const) {
      const vars = theme(tokens, name);
      for (const legacy of [
        '--bg',
        '--surface',
        '--surface-2',
        '--text',
        '--muted',
        '--line',
        '--blue',
        '--blue-hover',
        '--blue-soft',
        '--shadow',
        '--radius',
        '--speaking',
        '--select-arrow',
      ])
        expect(resolve(vars, vars[legacy] ?? ''), `${legacy} (${name})`).toMatch(/^(#|rgb|url|\d|inset)/);
    }
  });

  it('сырые цвета читает только сам файл токенов', () => {
    const others = ['styles.css', 'accessibility.css'].map((file) =>
      readFileSync(join(process.cwd(), 'src', file), 'utf8'),
    );
    for (const css of others) expect(css).not.toMatch(/--palette-/);
  });

  it('контраст WCAG 2.2 AA выполнен в обеих темах и на сцене', () => {
    const failed = check(tokens).filter((row) => !row.ok);
    expect(
      failed,
      failed.map((r) => `${r.theme} ${r.fg} на ${r.bg}: ${r.ratio.toFixed(2)}`).join('\n'),
    ).toEqual([]);
  });

  it('z-index: меню 40, диалоги 50 — как договорено', () => {
    const vars = theme(tokens, 'light');
    expect(vars['--z-menu']).toBe('40');
    expect(vars['--z-dialog']).toBe('50');
    expect(Number(vars['--z-loader'])).toBeGreaterThan(50);
    expect(Number(vars['--z-toast'])).toBeGreaterThan(Number(vars['--z-loader']));
  });
});
