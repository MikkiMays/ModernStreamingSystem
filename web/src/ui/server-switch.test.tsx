import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { thisServer } from '../core/servers';

/*
  Сервер в браузере и в приложении (R135, R136). В браузере сервер — это сайт: подключение к нему
  всегда само, выключателя нет; «Сменить сервер» — серверы каталога установки, выбор — переход на сайт
  выбранного. В приложении выключатель «Подключаться автоматически» остаётся, и его помнит оболочка:
  прежде выбор на экране подключения оставался в странице, при запуске оболочка клала поверх своё —
  и выключатель «не работал».
*/

const session = vi.hoisted(() => ({
  serverInfo: vi.fn(async () => ({ name: 'Cord', passwordRequired: false })),
  openConnection: vi.fn(async () => ({ ok: true, detail: '' })),
}));
vi.mock('../core/session', async (original) => ({
  ...(await original<typeof import('../core/session')>()),
  serverInfo: session.serverInfo,
  openConnection: session.openConnection,
}));
vi.mock('../core/sounds', async (original) => ({
  ...(await original<typeof import('../core/sounds')>()),
  ensureNotificationAudio: () => {},
}));

import { Connect } from './Connect';
import { ServerSection } from './settings/ServerSection';

function catalog(servers: { url: string; name: Record<string, string>; order: number }[]) {
  const bytes = new TextEncoder().encode(JSON.stringify({ format: 'cord.servers/1', servers }));
  const payload = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return new Response(JSON.stringify({ payload, signatures: [] }), { status: 200 });
}
const HERE = location.origin + '/';
const CATALOG = [
  { url: 'https://cord.nikg.tech/', name: { ru: 'Германия, Франкфурт' }, order: 10 },
  { url: HERE, name: { ru: 'Этот сервер' }, order: 15 },
  { url: 'https://cordcam.ru/', name: { ru: 'Россия, Москва' }, order: 20 },
];

function desktop(autoConnect: boolean) {
  const send = vi.fn();
  vi.stubGlobal('cordDesktop', {
    protocol: { major: 2, minor: 0 },
    features: ['servers'],
    app: { version: '1.0.11', arch: 'x64' },
    bootstrap: { profile: '', theme: 'system', showPing: false, notificationSounds: true, autoConnect },
    send,
    invoke: vi.fn(async () => null),
    on: () => () => {},
  });
  return send;
}

beforeEach(() => {
  localStorage.clear();
  session.openConnection.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => catalog(CATALOG)),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('экран подключения', () => {
  it('в браузере подключается сам даже со старым «не подключаться» — и выключателя нет', async () => {
    localStorage.setItem(
      'cord:servers:v1',
      JSON.stringify({ url: HERE, name: '', password: '', autoConnect: false }),
    );
    const onConnected = vi.fn();
    render(<Connect onConnected={onConnected} />);
    await act(async () => {});
    expect(session.openConnection).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenCalled();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('в приложении выключатель говорит оболочке — она помнит его между запусками', async () => {
    const send = desktop(false);
    localStorage.setItem(
      'cord:servers:v1',
      JSON.stringify({ url: HERE, name: '', password: '', autoConnect: false }),
    );
    render(<Connect onConnected={vi.fn()} />);
    await act(async () => {});
    // Выключено — экран ждёт нажатия.
    expect(session.openConnection).not.toHaveBeenCalled();
    const toggle = screen.getByRole('switch', { name: 'Подключаться автоматически при запуске' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(send).toHaveBeenCalledWith('server.autoconnect', { autoConnect: true });
    expect(thisServer().autoConnect).toBe(true);
  });
});

describe('«Сервер» в настройках', () => {
  it('в браузере: «Сменить сервер» — серверы каталога, текущий отмечен, выбор ведёт на сайт', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...location, origin: location.origin, assign });
    render(<ServerSection showPing={false} changePing={vi.fn()} inCall={false} />);
    await act(async () => {});
    expect(screen.queryByRole('switch', { name: 'Подключаться при запуске' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Отключиться' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Сменить сервер' }));
    // Меню называется по своей кнопке (aria-labelledby Base UI).
    const menu = await screen.findByRole('menu', { name: 'Сменить сервер' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Германия, Франкфуртcord.nikg.tech',
      'Этот серверВы здесь',
      'Россия, Москваcordcam.ru',
    ]);
    expect(items[1]).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(items[2]!);
    expect(assign).toHaveBeenCalledWith('https://cordcam.ru/');
  });

  it('в браузере без каталога (или только этот сервер) кнопки нет — выбирать не из чего', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );
    render(<ServerSection showPing={false} changePing={vi.fn()} inCall={false} />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Сменить сервер' })).toBeNull();
  });

  it('во встрече смена сервера погашена: переход оборвал бы звонок', async () => {
    render(<ServerSection showPing={false} changePing={vi.fn()} inCall />);
    await act(async () => {});
    const button = screen.getByRole('button', { name: 'Сменить сервер' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Сначала выйдите из встречи');
  });

  it('в приложении: «Сменить сервер» открывает родной список, выключатель — у оболочки', async () => {
    const send = desktop(true);
    render(<ServerSection showPing={false} changePing={vi.fn()} inCall={false} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Сменить сервер' }));
    expect(send).toHaveBeenCalledWith('servers.open', {});
    fireEvent.click(screen.getByRole('switch', { name: 'Подключаться при запуске' }));
    expect(send).toHaveBeenCalledWith('server.autoconnect', { autoConnect: false });
  });
});
