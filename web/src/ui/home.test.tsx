import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publicApi } from '../api/client';
import { favoriteApi, type Favorite } from '../core/favorites';
import { Home } from './Home';
import { DesktopHome } from './DesktopHome';
import { appVersion } from '../core/version';

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
const capabilities = {
  admissionOpen: true,
  fileMaxBytes: 1000000,
  frameRates: [30, 60],
  maxParticipants: 20,
  maxScreens: 2,
  name: 'Cord',
  passwordRequired: false,
  recoverySeconds: 20,
  region: 'local',
  resolutions: [720, 1080],
  roomMaxBytes: 10000000,
  quality: {
    default: { resolution: 720, fps: 30 },
    ceiling: { resolution: 1080, fps: 60 },
    settleMs: 4000,
    cameraYieldsToScreen: false,
  },
  favoritesMax: 10,
};
const clients: QueryClient[] = [];

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(publicApi, 'capabilities').mockResolvedValue(capabilities);
  vi.spyOn(favoriteApi, 'list').mockResolvedValue([room]);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

function show(desktop = false) {
  const onJoin = vi.fn();
  const onCreate = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      {desktop ? (
        <DesktopHome onCreate={onCreate} onJoin={onJoin} onSettings={() => {}} />
      ) : (
        <Home onCreate={onCreate} onJoin={onJoin} theme="light" setTheme={() => {}} />
      )}
    </QueryClientProvider>,
  );
  return { ...view, onJoin, onCreate };
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

it('keeps browser favorites out of the main content and opens saved rooms through the header dialog', async () => {
  const view = show();
  expect(within(view.getByRole('main')).queryByText(room.title)).not.toBeInTheDocument();
  fireEvent.click(view.getByRole('button', { name: 'Избранные комнаты' }));
  const dialog = await view.findByRole('dialog', { name: 'Избранные комнаты' });
  fireEvent.click(await within(dialog).findByRole('button', { name: /^Вечерний разговор/ }));
  expect(view.onJoin).toHaveBeenCalledWith({ kind: 'favorite', favorite: room });
  await waitFor(() => expect(view.queryByRole('dialog')).not.toBeInTheDocument());
});

it('leaves desktop favorites to the native shell while keeping create available', async () => {
  const view = show(true);
  await waitFor(() => expect(publicApi.capabilities).toHaveBeenCalled());
  expect(view.queryByRole('region', { name: 'Избранные комнаты' })).not.toBeInTheDocument();
  expect(view.queryByRole('button', { name: 'Открыть избранное' })).not.toBeInTheDocument();
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
