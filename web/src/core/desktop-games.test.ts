// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
  Игры клиента Windows (R62): ответ оболочки — без доверия, переключатель — сразу на экране и запросом,
  отказ возвращает прежнее значение; события оболочки обновляют реестр и игру «сейчас».
*/

function fakeDesktop(invoke: (method: string, payload?: Record<string, unknown>) => Promise<unknown>) {
  const listeners = new Map<string, Set<(data: Record<string, unknown>) => void>>();
  const api = {
    protocol: { major: 2, minor: 0 },
    features: ['games'],
    app: { version: '1.0.8', arch: 'x64' },
    bootstrap: {
      profile: 'x'.repeat(43),
      theme: 'system',
      showPing: false,
      notificationSounds: true,
      autoConnect: true,
    },
    send: vi.fn(),
    invoke: vi.fn(invoke),
    on: vi.fn((type: string, listener: (data: Record<string, unknown>) => void) => {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(listener);
      return () => void set?.delete(listener);
    }),
    emit(type: string, data: Record<string, unknown>) {
      for (const listener of listeners.get(type) ?? []) listener(data);
    },
  };
  (window as unknown as { cordDesktop?: unknown }).cordDesktop = api;
  return api;
}

const cs2 = { exe: 'cs2.exe', name: 'Counter-Strike 2', enabled: true, lastSeen: 5 };

afterEach(() => {
  delete (window as unknown as { cordDesktop?: unknown }).cordDesktop;
  vi.resetModules();
});

describe('desktop-games', () => {
  it('ответ без доверия: только exe, имя ≤ 80, игра «сейчас» — по exe', async () => {
    const { parseDesktopGames } = await import('./desktop-games');
    expect(
      parseDesktopGames({
        games: [cs2, { exe: '../evil', name: 'x' }, { exe: 'indie.exe', name: 'y'.repeat(100) }, null],
        active: { exe: 'cs2.exe', name: 'Counter-Strike 2', exclusive: true },
      }),
    ).toEqual({
      games: [cs2, { exe: 'indie.exe', name: 'y'.repeat(80), enabled: true, lastSeen: 0 }],
      active: { exe: 'cs2.exe', name: 'Counter-Strike 2', enabled: true, exclusive: true },
    });
    expect(parseDesktopGames({ games: 'нет' })).toBeNull();
    expect(parseDesktopGames({ games: [], active: { exe: 'notes' } })).toEqual({ games: [], active: null });
  });

  it('переключатель — сразу на экране; оболочка отказала — прежнее значение', async () => {
    let fail = false;
    fakeDesktop(async (method, payload) => {
      if (method === 'games.set' && fail) throw new Error('Недоступно.');
      return { games: [{ ...cs2, enabled: method === 'games.set' ? payload!.enabled : true }], active: null };
    });
    const games = await import('./desktop-games');
    await games.loadDesktopGames();
    await games.setDesktopGame('cs2.exe', false);
    expect(games.desktopGames.get()!.games[0]!.enabled).toBe(false);
    fail = true;
    await games.setDesktopGame('cs2.exe', true);
    expect(games.desktopGames.get()!.games[0]!.enabled).toBe(false);
  });

  it('события оболочки: games.changed — реестр, game.active — игра «сейчас»', async () => {
    const api = fakeDesktop(async () => ({ games: [cs2], active: null }));
    const games = await import('./desktop-games');
    await games.loadDesktopGames();
    const stop = games.watchDesktopGames();
    api.emit('game.active', {
      game: { exe: 'cs2.exe', name: 'Counter-Strike 2', enabled: true, exclusive: false },
    });
    expect(games.desktopGames.get()!.active).toMatchObject({ exe: 'cs2.exe' });
    api.emit('games.changed', { games: [], active: null });
    expect(games.desktopGames.get()).toEqual({ games: [], active: null });
    stop();
  });

  it('без флага games — ничего не спрашивает', async () => {
    const api = fakeDesktop(async () => ({ games: [], active: null }));
    (api as { features: string[] }).features = ['overlay'];
    const games = await import('./desktop-games');
    expect(await games.loadDesktopGames()).toBeNull();
    expect(api.invoke).not.toHaveBeenCalled();
  });
});
