import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopGames } from '../../core/desktop-games';
import { desktopSettings } from '../../core/desktop-settings';
import { Settings } from '../Settings';

/*
  «Оверлей» (R62, R63, R104): игра сейчас и список игр с переключателями, «Забыть», «Добавить игру»,
  виджет говорящих — угол, размер, имена, прозрачность, — клавиша разблокировки и всплывашка. Всё живёт
  в оболочке: переключатель — запрос `app.settings` или `games.*`.
*/

const DAY = 86_400_000;
const values = {
  tray: true,
  thumbar: true,
  badge: true,
  flash: true,
  sleepBlocker: true,
  overlay: true,
  autostart: false,
  notifications: true,
  mini: true,
  overlayCorner: 'tl',
  overlaySize: 'm',
  overlayNames: 'always',
  overlayOpacity: 100,
  overlayToast: true,
};

function fakeDesktop(features: string[]) {
  let state = { ...values };
  let games = {
    games: [
      { exe: 'cs2.exe', name: 'Counter-Strike 2', enabled: true, firstSeen: 1, lastSeen: Date.now() },
      {
        exe: 'hollow_knight.exe',
        name: 'Hollow Knight',
        enabled: true,
        firstSeen: 1,
        lastSeen: Date.now() - 5 * DAY,
      },
    ],
    active: { exe: 'cs2.exe', name: 'Counter-Strike 2', enabled: true, exclusive: false },
  };
  const api = {
    protocol: { major: 2, minor: 0 },
    features,
    app: { version: '1.0.8', arch: 'x64' },
    bootstrap: {
      profile: 'x'.repeat(43),
      theme: 'system',
      showPing: false,
      notificationSounds: true,
      autoConnect: true,
    },
    send: vi.fn(),
    invoke: vi.fn(async (method: string, payload?: Record<string, unknown>) => {
      if (method === 'app.settings') {
        state = { ...state, ...(payload as Partial<typeof values>) };
        return state;
      }
      if (method === 'games.list') return games;
      if (method === 'games.set')
        games = {
          ...games,
          games: games.games.map((game) =>
            game.exe === payload!.exe ? { ...game, enabled: payload!.enabled as boolean } : game,
          ),
        };
      if (method === 'games.forget')
        games = { ...games, games: games.games.filter((game) => game.exe !== payload!.exe) };
      if (method === 'games.pick')
        games = {
          ...games,
          games: [
            ...games.games,
            { exe: 'indie.exe', name: 'indie', enabled: true, firstSeen: 1, lastSeen: 0 },
          ],
        };
      return games;
    }),
    on: vi.fn(() => () => {}),
  };
  (window as unknown as { cordDesktop?: unknown }).cordDesktop = api;
  return api;
}

const ALL = [
  'hotkeys',
  'ptt',
  'app.settings',
  'tray',
  'sleep',
  'overlay',
  'overlay.widget',
  'games',
  'golive',
  'mini',
];

beforeEach(() => {
  localStorage.clear();
  desktopSettings.set(null);
  desktopGames.set(null);
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { cordDesktop?: unknown }).cordDesktop;
});

describe('«Оверлей» в настройках', () => {
  it('игра сейчас, список игр с последним запуском; переключатель игры и «Забыть» — запросы к оболочке', async () => {
    const api = fakeDesktop(ALL);
    render(<Settings open section="overlay" onOpenChange={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByText('Сейчас активно')).toBeInTheDocument();
    expect(screen.getAllByText('Запущена сейчас').length).toBeGreaterThan(0);
    expect(screen.getByText(/Последний запуск 5 дней назад/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('switch', { name: 'Оверлей над «Counter-Strike 2»' })[0]!);
    await act(async () => {});
    expect(api.invoke).toHaveBeenCalledWith('games.set', { exe: 'cs2.exe', enabled: false });
    fireEvent.click(screen.getByRole('button', { name: 'Ещё для «Hollow Knight»' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Забыть' }));
    await act(async () => {});
    expect(api.invoke).toHaveBeenCalledWith('games.forget', { exe: 'hollow_knight.exe' });
    expect(screen.queryByText('Hollow Knight')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Добавить игру' }));
    await act(async () => {});
    expect(api.invoke).toHaveBeenCalledWith('games.pick', {});
    expect(screen.getByText('indie')).toBeInTheDocument();
  });

  it('виджет говорящих: угол, размер и имена — значения оболочки; клавиша разблокировки — Shift + `', async () => {
    const api = fakeDesktop(ALL);
    render(<Settings open section="overlay" onOpenChange={vi.fn()} />);
    await act(async () => {});
    const corner = screen.getByRole('radiogroup', { name: 'Положение' });
    fireEvent.click(within(corner).getByRole('radio', { name: 'Справа снизу' }));
    await act(async () => {});
    expect(api.invoke).toHaveBeenLastCalledWith('app.settings', { overlayCorner: 'br' });
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'Размер аватара' })).getByRole('radio', {
        name: 'Большой',
      }),
    );
    await act(async () => {});
    expect(api.invoke).toHaveBeenLastCalledWith('app.settings', { overlaySize: 'l' });
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'Имена' })).getByRole('radio', { name: 'Когда говорит' }),
    );
    await act(async () => {});
    expect(api.invoke).toHaveBeenLastCalledWith('app.settings', { overlayNames: 'speaking' });
    expect(screen.getByRole('slider', { name: 'Прозрачность' })).toHaveValue('100');
    expect(screen.getByRole('switch', { name: 'Всплывашка при старте игры' })).toBeChecked();
    const lock =
      document.getElementById('settings-row-overlay-lock-hotkey') ??
      screen.getByText('Разблокировать оверлей').closest('.setting-row')!;
    expect(lock).toHaveTextContent('Shift');
    expect(lock).toHaveTextContent('`');
  });

  it('оболочка 1.0.7 (без overlay.widget и games) — только переключатель и клавиша оверлея', async () => {
    fakeDesktop(['hotkeys', 'app.settings', 'overlay']);
    render(<Settings open section="overlay" onOpenChange={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByRole('switch', { name: 'Оверлей в играх' })).toBeInTheDocument();
    expect(screen.queryByText('Сейчас активно')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Положение' })).toBeNull();
    expect(screen.queryByText('Разблокировать оверлей')).toBeNull();
  });

  it('«Windows»: мини-окно звонка — переключатель оболочки (R93)', async () => {
    const api = fakeDesktop(ALL);
    render(<Settings open section="desktop" onOpenChange={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('switch', { name: 'Мини-окно звонка' }));
    await act(async () => {});
    expect(api.invoke).toHaveBeenLastCalledWith('app.settings', { mini: false });
  });
});
