import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { Meeting } from '../../core/meeting';
import { Store } from '../../core/store';
import { Dialog } from '../kit';
import { Settings } from '../Settings';
import Diagnostics from '../Diagnostics';
import { HelpButton } from './HelpButton';
import { HelpHost } from './HelpHost';
import { closeHelp, helpRequest, openHelp } from './help';

/*
  Окна не стопкой (S5, R49). «Помощь» в диагностике открывала помощь под диагностикой и вложенным
  окном: нажатие на видную часть помощи закрывало её, обращение оставить было нельзя. Теперь окно
  поддержки одно, на корне (`HelpHost`), а то окно, из которого его открыли, сначала закрывается.
*/

// Окно поддержки — ленивый чанк и окно набора: на загруженной машине (весь набор тестов параллельно)
// первый импорт и отрисовка дольше ожиданий по умолчанию.
beforeAll(() => import('./HelpCenter'));
vi.setConfig({ testTimeout: 15_000 });

afterEach(() => {
  act(() => closeHelp());
  cleanup();
});

const wait = { timeout: 4000 };
const help = () => screen.findByRole('dialog', { name: 'Поддержка' }, wait);
/** Окно поддержки готово: ленивый чанк приехал; «Написать» — вкладка с формой обращения. */
async function ready() {
  const dialog = await help();
  fireEvent.click(await within(dialog).findByRole('tab', { name: 'Написать' }, wait));
  await within(dialog).findByRole('textbox', { name: 'Что случилось' }, wait);
  return dialog;
}

function fakeMeeting() {
  return {
    media: {
      preferences: new Store({ devices: {}, audio: {} }),
      state: new Store({ status: 'connected', quality: 'good' }),
      link: new Store({ path: 'udp', grade: 'good', jitterMs: 4, ordered: false }),
      tracks: new Store([]),
      playoutTargets: () => [],
      returnToLive: vi.fn(),
      callReport: () => null,
    },
    control: { state: new Store('connected') },
  } as unknown as Meeting;
}

/** Как во встрече (`MeetingView`): одно окно за раз, «Помощь» из диагностики её заменяет. */
function MeetingLayers() {
  const [diagnostics, setDiagnostics] = useState(true);
  const meeting = useState(fakeMeeting)[0];
  return (
    <>
      {diagnostics && (
        <Diagnostics
          meeting={meeting}
          onClose={() => setDiagnostics(false)}
          onHelp={() => {
            setDiagnostics(false);
            openHelp({ faq: 'network', onDiagnostics: () => setDiagnostics(true) });
          }}
          onReport={() => {
            setDiagnostics(false);
            openHelp({ faq: 'network', onDiagnostics: () => setDiagnostics(true), report: true });
          }}
        />
      )}
      <HelpHost />
    </>
  );
}

describe('одно окно помощи на всё приложение (S5)', () => {
  it('две кнопки — одно окно; закрыли — закрыто', async () => {
    render(
      <>
        <HelpButton />
        <HelpButton look="text" />
        <HelpHost />
      </>,
    );
    const [first, second] = screen.getAllByRole('button', { name: 'Поддержка' });
    fireEvent.click(first!);
    await ready();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(within(await help()).getByRole('button', { name: 'Закрыть' }));
    expect(helpRequest.get()).toBeNull();
    fireEvent.click(second!);
    await ready();
    expect(screen.getAllByRole('dialog', { name: 'Поддержка' })).toHaveLength(1);
  });

  it('кнопка внутри другого окна закрывает его: помощь заменяет окно и остаётся, когда его нет (R49)', async () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <Dialog open={open} onOpenChange={setOpen} title="Другое окно">
            <HelpButton look="text" onOpen={() => setOpen(false)} />
          </Dialog>
          <HelpHost />
        </>
      );
    }
    render(<Host />);
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Другое окно' })).getByRole('button', { name: 'Поддержка' }),
    );
    const dialog = await ready();
    expect(screen.queryByRole('dialog', { name: 'Другое окно' })).toBeNull();
    // Нажатие внутри помощи — не «нажатие снаружи»: окно остаётся, и форма заполняется.
    const field = within(dialog).getByRole('textbox', { name: 'Что случилось' });
    fireEvent.pointerDown(field);
    fireEvent.change(field, { target: { value: 'Музыка заикается' } });
    expect(await help()).toBeInTheDocument();
    expect(field).toHaveValue('Музыка заикается');
  });
});

describe('«Поддержка» в диагностике (R49)', () => {
  it('диагностика закрывается, поддержка открыта поверх ничего и нажимается; «Открыть диагностику» — обратно', async () => {
    render(<MeetingLayers />);
    const diagnostics = await screen.findByRole('dialog', { name: 'Диагностика' });
    fireEvent.click(within(diagnostics).getByRole('button', { name: 'Поддержка' }));
    const dialog = await ready();
    // Окно не стопкой: диагностики больше нет, помощь — единственное окно.
    expect(screen.queryByRole('dialog', { name: 'Диагностика' })).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const field = within(dialog).getByRole('textbox', { name: 'Что случилось' });
    fireEvent.pointerDown(field);
    fireEvent.change(field, { target: { value: 'Пропадает звук' } });
    expect(field).toHaveValue('Пропадает звук');
    // Из поддержки — назад в диагностику этой встречи: снова одно окно.
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Проверить' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Открыть диагностику' }));
    expect(await screen.findByRole('dialog', { name: 'Диагностика' }, wait)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Поддержка' })).toBeNull();
  });

  it('«Сообщить о проблеме» — диагностика закрыта, поддержка сразу на выборе того, что не так (R79)', async () => {
    render(<MeetingLayers />);
    const diagnostics = await screen.findByRole('dialog', { name: 'Диагностика' });
    fireEvent.click(within(diagnostics).getByRole('button', { name: 'Сообщить о проблеме' }));
    const dialog = await help();
    expect(await within(dialog).findByRole('group', { name: 'Что не так' }, wait)).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: 'Написать' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('dialog', { name: 'Диагностика' })).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});

describe('«Поддержка» в настройках (R51)', () => {
  it('раздел над «О программе» — вопросы и форма прямо в настройках, второго окна нет', async () => {
    render(
      <>
        <Settings open section="support" onOpenChange={vi.fn()} />
        <HelpHost />
      </>,
    );
    const settings = screen.getByRole('dialog', { name: 'Настройки' });
    const nav = within(settings).getByRole('navigation', { name: 'Разделы настроек' });
    const items = within(nav)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(items.indexOf('Поддержка')).toBe(items.indexOf('О программе') - 1);
    fireEvent.click(await within(settings).findByRole('tab', { name: 'Написать' }, wait));
    expect(within(settings).getByRole('textbox', { name: 'Что случилось' })).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    // «Помощь» оболочки (`cord://settings/help`) ведёт сюда же.
    cleanup();
    render(<Settings open section="help" onOpenChange={vi.fn()} />);
    expect(await screen.findByRole('tablist', { name: 'Разделы поддержки' }, wait)).toBeInTheDocument();
  });

  it('настройки, открытые поверх помощи (оболочка Windows), её заменяют', async () => {
    const { rerender } = render(
      <>
        <Settings open={false} onOpenChange={vi.fn()} />
        <HelpHost />
      </>,
    );
    act(() => openHelp());
    await ready();
    rerender(
      <>
        <Settings open onOpenChange={vi.fn()} />
        <HelpHost />
      </>,
    );
    expect(screen.getByRole('dialog', { name: 'Настройки' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Поддержка' })).toBeNull();
  });
});
