import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import kit from './kit.css?raw';
import { Drawer } from './Drawer';

afterEach(cleanup);

function Sheet({ onOpenChange = () => {} }: { onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Плеер
      </button>
      <Drawer
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange(next);
        }}
        title="Музыка"
        height="85"
      >
        <p>Очередь</p>
      </Drawer>
    </>
  );
}

describe('Drawer', () => {
  it('лист снизу — модальное окно с заголовком, ручкой и содержимым', async () => {
    render(<Sheet />);
    fireEvent.click(screen.getByRole('button', { name: 'Плеер' }));
    const sheet = await screen.findByRole('dialog', { name: 'Музыка' });
    expect(sheet).toHaveClass('ui-drawer', 'ui-drawer--85');
    expect(sheet.querySelector('.ui-drawer__handle')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Очередь')).toBeVisible();
  });

  it('Esc и крестик закрывают', async () => {
    const onOpenChange = vi.fn();
    render(<Sheet onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Плеер' }));
    const sheet = await screen.findByRole('dialog', { name: 'Музыка' });
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false));

    fireEvent.click(screen.getByRole('button', { name: 'Плеер' }));
    const again = await screen.findByRole('dialog', { name: 'Музыка' });
    fireEvent.click(again.querySelector('button[aria-label="Закрыть"]')!);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('слой не ниже 39 и отступ под жест «домой»; прокрутка внутри листа', () => {
    expect(kit).toMatch(/\.ui-drawer__viewport \{[^}]*z-index: var\(--z-dialog\);/);
    expect(kit).toMatch(/\.ui-drawer \{[^}]*env\(safe-area-inset-bottom/);
    expect(kit).toMatch(/\.ui-drawer__body \{[^}]*overflow-y: auto;/);
  });
});
