import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopSettings } from '../../core/desktop-settings';
import { readPreferences } from '../../core/preferences';
import { Settings } from '../Settings';

/*
  Раздел «Windows» (E03, T53, E01-B2): только в клиенте на Electron, только с app.settings и
  только те строки, чьи флаги оболочка объявила. Переключатель меняет значение в оболочке.
*/

const values = {
  tray: true,
  thumbar: true,
  badge: true,
  flash: true,
  sleepBlocker: true,
  overlay: false,
  autostart: false,
};

function fakeDesktop(features: string[]) {
  let state = { ...values };
  const api = {
    protocol: { major: 2, minor: 0 },
    features,
    app: { version: '1.0.0', arch: 'x64' },
    bootstrap: {
      profile: 'x'.repeat(43),
      theme: 'system',
      showPing: false,
      notificationSounds: true,
      autoConnect: true,
    },
    send: vi.fn(),
    invoke: vi.fn(async (method: string, payload?: object) => {
      if (method !== 'app.settings') return null;
      state = { ...state, ...(payload as Partial<typeof values>) };
      return state;
    }),
    on: vi.fn(() => () => {}),
  };
  (window as unknown as { cordDesktop?: unknown }).cordDesktop = api;
  return api;
}

beforeEach(() => {
  localStorage.clear();
  desktopSettings.set(null);
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { cordDesktop?: unknown }).cordDesktop;
});

const nav = () => screen.getByRole('navigation', { name: 'Разделы настроек' });
const heading = () => document.querySelector('.settings-content__title')!;
const ALL = [
  'hotkeys',
  'app.settings',
  'tray',
  'thumbar',
  'badge',
  'attention',
  'sleep',
  'overlay',
  'autostart',
];

describe('«Windows» в настройках', () => {
  it('в браузере раздела нет, а просьба открыть его ведёт в раздел по умолчанию', () => {
    render(<Settings open section="desktop" onOpenChange={vi.fn()} />);
    expect(within(nav()).queryByRole('button', { name: 'Windows' })).toBeNull();
    expect(heading()).toHaveTextContent('Микрофон');
  });

  it('в клиенте — все переключатели с значениями оболочки; выключить трей — запрос к оболочке', async () => {
    const api = fakeDesktop(ALL);
    render(<Settings open section="desktop" onOpenChange={vi.fn()} />);
    await act(async () => {});
    expect(within(nav()).getByRole('button', { name: 'Windows' })).toHaveAttribute('aria-current', 'page');
    for (const name of [
      'Значок в трее',
      'Кнопки на миниатюре',
      'Значок на иконке',
      'Мигание кнопки окна',
      'Не засыпать во время встречи',
      'Запускать вместе с Windows',
    ])
      expect(screen.getByRole('switch', { name })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Значок в трее' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Запускать вместе с Windows' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('switch', { name: 'Значок в трее' }));
    await act(async () => {});
    expect(api.invoke).toHaveBeenLastCalledWith('app.settings', { tray: false });
    expect(screen.getByRole('switch', { name: 'Значок в трее' })).not.toBeChecked();
  });

  it('строки без флага не рисуются: оболочка без трея и автозапуска', async () => {
    fakeDesktop(['app.settings', 'overlay', 'sleep']);
    render(<Settings open section="desktop" onOpenChange={vi.fn()} />);
    await act(async () => {});
    expect(screen.queryByRole('switch', { name: 'Значок в трее' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Запускать вместе с Windows' })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Не засыпать во время встречи' })).toBeInTheDocument();
    // Оверлей — свой раздел рядом (R62).
    expect(screen.queryByRole('switch', { name: 'Оверлей в играх' })).toBeNull();
    expect(within(nav()).getByRole('button', { name: 'Оверлей' })).toBeInTheDocument();
  });

  it('сочетание оверлея: запись отпускает все сочетания, назначенное уходит оболочке; микрофонное — нельзя', async () => {
    const api = fakeDesktop(ALL);
    render(<Settings open section="overlay" onOpenChange={vi.fn()} />);
    await act(async () => {});
    const record = (init: KeyboardEventInit) => {
      fireEvent.click(screen.getByRole('button', { name: /сочетание оверлея/ }));
      fireEvent.keyDown(document.querySelector('[data-hotkey-recorder]')!, init);
    };
    record({ code: 'KeyM', key: 'm', ctrlKey: true, shiftKey: true });
    expect(screen.getByRole('alert')).toHaveTextContent('уже у микрофона');
    expect(readPreferences().overlayHotkey).toBeNull();
    record({ code: 'KeyO', key: 'o', ctrlKey: true, shiftKey: true });
    await act(async () => {});
    expect(readPreferences().overlayHotkey).toMatchObject({ code: 'KeyO', ctrl: true, shift: true });
    const sets = api.send.mock.calls
      .filter(([type]) => type === 'hotkeys.configure')
      .map(([, payload]) => (payload as { bindings: { action: string }[] }).bindings.map((b) => b.action));
    expect(sets).toContainEqual([]);
    expect(sets.at(-1)).toContain('overlay.toggle');
    // У оверлея умолчания нет: «Сбросить» снимает назначение (R25, Р-3), «Отключить» больше нет.
    expect(screen.queryByRole('button', { name: /Отключить/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить сочетание оверлея' }));
    expect(readPreferences().overlayHotkey).toBeNull();
    expect(screen.getByRole('button', { name: 'Назначить сочетание оверлея' })).toBeInTheDocument();
  });
});
