import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Watch } from '../api/types';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import { Stage } from './Stage';

/*
  Площадка, которой эта сборка не знает, не роняет встречу.

  Ядро пропускало `jellyfin`, которого в реестре нет, а вкладка, открытая до выкатки новой площадки,
  не знает её имени. «Каталог» на плеере ставил такую площадку сцене, `PROVIDERS[…]` отвечал
  `undefined`, отрисовка падала — и встреча становилась пустым экраном. Теперь у незнакомой площадки
  нет ни «Каталога», ни сцены, а плеер показывает отказ службы её же словами.
*/

const REFUSAL = 'Такой площадки в кинозале нет';

const watching = (provider: string): Watch =>
  ({
    provider,
    kind: 'video',
    contentId: 'abc',
    title: 'Фильм',
    openedBy: 'someone',
    paused: true,
    positionMs: 0,
    anchorAt: 0,
    revision: 1,
  }) as unknown as Watch;

function meeting(watch: Watch | null, browsing: string | null = null) {
  const cinema = new Store<string | null>(browsing);
  return {
    admission: { roomId: 'room', participantId: 'me', credential: 'token' },
    snapshot: new Store({ participants: [], integrationsAllowed: true, watch }),
    viewing: new Store(null),
    pinnedCamera: new Store(null),
    cinema,
    cinemaAt: new Store(null),
    media: {
      tracks: new Store([]),
      speaking: new Store([]),
      screenPreviews: new Store({}),
      preferences: new Store({ layout: 'grid', watchVolume: 70, watchAudio: '', watchSubtitles: '' }),
      saveSettings: vi.fn(),
      report: vi.fn(),
    },
    serverNow: () => Date.now(),
    command: vi.fn(() => Promise.resolve()),
    openCinema: vi.fn((next: string | null) => cinema.set(next)),
  } as unknown as Meeting & { openCinema: ReturnType<typeof vi.fn>; cinema: Store<string | null> };
}

beforeEach(() => {
  // Служба знает только свои площадки: о чужой она отвечает отказом, как `registry.get`.
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const known = String(init?.body ?? '').includes('"provider":"youtube"');
      if (!new URL(input, 'http://test').pathname.endsWith('/cinema/resolve') || known)
        return Promise.resolve(new Response('{}', { status: 404 }));
      return Promise.resolve(
        new Response(JSON.stringify({ detail: REFUSAL }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const stage = (room: Meeting) =>
  render(<Stage meeting={room} onOpenServices={() => {}} showServices={false} />);

it('комната смотрит незнакомую площадку: плеер говорит отказ службы, «Каталога» у него нет', async () => {
  const room = meeting(watching('jellyfin'));
  stage(room);
  expect(await screen.findByText(REFUSAL, undefined, { timeout: 5000 })).toBeVisible();
  expect(screen.getByRole('region', { name: 'Совместный просмотр' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Каталог' })).toBeNull();
});

it('знакомой площадке «Каталог» открывает её сцену, как и раньше', async () => {
  const room = meeting(watching('youtube'));
  stage(room);
  fireEvent.click(await screen.findByRole('button', { name: 'Каталог' }, { timeout: 5000 }));
  expect(room.openCinema).toHaveBeenCalledWith('youtube');
});

it('незнакомая площадка в каталоге — это не сцена: плеер остаётся, а без просмотра остаётся разговор', async () => {
  const room = meeting(watching('jellyfin'), 'jellyfin');
  const { container } = stage(room);
  expect(await screen.findByText(REFUSAL, undefined, { timeout: 5000 })).toBeVisible();
  expect(container.querySelector('.cinema-browser')).toBeNull();

  const quiet = meeting(null, 'jellyfin');
  cleanup();
  const again = stage(quiet);
  expect(again.container.querySelector('.conversation-stage')).not.toBeNull();
  expect(again.container.querySelector('.watch-together-stage')).toBeNull();
  // Закрыть такой каталог всё ещё можно — и тогда всё как было.
  act(() => quiet.cinema.set(null));
  expect(again.container.querySelector('.conversation-stage')).not.toBeNull();
});
