import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import kit from './kit.css?raw';
import { Popover } from './Popover';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Ширина окна для `matchMedia`: телефон — до 767 px (граница раскладки Cord). */
function viewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      matches: max ? width <= Number(max[1]) : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
}

function Widget(props: { onOpenChange?: (open: boolean) => void; mobile?: 'drawer' | 'popover' }) {
  return (
    <Popover
      trigger={<button type="button">Музыка</button>}
      title="Сейчас играет"
      onOpenChange={props.onOpenChange}
      mobile={props.mobile}
    >
      <p>Ночной город</p>
    </Popover>
  );
}

describe('Popover', () => {
  it('открывается по кнопке: окно с заголовком, кнопка знает, что раскрыла', async () => {
    viewport(1440);
    render(<Widget />);
    const trigger = screen.getByRole('button', { name: 'Музыка' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    const popup = await screen.findByRole('dialog', { name: 'Сейчас играет' });
    expect(popup).toHaveClass('ui-popover');
    expect(screen.getByText('Ночной город')).toBeVisible();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('Esc закрывает и возвращает фокус кнопке', async () => {
    viewport(1440);
    const onOpenChange = vi.fn();
    render(<Widget onOpenChange={onOpenChange} />);
    const trigger = screen.getByRole('button', { name: 'Музыка' });
    fireEvent.click(trigger);
    const popup = await screen.findByRole('dialog', { name: 'Сейчас играет' });
    fireEvent.keyDown(popup, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('крестик в заголовке закрывает', async () => {
    viewport(1440);
    render(<Widget />);
    fireEvent.click(screen.getByRole('button', { name: 'Музыка' }));
    const popup = await screen.findByRole('dialog', { name: 'Сейчас играет' });
    fireEvent.click(popup.querySelector('button[aria-label="Закрыть"]')!);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('на телефоне становится листом снизу, если не попросили иначе', async () => {
    viewport(390);
    const { unmount } = render(<Widget />);
    fireEvent.click(screen.getByRole('button', { name: 'Музыка' }));
    expect(await screen.findByRole('dialog', { name: 'Сейчас играет' })).toHaveClass('ui-drawer');
    unmount();

    render(<Widget mobile="popover" />);
    fireEvent.click(screen.getByRole('button', { name: 'Музыка' }));
    expect(await screen.findByRole('dialog', { name: 'Сейчас играет' })).toHaveClass('ui-popover');
  });

  it('слой — над меню, но под диалогами; появление на токенах движения', async () => {
    expect(kit).toMatch(/\.ui-popover__positioner \{\s*z-index: calc\(var\(--z-menu\) \+ 1\);/);
    expect(kit).toMatch(
      /\.ui-popover \{[^}]*background: var\(--menu-bg\);[^}]*box-shadow: var\(--shadow-2\);/,
    );
    await act(async () => {});
  });
});
