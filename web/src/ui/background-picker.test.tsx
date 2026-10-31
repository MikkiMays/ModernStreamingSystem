import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const support = vi.hoisted(() => ({ value: 'full' as 'full' | 'blur' | 'none' }));
vi.mock('../media/background-effect', async (original) => ({
  ...(await original<typeof import('../media/background-effect')>()),
  backgroundSupport: async () => support.value,
  customBackgroundUrl: async () => null,
}));

afterEach(cleanup);

describe('выбор фона (R153)', () => {
  it('компьютер: без фона, два размытия, шесть фонов и своё фото; выбранный отмечен', async () => {
    vi.resetModules();
    support.value = 'full';
    const { BackgroundPicker } = await import('./BackgroundPicker');
    const change = vi.fn();
    render(<BackgroundPicker value={{ kind: 'blur', strength: 'light' }} onChange={change} />);
    const group = await screen.findByRole('radiogroup', { name: 'Фон' });
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(10);
    expect(screen.getByRole('radio', { name: 'Лёгкое размытие' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Лес' }));
    expect(change).toHaveBeenCalledWith({ kind: 'image', id: 'forest' });
    expect(screen.getByRole('radio', { name: 'Загрузить своё фото' })).toBeInTheDocument();
  });

  it('телефон с Android — только размытие; iPhone — строки нет вовсе', async () => {
    vi.resetModules();
    support.value = 'blur';
    const { BackgroundPicker } = await import('./BackgroundPicker');
    const view = render(<BackgroundPicker value={{ kind: 'none' }} onChange={vi.fn()} />);
    const group = await screen.findByRole('radiogroup', { name: 'Фон' });
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(3);
    view.unmount();
    vi.resetModules();
    support.value = 'none';
    const fresh = await import('./BackgroundPicker');
    render(<fresh.BackgroundPicker value={{ kind: 'none' }} onChange={vi.fn()} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('radiogroup', { name: 'Фон' })).toBeNull();
  });
});
