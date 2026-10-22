import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import kit from './kit.css?raw';
import { Segmented, type SegmentedOption } from './Segmented';

afterEach(cleanup);

const QUALITY: SegmentedOption<number>[] = [
  { value: 720, label: '720p' },
  { value: 1080, label: '1080p' },
  { value: 1440, label: '1440p', disabled: true, title: 'Этот сервер допускает до 1080p · 60 fps' },
];

function Quality({ onChange = () => {} }: { onChange?: (value: number) => void }) {
  const [value, setValue] = useState(720);
  return (
    <Segmented
      aria-label="Камера: качество"
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      options={QUALITY}
    />
  );
}

describe('Segmented', () => {
  it('это радиогруппа: пункты — радио, выбранный отмечен', () => {
    render(<Quality />);
    const group = screen.getByRole('radiogroup', { name: 'Камера: качество' });
    expect(group).toHaveClass('ui-segmented');
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: '720p' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '1080p' })).not.toBeChecked();
  });

  it('щелчок выбирает пункт и отдаёт значение своего типа', () => {
    const onChange = vi.fn();
    render(<Quality onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: '1080p' }));
    expect(onChange).toHaveBeenLastCalledWith(1080);
    expect(screen.getByRole('radio', { name: '1080p' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '720p' })).not.toBeChecked();
  });

  it('стрелка вправо переводит выбор на следующий пункт', async () => {
    const onChange = vi.fn();
    render(<Quality onChange={onChange} />);
    const first = screen.getByRole('radio', { name: '720p' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    // Base UI переводит фокус следующей микрозадачей, выбор идёт за фокусом.
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(1080));
    expect(screen.getByRole('radio', { name: '1080p' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '1080p' })).toHaveFocus();
  });

  it('недоступный пункт с причиной в title не выбирается ни щелчком, ни стрелкой', async () => {
    const onChange = vi.fn();
    render(<Quality onChange={onChange} />);
    const top = screen.getByRole('radio', { name: '1440p' });
    expect(top).toHaveAttribute('title', 'Этот сервер допускает до 1080p · 60 fps');
    expect(top).toHaveAttribute('data-disabled');
    fireEvent.click(top);
    expect(onChange).not.toHaveBeenCalled();
    expect(top).not.toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: '1080p' }));
    const middle = screen.getByRole('radio', { name: '1080p' });
    middle.focus();
    fireEvent.keyDown(middle, { key: 'ArrowRight' });
    await Promise.resolve();
    expect(top).not.toBeChecked();
    expect(middle).toBeChecked();
  });

  it('без управления помнит выбор сам: defaultValue и щелчок', () => {
    render(
      <Segmented
        aria-label="Режим показа"
        defaultValue="detail"
        options={[
          { value: 'detail', label: 'Чёткость' },
          { value: 'motion', label: 'Плавность' },
        ]}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Чёткость' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Плавность' }));
    expect(screen.getByRole('radio', { name: 'Плавность' })).toBeChecked();
  });

  it('размер и ширина — классами; значок-пункт получает имя из ariaLabel', () => {
    render(
      <Segmented
        aria-label="Зум"
        size="sm"
        full
        value={1}
        onValueChange={() => {}}
        options={[
          { value: 0.5, label: '0.5×' },
          { value: 1, label: '1×' },
          { value: 2, label: <b>2×</b>, ariaLabel: 'Двукратный зум' },
        ]}
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Зум' });
    expect(group).toHaveClass('ui-segmented--sm', 'ui-segmented--full');
    expect(screen.getByRole('radio', { name: 'Двукратный зум' })).toBeInTheDocument();
  });

  it('вид — на токенах вкладок; кольцо — вокруг группы, у пункта своего нет', () => {
    expect(kit).toMatch(
      /\.ui-segmented \{[^}]*height: var\(--tab-h\);[^}]*border-radius: var\(--tab-radius\);/,
    );
    expect(kit).toMatch(/\.ui-segmented:has\(:focus-visible\) \{\s*outline: var\(--focus-outline\);/);
    expect(kit).toMatch(/\.ui-segmented__item:focus-visible \{\s*outline: none;/);
  });
});
