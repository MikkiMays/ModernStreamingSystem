import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);
import { ResizeHandle } from './ResizeHandle';
import { Slider } from './Slider';
import { Button } from './Button';
import { Badge, Soon } from './Badge';
import kit from './kit.css?raw';

describe('ResizeHandle', () => {
  const handle = (edge: 'start' | 'end' = 'start') => {
    const onChange = vi.fn();
    render(
      <ResizeHandle value={320} min={240} max={480} onChange={onChange} edge={edge} label="Ширина панели" />,
    );
    return { onChange, element: screen.getByRole('separator', { name: 'Ширина панели' }) };
  };

  it('это разделитель с текущим значением и пределами', () => {
    const { element } = handle();
    expect(element).toHaveAttribute('aria-orientation', 'vertical');
    expect(element).toHaveAttribute('aria-valuenow', '320');
    expect(element).toHaveAttribute('aria-valuemin', '240');
    expect(element).toHaveAttribute('aria-valuemax', '480');
    expect(element).toHaveAttribute('tabindex', '0');
  });

  it('стрелки двигают по 16, с Shift по 64, Home и End — к пределам', () => {
    const { element, onChange } = handle();
    fireEvent.keyDown(element, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(336);
    fireEvent.keyDown(element, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(304);
    fireEvent.keyDown(element, { key: 'ArrowRight', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(384);
    fireEvent.keyDown(element, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(240);
    fireEvent.keyDown(element, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(480);
  });

  it('у панели справа стрелка вправо делает её уже', () => {
    const { element, onChange } = handle('end');
    fireEvent.keyDown(element, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(304);
  });

  it('перетаскивание считает от точки захвата и зажимает в пределах', () => {
    const { element, onChange } = handle();
    let captured = false;
    element.setPointerCapture = () => {
      captured = true;
    };
    element.hasPointerCapture = () => captured;
    element.releasePointerCapture = () => {
      captured = false;
    };
    fireEvent.pointerDown(element, { button: 0, pointerId: 1, clientX: 500 });
    expect(element).toHaveAttribute('data-dragging', 'true');
    fireEvent.pointerMove(element, { pointerId: 1, clientX: 540 });
    expect(onChange).toHaveBeenLastCalledWith(360);
    fireEvent.pointerMove(element, { pointerId: 1, clientX: 900 });
    expect(onChange).toHaveBeenLastCalledWith(480);
    fireEvent.pointerUp(element, { pointerId: 1 });
    expect(element).not.toHaveAttribute('data-dragging');
  });

  it('двойное нажатие возвращает ширину по умолчанию', () => {
    const onReset = vi.fn();
    render(
      <ResizeHandle value={320} min={240} max={480} onChange={() => {}} onReset={onReset} label="Ширина" />,
    );
    fireEvent.doubleClick(screen.getByRole('separator'));
    expect(onReset).toHaveBeenCalledOnce();
  });
});

describe('Slider', () => {
  it('заливка считается от значения: ноль пуст, сотня полна', () => {
    const { rerender } = render(<Slider value={0} label="Громкость" readOnly />);
    const input = screen.getByRole('slider', { name: 'Громкость' });
    expect(input.style.getPropertyValue('--slider-p')).toBe('0');
    rerender(<Slider value={100} label="Громкость" readOnly />);
    expect(input.style.getPropertyValue('--slider-p')).toBe('1');
    rerender(<Slider value={25} min={0} max={50} label="Громкость" readOnly />);
    expect(input.style.getPropertyValue('--slider-p')).toBe('0.5');
  });

  it('кольцо фокуса рисуется только с клавиатуры (T31)', () => {
    expect(kit).toMatch(/\.ui-slider:focus-visible\s*\{[^}]*outline: var\(--focus-outline\)/);
    expect(kit).not.toMatch(/\.ui-slider:focus\s*\{[^}]*outline: var\(--focus-outline\)/);
    expect(kit).toMatch(/\.ui-slider:focus,?[\s\S]*?\{\s*outline: none;/);
  });
});

describe('набор', () => {
  it('в kit.css нет литералов цвета: только токены', () => {
    const plain = kit.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(plain.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
  });

  it('кнопка в ожидании недоступна и помечена занятой', () => {
    render(<Button loading>Подключаем</Button>);
    const button = screen.getByRole('button', { name: 'Подключаем' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('бейдж «Скоро» — слово, а не сокращение', () => {
    render(
      <>
        <Soon />
        <Badge variant="live">В эфире</Badge>
      </>,
    );
    expect(screen.getByText('Скоро')).toHaveClass('ui-badge--soon');
    expect(screen.getByText('В эфире')).toHaveClass('ui-badge--live');
  });
});
