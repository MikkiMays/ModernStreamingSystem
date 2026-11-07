import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Store } from './core/store';
import { maintenance, noteCapabilities, noteRefused } from './core/maintenance';

/*
  Страница работ в приложении (R194). Главное здесь — что остаётся смонтированным: за страницей не
  должно идти ничего с камерой и микрофоном, а живая встреча не должна потеряться без `dispose`.
*/
const stubs = vi.hoisted(() => ({
  capabilities: vi.fn(),
  prejoinMounts: 0,
  lastPrejoin: null as null | { onJoin: (admission: unknown, choices: unknown) => void },
  meetings: [] as { ended: Store<string | null>; dispose: ReturnType<typeof vi.fn> }[],
}));
vi.mock('./api/client', async (original) => ({
  ...(await original<typeof import('./api/client')>()),
  publicApi: { capabilities: stubs.capabilities },
}));
vi.mock('./core/session', async (original) => {
  const { Store } = await import('./core/store');
  return {
    ...(await original<typeof import('./core/session')>()),
    session: new Store({ token: 't', expiresAt: 4102444800, name: '', passwordRequired: false }),
    greetHostConnection: () => {},
  };
});
vi.mock('./ui/Home', async (original) => ({
  ...(await original<typeof import('./ui/Home')>()),
  Home: ({ onJoin }: { onJoin: (destination: unknown) => void }) => (
    <div>
      главная
      <button onClick={() => onJoin({ kind: 'favorite', favorite: { roomId: 'r', title: 'Избранная' } })}>
        из избранного
      </button>
      <button onClick={() => onJoin({ kind: 'code', code: '123456789' })}>по коду</button>
    </div>
  ),
}));
vi.mock('./ui/Prejoin', async () => {
  const { useEffect } = await import('react');
  return {
    Prejoin: (props: { onJoin: (admission: unknown, choices: unknown) => void }) => {
      useEffect(() => {
        stubs.prejoinMounts += 1;
      }, []);
      stubs.lastPrejoin = props;
      return <div>предвход</div>;
    },
  };
});
vi.mock('./core/meeting', async () => {
  const { Store } = await import('./core/store');
  return {
    Meeting: class {
      ended = new Store<string | null>(null);
      snapshot = new Store({});
      dispose = vi.fn();
      constructor(readonly admission: unknown) {
        stubs.meetings.push(this as never);
      }
    },
  };
});
vi.mock('./ui/MeetingView', () => ({ MeetingView: () => <div>встреча идёт</div> }));
vi.mock('./ui/useMeetingBeacon', () => ({ useMeetingBeacon: () => {} }));
vi.mock('./ui/support/HelpHost', () => ({ HelpHost: () => null }));

const { default: App } = await import('./App');
const notice = () => ({
  phase: 'active' as const,
  startsAt: 1,
  endsAt: Date.now() + 3600000,
  expiresAt: Date.now() + 7200000,
});

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
  stubs.prejoinMounts = 0;
  stubs.meetings.length = 0;
  noteCapabilities({});
  stubs.capabilities.mockReset();
  stubs.capabilities.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  noteCapabilities({});
});

const title = () => screen.queryByRole('heading', { name: 'Идут технические работы' });

it('окно идёт — страница работ вместо главной; окно кончилось — главная без перезагрузки', async () => {
  render(<App />);
  await screen.findByText('главная');
  act(() => noteCapabilities({ maintenanceWindow: notice() }));
  expect(title()).toBeInTheDocument();
  expect(screen.queryByText('главная')).not.toBeInTheDocument();
  act(() => noteCapabilities({}));
  expect(title()).not.toBeInTheDocument();
  expect(screen.getByText('главная')).toBeInTheDocument();
});

it('окно заранее ничего не показывает', async () => {
  render(<App />);
  await screen.findByText('главная');
  act(() =>
    noteCapabilities({
      maintenanceWindow: {
        phase: 'scheduled',
        startsAt: Date.now() + 3600000,
        expiresAt: Date.now() + 7200000,
      },
    }),
  );
  expect(title()).not.toBeInTheDocument();
  expect(screen.getByText('главная')).toBeInTheDocument();
});

it('приложение само спрашивает возможности при запуске и открывает страницу по их ответу', async () => {
  stubs.capabilities.mockImplementation(async () => {
    noteCapabilities({ maintenanceWindow: notice() });
  });
  render(<App />);
  await waitFor(() => expect(title()).toBeInTheDocument());
});

it('предвход за страницей не живёт: камера не должна работать за спиной у человека', async () => {
  render(<App />);
  await screen.findByText('главная');
  act(() => screen.getByText('по коду').click());
  await screen.findByText('предвход');
  act(() => noteRefused());
  expect(title()).toBeInTheDocument();
  expect(screen.queryByText('предвход')).not.toBeInTheDocument();
  // Вход по коду человек затеял сам и ничего не включается без него: предвход просто возвращается.
  act(() => noteCapabilities({}));
  expect(screen.getByText('предвход')).toBeInTheDocument();
});

it('из избранного после окна — на главную, а не на предвход: автовход не включит микрофон сам', async () => {
  render(<App />);
  await screen.findByText('главная');
  act(() => screen.getByText('из избранного').click());
  await screen.findByText('предвход');
  act(() => noteRefused());
  act(() => noteCapabilities({}));
  expect(screen.queryByText('предвход')).not.toBeInTheDocument();
  expect(screen.getByText('главная')).toBeInTheDocument();
});

it('встреча под страницей остаётся смонтированной, а кончившаяся после окна ведёт на главную', async () => {
  render(<App />);
  await screen.findByText('главная');
  act(() => screen.getByText('по коду').click());
  await screen.findByText('предвход');
  await act(async () => {
    stubs.lastPrejoin!.onJoin({ roomId: '11111111-2222-3333-4444-555555555555', snapshot: {} }, {});
  });
  await screen.findByText('встреча идёт');
  const room = stubs.meetings[0]!;

  act(() => noteCapabilities({ maintenanceWindow: notice() }));
  expect(title()).toBeInTheDocument();
  expect(screen.getByText('встреча идёт')).toBeInTheDocument();
  expect(room.dispose).not.toHaveBeenCalled();

  act(() => {
    room.ended.set('Встреча завершена');
    noteCapabilities({});
  });
  expect(title()).not.toBeInTheDocument();
  expect(room.dispose).toHaveBeenCalled();
  expect(screen.getByText('главная')).toBeInTheDocument();
  expect(maintenance.get()).toBeNull();
});
