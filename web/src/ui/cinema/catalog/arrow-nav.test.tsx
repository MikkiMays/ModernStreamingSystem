import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { arrowNav, arrowTarget } from './arrow-nav';

afterEach(cleanup);

describe('стрелки в каталоге', () => {
  it('полка — один ряд: ← / → соседняя плитка, Home / End края, за край не уходит', () => {
    const row = { count: 5, columns: 5 };
    expect(arrowTarget({ ...row, key: 'ArrowRight', index: 0 })).toBe(1);
    expect(arrowTarget({ ...row, key: 'ArrowLeft', index: 3 })).toBe(2);
    expect(arrowTarget({ ...row, key: 'ArrowRight', index: 4 })).toBeNull();
    expect(arrowTarget({ ...row, key: 'ArrowLeft', index: 0 })).toBeNull();
    expect(arrowTarget({ ...row, key: 'Home', index: 3 })).toBe(0);
    expect(arrowTarget({ ...row, key: 'End', index: 1 })).toBe(4);
    // ↑ / ↓ в ряду — не его: страница прокручивается, как прокручивалась.
    expect(arrowTarget({ ...row, key: 'ArrowDown', index: 1 })).toBeNull();
    expect(arrowTarget({ ...row, key: 'Enter', index: 1 })).toBeNull();
  });

  it('сетка: ↑ / ↓ — строкой выше и ниже, в неполной последней строке — не дальше конца', () => {
    const grid = { count: 10, columns: 4 };
    expect(arrowTarget({ ...grid, key: 'ArrowDown', index: 1 })).toBe(5);
    expect(arrowTarget({ ...grid, key: 'ArrowUp', index: 5 })).toBe(1);
    expect(arrowTarget({ ...grid, key: 'ArrowDown', index: 7 })).toBeNull();
    expect(arrowTarget({ ...grid, key: 'ArrowUp', index: 2 })).toBeNull();
    expect(arrowTarget({ ...grid, key: 'ArrowRight', index: 3 })).toBe(4);
  });

  it('фокус переходит на главную кнопку соседней плитки, а нажатие гасится', () => {
    render(
      <div onKeyDown={arrowNav} data-testid="row">
        {['Первая', 'Вторая', 'Третья'].map((title) => (
          <article key={title} className="cinema-tile">
            <button className="cinema-start" aria-label={`Смотреть вместе: ${title}`} />
            <button className="cinema-open" aria-label={`Подробнее: ${title}`} />
          </article>
        ))}
      </div>,
    );
    const first = screen.getByRole('button', { name: 'Подробнее: Первая' });
    first.focus();
    expect(fireEvent.keyDown(first, { key: 'ArrowRight' })).toBe(false);
    expect(screen.getByRole('button', { name: 'Подробнее: Вторая' })).toHaveFocus();
    // С кнопки «Смотреть вместе» тоже: плитка та, в которой фокус.
    const start = screen.getByRole('button', { name: 'Смотреть вместе: Третья' });
    start.focus();
    fireEvent.keyDown(start, { key: 'ArrowLeft' });
    expect(screen.getByRole('button', { name: 'Подробнее: Вторая' })).toHaveFocus();
    // Shift и прочие модификаторы — не наши.
    expect(fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft', shiftKey: true })).toBe(true);
  });
});
