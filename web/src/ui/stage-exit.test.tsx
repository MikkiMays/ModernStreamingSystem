import { act, cleanup, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot, Watch } from '../api/types';
import type { Meeting } from '../core/meeting';
import type { StageKind } from '../core/stage-view';
import { Store } from '../core/store';
import { Stage } from './Stage';

/*
  Выход из интеграции к участникам (R121). Интеграция идёт для всех, а зритель уходит смотреть людей и
  возвращается. Главное здесь — что слой интеграции при этом не рождается заново: кинозал — это `<video>` с
  буфером и синхронностью, стол — звук хода, открытый лист и выбранная карта. Плеер и столы подменены
  счётчиками: сколько раз они родились, столько и было бы перезагрузок.
*/

const mounts = vi.hoisted(() => ({ theater: 0, poker: 0, chess: 0 }));
vi.mock('./cinema/theater/WatchTheater', () => ({
  default: function FakeTheater() {
    useEffect(() => {
      mounts.theater++;
    }, []);
    return (
      <section className="watch-theater">
        <video className="watch-video" />
      </section>
    );
  },
}));
vi.mock('./PokerTable', () => ({
  default: function FakePoker() {
    useEffect(() => {
      mounts.poker++;
    }, []);
    return <div className="poker" />;
  },
}));
vi.mock('./ChessTable', () => ({
  default: function FakeChess() {
    useEffect(() => {
      mounts.chess++;
    }, []);
    return <section className="chess" />;
  },
}));

const person = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  avatar: '',
  status: 'CONNECTED',
  owner: false,
  generation: 0,
  recoveryDeadline: null,
  screen: false,
  service: null,
  ...extra,
});

const film = { provider: 'youtube', kind: 'video', contentId: 'abc', title: 'Фильм' } as unknown as Watch;

function fakeMeeting(room: Partial<Snapshot>) {
  const stageAway = new Store<StageKind | null>(null);
  const viewing = new Store<{ screenId: string; participantId: string } | null>(null);
  const snapshot = new Store({
    participants: [person('me', 'Я'), person('ann', 'Аня'), person('misha', 'Миша')],
    integrationsAllowed: true,
    watch: null,
    poker: null,
    durak: null,
    ...room,
  } as unknown as Snapshot);
  const kind = (): StageKind | null => {
    const now = snapshot.get();
    return now.chess ? 'chess' : now.poker ? 'poker' : now.watch ? 'cinema' : null;
  };
  return {
    admission: { roomId: 'room', participantId: 'me', credential: 'token' },
    snapshot,
    viewing,
    pinnedCamera: new Store(null),
    cinema: new Store(null),
    cinemaAt: new Store(null),
    stageAway,
    media: {
      tracks: new Store([]),
      speaking: new Store<string[]>([]),
      screenPreviews: new Store({}),
      videoPaused: new Store({}),
      volumes: new Store({}),
      preferences: new Store({ layout: 'grid' }),
      levels: { watch: () => () => {}, tier: () => 0 },
      setVolume: vi.fn(),
      toggleParticipantMute: vi.fn(),
    },
    leaveStage: vi.fn(() => stageAway.set(kind())),
    returnToStage: vi.fn(() => stageAway.set(null)),
    pinCamera: vi.fn(),
    unpinCamera: vi.fn(),
    openStream: vi.fn(),
    openCinema: vi.fn(),
    serverNow: () => Date.now(),
    command: vi.fn(() => Promise.resolve()),
  } as unknown as Meeting & {
    stageAway: Store<StageKind | null>;
    viewing: Store<{ screenId: string; participantId: string } | null>;
    snapshot: Store<Snapshot>;
  };
}

const layer = () => document.querySelector<HTMLElement>('[data-stage-layer]');

beforeEach(() => {
  mounts.theater = 0;
  mounts.poker = 0;
  mounts.chess = 0;
});
afterEach(cleanup);

describe('слой интеграции не рождается заново', () => {
  it('кинозал: ушёл к участникам и вернулся — тот же плеер и тот же `<video>`', async () => {
    const room = fakeMeeting({ watch: film });
    render(<Stage meeting={room} />);
    const before = await vi.waitFor(() => {
      const element = document.querySelector('video.watch-video');
      if (!element) throw new Error('плеер ещё грузится');
      return element;
    });
    // В кинозале лица — лентой под плеером.
    expect(document.querySelectorAll('.watch-together-stage .people-strip .person-tile')).toHaveLength(3);

    act(() => room.stageAway.set('cinema'));
    expect(document.querySelector('video.watch-video')).toBe(before);
    expect(layer()).toHaveAttribute('data-away', 'true');
    expect(layer()).toHaveAttribute('aria-hidden', 'true');
    expect(layer()).toHaveAttribute('inert');
    // У ушедшего — обычная встреча: сетка со всеми, а лента под спрятанным плеером пуста.
    expect(document.querySelectorAll('.people-grid .person-tile')).toHaveLength(3);
    expect(layer()!.querySelectorAll('.person-tile')).toHaveLength(0);

    act(() => room.stageAway.set(null));
    expect(document.querySelector('video.watch-video')).toBe(before);
    expect(layer()).not.toHaveAttribute('data-away');
    expect(document.querySelector('.people-grid')).toBeNull();
    expect(mounts.theater).toBe(1);
  });

  it('чужой экран поверх кинозала — плеер прячется, но остаётся тем же', async () => {
    const room = fakeMeeting({
      watch: film,
      participants: [
        person('me', 'Я'),
        person('ann', 'Аня', { screen: true, screenId: 's1', screenStarted: true }),
      ] as unknown as Snapshot['participants'],
    });
    render(<Stage meeting={room} />);
    const before = await vi.waitFor(() => {
      const element = document.querySelector('video.watch-video');
      if (!element) throw new Error('плеер ещё грузится');
      return element;
    });
    act(() => room.viewing.set({ screenId: 's1', participantId: 'ann' }));
    expect(document.querySelector('.watch-stage')).not.toBeNull();
    expect(layer()).toHaveAttribute('data-away', 'true');
    act(() => room.viewing.set(null));
    expect(document.querySelector('video.watch-video')).toBe(before);
    expect(mounts.theater).toBe(1);
  });

  it('стол покера остаётся в документе спрятанным, у ушедшего — все в сетке', async () => {
    const room = fakeMeeting({
      poker: { seats: [{ memberId: 'me' }, { memberId: 'ann' }] } as unknown as Snapshot['poker'],
    });
    render(<Stage meeting={room} />);
    await vi.waitFor(() => {
      if (!document.querySelector('.poker')) throw new Error('стол ещё грузится');
    });
    act(() => room.stageAway.set('poker'));
    expect(document.querySelector('.poker')).not.toBeNull();
    expect(layer()).toHaveAttribute('data-away', 'true');
    expect(document.querySelectorAll('.people-grid .person-tile')).toHaveLength(3);
    act(() => room.stageAway.set(null));
    expect(mounts.poker).toBe(1);
  });

  it('шахматы: людей у стола не видно вовсе — а у ушедшего видно всех', async () => {
    const room = fakeMeeting({ chess: { white: null, black: null } as unknown as Snapshot['chess'] });
    render(<Stage meeting={room} />);
    await vi.waitFor(() => {
      if (!document.querySelector('.chess')) throw new Error('доска ещё грузится');
    });
    expect(document.querySelectorAll('.person-tile')).toHaveLength(0);
    act(() => room.stageAway.set('chess'));
    expect(document.querySelectorAll('.people-grid .person-tile')).toHaveLength(3);
    expect(mounts.chess).toBe(1);
  });

  it('сцена свободна — слоя интеграции нет, обычная сетка', () => {
    render(<Stage meeting={fakeMeeting({})} />);
    expect(layer()).toBeNull();
    expect(document.querySelectorAll('.people-grid .person-tile')).toHaveLength(3);
  });
});
