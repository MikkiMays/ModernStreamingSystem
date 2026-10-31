import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LoadBars } from './LoadBars';

afterEach(cleanup);

const filled = () => document.querySelectorAll('.ui-load__bar[data-on]').length;

describe('загрузка сервера палочками (R143, Р-37)', () => {
  it('ступень — столько залитых из четырёх, цвет по ступени, для диктора — словами', () => {
    render(<LoadBars level={1} state="ok" />);
    expect(screen.getByRole('img', { name: 'Загрузка сервера: низкая' })).toHaveAttribute(
      'data-tone',
      'success',
    );
    expect(filled()).toBe(1);
    cleanup();
    render(<LoadBars level={3} state="busy" />);
    expect(screen.getByRole('img', { name: 'Загрузка сервера: высокая' })).toHaveAttribute(
      'data-tone',
      'warning',
    );
    expect(filled()).toBe(3);
    cleanup();
    render(<LoadBars level={4} state="full" withText />);
    expect(screen.getByRole('img', { name: 'Загрузка сервера: мест нет' })).toHaveAttribute(
      'data-tone',
      'danger',
    );
    expect(screen.getByText('мест нет')).toBeInTheDocument();
    expect(filled()).toBe(4);
  });

  it('нет ответа и обновление — пустые палочки, без цвета', () => {
    render(<LoadBars />);
    expect(screen.getByRole('img', { name: 'Загрузка сервера: неизвестна' })).not.toHaveAttribute(
      'data-tone',
    );
    expect(filled()).toBe(0);
    cleanup();
    render(<LoadBars level={2} state="maintenance" />);
    expect(screen.getByRole('img', { name: 'Загрузка сервера: обновляется' })).not.toHaveAttribute(
      'data-tone',
    );
    expect(filled()).toBe(0);
  });

  it('все четыре палочки одной высоты — не «лесенка» силы сигнала', () => {
    render(<LoadBars level={2} state="ok" />);
    expect(document.querySelectorAll('.ui-load__bar')).toHaveLength(4);
  });
});
