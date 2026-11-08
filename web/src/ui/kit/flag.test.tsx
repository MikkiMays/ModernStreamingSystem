import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Flag, knownFlag } from './Flag';

afterEach(cleanup);

describe('флаг страны узла (R200)', () => {
  it('известная страна — рисунок SVG, украшение к названию рядом', () => {
    const { container } = render(<Flag country="fi" />);
    const svg = container.querySelector('svg.ui-flag');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('data-country', 'FI');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    // Скандинавский крест — три прямоугольника; у полос — по полосе на цвет.
    expect(svg!.querySelectorAll('rect')).toHaveLength(3);
    cleanup();
    render(<Flag country="DE" label="Германия" />);
    expect(screen.getByRole('img', { name: 'Германия' })).toHaveAttribute('data-country', 'DE');
    expect(knownFlag('ru')).toBe(true);
  });

  it('неизвестная страна и пустота — буквы кода на плашке, без выдумки', () => {
    const { container } = render(<Flag country="JP" />);
    const badge = container.querySelector('.ui-flag[data-fallback]');
    expect(badge).toHaveTextContent('JP');
    expect(knownFlag('JP')).toBe(false);
    cleanup();
    render(<Flag country={null} />);
    expect(document.querySelector('.ui-flag[data-fallback]')).toHaveTextContent('·');
  });
});
