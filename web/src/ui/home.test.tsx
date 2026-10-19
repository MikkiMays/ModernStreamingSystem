import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publicApi } from '../api/client';
import type { Admission } from '../api/types';
import { favoriteApi, type Favorite } from '../core/favorites';
import { favoriteGroupApi } from '../core/favorite-groups';
import { announceMeeting, setChannelFactory, type Channel } from '../core/active-meeting';
import { Home } from './Home';
import { DesktopHome } from './DesktopHome';
import { appVersion } from '../core/version';
import { forgetPanelWidths } from './kit';

// Device settings are outside this screen; their media discovery is tested separately.
vi.mock('./Settings', () => ({ Settings: () => null }));
vi.mock('../core/download', () => ({ windowsRelease: async () => null }));

const room: Favorite = {
  roomId: '00000000-0000-4000-8000-000000000001',
  title: 'Вечерний разговор',
  code: '333444555',
  savedAt: 1,
  closed: false,
  canJoin: true,
};
const daily = {
  ...room,
  roomId: '00000000-0000-4000-8000-000000000002',
  title: 'Дейли',
  code: '111222333',
  groupId: 'work',
  pinned: false,
  alias: null,
} as Favorite;
const capabilities = {
  admissionOpen: true,
  fileMaxBytes: 1000000,
  frameRates: [30, 60],
  maxParticipants: 10,
  maxScreens: 2,
  name: 'Cord',
  passwordRequired: false,
  recoverySeconds: 20,
  region: 'local',
  resolutions: [720, 1080],
  roomMaxBytes: 10000000,
};
const clients: QueryClient[] = [];

/** Шина «вкладок» в одном процессе — как `BroadcastChannel`, без доставки самому себе. */
function tabs() {
  const channels = new Set<FakeChannel>();
  class FakeChannel implements Channel {
    listeners = new Set<(event: MessageEvent) => void>();
    constructor() {
      channels.add(this);
    }
    postMessage(data: unknown) {
      for (const channel of channels)
        if (channel !== this)
          for (const listener of channel.listeners) listener({ data: structuredClone(data) } as MessageEvent);
    }
    addEventListener(_: 'message', listener: (event: MessageEvent) => void) {
      this.listeners.add(listener);
    }
    removeEventListener(_: 'message', listener: (event: MessageEvent) => void) {
      this.listeners.delete(listener);
    }
    close() {
      channels.delete(this);
    }
  }
  return () => new FakeChannel();
}

beforeEach(() => {
  localStorage.clear();
  forgetPanelWidths();
  setChannelFactory(tabs());
  // Широкий экран: боковая панель — своя колонка, а не меню под бургером.
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('min-width'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  );
  vi.spyOn(publicApi, 'capabilities').mockResolvedValue(capabilities);
  vi.spyOn(favoriteApi, 'list').mockResolvedValue([room]);
  vi.spyOn(favoriteGroupApi, 'list').mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function show(desktop = false, onResume = vi.fn()) {
  const onJoin = vi.fn();
  const onCreate = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      {desktop ? (
        <DesktopHome onCreate={onCreate} onJoin={onJoin} onSettings={() => {}} />
      ) : (
        <Home onCreate={onCreate} onJoin={onJoin} onResume={onResume} theme="light" setTheme={() => {}} />
      )}
    </QueryClientProvider>,
  );
  return { ...view, onJoin, onCreate, onResume };
}

it('associates an invalid invitation with the field and clears the error when it is corrected', async () => {
  const view = show(true);
  const field = view.getByLabelText('Код встречи или ссылка');
  fireEvent.change(field, { target: { value: 'wrong' } });
  fireEvent.click(view.getByRole('button', { name: 'Присоединиться' }));
  expect(view.onJoin).not.toHaveBeenCalled();
  expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(field).toHaveAccessibleDescription(/Введите 9 цифр/);
  fireEvent.change(field, { target: { value: '333444555' } });
  expect(field).toHaveValue('333-444-555');
  expect(field).not.toHaveAttribute('aria-invalid', 'true');
  expect(view.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.submit(field.closest('form')!);
  expect(view.onJoin).toHaveBeenCalledWith({ kind: 'code', code: '333444555' });
  await waitFor(() => expect(publicApi.capabilities).toHaveBeenCalled());
});

it('keeps saved rooms in the sidebar and opens one from there, with the count of the limit', async () => {
  const view = show();
  expect(within(view.getByRole('main')).queryByText(room.title)).not.toBeInTheDocument();
  const nav = view.getByRole('navigation', { name: 'Избранное' });
  fireEvent.click(await within(nav).findByRole('button', { name: /^Вечерний разговор/ }));
  expect(view.onJoin).toHaveBeenCalledWith({
    kind: 'favorite',
    favorite: expect.objectContaining({ roomId: room.roomId }),
  });
  expect(within(nav).getByText('1 из 10')).toBeInTheDocument();
  // Тема — в настройках (T41): на главной её переключателя нет.
  expect(view.queryByRole('button', { name: /Тема/ })).not.toBeInTheDocument();
});

it('shows groups with their rooms and folds them on this device', async () => {
  vi.mocked(favoriteApi.list).mockResolvedValue([room, daily]);
  vi.mocked(favoriteGroupApi.list).mockResolvedValue([{ id: 'work', title: 'Работа' }]);
  const view = show();
  const nav = view.getByRole('navigation', { name: 'Избранное' });
  const toggle = await within(nav).findByRole('button', { name: /^Работа/ });
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(within(nav).getByRole('button', { name: /^Дейли/ })).toBeInTheDocument();
  expect(within(nav).getByText('Без группы')).toBeInTheDocument();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(within(nav).queryByRole('button', { name: /^Дейли/ })).not.toBeInTheDocument();
  expect(localStorage.getItem('cord:favorite-groups:collapsed:v1')).toBe('["work"]');
});

it('creates a group from the small button in the heading', async () => {
  const save = vi.spyOn(favoriteGroupApi, 'save').mockResolvedValue();
  const view = show();
  const nav = view.getByRole('navigation', { name: 'Избранное' });
  fireEvent.click(within(nav).getByRole('button', { name: 'Создать группу' }));
  const field = within(nav).getByRole('textbox', { name: 'Название новой группы' });
  fireEvent.change(field, { target: { value: 'Друзья' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ title: 'Друзья' })));
  expect(await within(nav).findByRole('button', { name: /^Друзья/ })).toBeInTheDocument();
});

it('manages a room from its menu: rename for oneself without leaving the list', async () => {
  const settings = vi.spyOn(favoriteGroupApi, 'settings').mockResolvedValue();
  const view = show();
  const nav = view.getByRole('navigation', { name: 'Избранное' });
  fireEvent.click(await within(nav).findByRole('button', { name: 'Действия с «Вечерний разговор»' }));
  fireEvent.click(await view.findByRole('menuitem', { name: /Переименовать у себя/ }));
  const field = await within(nav).findByRole('textbox', { name: 'Своё имя для «Вечерний разговор»' });
  fireEvent.change(field, { target: { value: 'Вечер с друзьями' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  await waitFor(() =>
    expect(settings).toHaveBeenCalledWith(room.roomId, {
      groupId: null,
      pinned: false,
      alias: 'Вечер с друзьями',
    }),
  );
  expect(await within(nav).findByRole('button', { name: /^Вечер с друзьями/ })).toBeInTheDocument();
});

it('marks the meeting running in another tab and brings it here on «Вернуться»', async () => {
  const admission = { roomId: room.roomId, participantId: 'p', credential: 'c' } as Admission;
  const handedOver = vi.fn();
  announceMeeting(
    { roomId: room.roomId, title: room.title, code: room.code },
    { admission: () => admission, onHandedOver: handedOver },
    'other-tab',
  );
  const view = show();
  const notice = await view.findByRole('region', { name: 'Вы во встрече в другой вкладке' });
  const nav = view.getByRole('navigation', { name: 'Избранное' });
  expect(await within(nav).findByText('вы здесь')).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(within(notice).getByRole('button', { name: /Вернуться во встречу/ }));
  });
  await waitFor(() => expect(view.onResume).toHaveBeenCalledWith(admission));
  expect(handedOver).toHaveBeenCalledOnce();
});

it('leaves desktop favorites to the native shell while keeping create available', async () => {
  const view = show(true);
  await waitFor(() => expect(publicApi.capabilities).toHaveBeenCalled());
  expect(view.queryByRole('navigation', { name: 'Избранное' })).not.toBeInTheDocument();
  fireEvent.click(view.getByRole('button', { name: 'Новая встреча' }));
  expect(view.onCreate).toHaveBeenCalledOnce();
});

it('explains why creation is unavailable without preventing invitation entry', async () => {
  vi.mocked(publicApi.capabilities).mockResolvedValue({ ...capabilities, admissionOpen: false });
  const view = show(true);
  const create = view.getByRole('button', { name: 'Новая встреча' });
  await waitFor(() => expect(create).toBeDisabled());
  expect(create).toHaveAccessibleDescription(/временно недоступно/i);
  expect(view.getByLabelText('Код встречи или ссылка')).toBeEnabled();
  expect(view.getByRole('button', { name: 'Присоединиться' })).toBeEnabled();
});

// T58: номер версии — только в «О программе». Внизу главной вместо него ссылка туда же.
it('leads to «О программе» from the footer without showing the version number', () => {
  const view = show();
  expect(view.getByRole('button', { name: 'О программе' })).toBeInTheDocument();
  expect(view.container.textContent).not.toContain(appVersion);
});

it('lets the sidebar be resized and remembers the width (T46)', () => {
  const view = show();
  const handle = view.getByRole('separator', { name: 'Ширина боковой панели' });
  expect(handle).toHaveAttribute('aria-valuenow', '280');
  fireEvent.keyDown(handle, { key: 'ArrowRight' });
  expect(handle).toHaveAttribute('aria-valuenow', '296');
  expect(localStorage.getItem('cord:panel:home-sidebar')).toBe('296');
});
