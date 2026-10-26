import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../api/types';
import type { Meeting } from '../core/meeting';
import { readPreferences } from '../core/preferences';
import type { MusicState } from '../core/services';
import { Store } from '../core/store';
import { t } from '../i18n';
import { IntegrationBarSlot } from './IntegrationBar';
import { StageOverlay, stageChips } from './StageOverlay';

/*
  Активные интеграции — полупрозрачными чипами поверх звонка справа сверху (R30), а не отдельной
  колонкой рядом с сеткой: видно, что идёт игра, кино или музыка, и сцена не теряет ширину.
*/

const person = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  status: 'CONNECTED',
  ...extra,
});
const snapshot = (extra: Record<string, unknown> = {}) =>
  ({
    participants: [person('me')],
    watch: null,
    poker: null,
    durak: null,
    chess: null,
    gartic: null,
    ...extra,
  }) as unknown as Snapshot;
const music = (extra: Partial<MusicState> = {}): MusicState => ({
  roomId: 'room',
  enabled: true,
  paused: false,
  position: 0,
  revision: 1,
  status: 'playing',
  error: null,
  participantId: 'bot',
  repeat: false,
  queue: [{ id: 't', title: 'Put On', artist: 'Young Jeezy', source: 'youtube' } as MusicState['queue'][0]],
  ...extra,
});

describe('чипы интеграций по снимку', () => {
  it('ничего не идёт — чипов нет', () => {
    expect(stageChips(t, snapshot(), { present: false })).toEqual([]);
  });

  it('покер — сколько за столом, кинозал — что смотрят', () => {
    const chips = stageChips(
      t,
      snapshot({
        poker: { seats: [{ memberId: 'me' }, { memberId: 'ann' }, { memberId: null }] },
        watch: { provider: 'youtube', title: 'Фильм' },
      }),
      { present: false },
    );
    expect(chips.map((chip) => [chip.kind, chip.label])).toEqual([
      ['poker', 'Покер · 2 за столом'],
      ['cinema', 'Фильм'],
    ]);
    expect(chips[1]!.title).toBe('Кинозал: Фильм');
  });

  it('чипа того, что занимает сцену, нет никогда: в интеграции он повторял бы её, у ушедшего — чёлку (R121)', () => {
    const room = snapshot({
      poker: { seats: [{ memberId: 'me' }] },
      watch: { provider: 'youtube', title: 'Фильм' },
    });
    expect(stageChips(t, room, { present: true, state: music() }, 'poker').map((chip) => chip.kind)).toEqual([
      'cinema',
      'music',
    ]);
  });

  it('шахматы и Gartic — по игрокам; кинозал без названия — словом «Кинозал»', () => {
    const chips = stageChips(
      t,
      snapshot({
        chess: { white: { memberId: 'me' }, black: null },
        gartic: { players: [{ memberId: 'a' }, { memberId: 'b' }, { memberId: 'c' }] },
        watch: { provider: 'link', title: null },
      }),
      { present: false },
    );
    expect(chips.map((chip) => chip.label)).toEqual([
      'Шахматы · 1 за столом',
      'Gartic · 3 за столом',
      'Кинозал',
    ]);
  });

  it('музыка играет — название трека и эквалайзер; на паузе — состояние словами', () => {
    expect(stageChips(t, snapshot(), { present: true, state: music() })).toEqual([
      { kind: 'music', label: 'Put On', title: 'Музыка: Put On — Young Jeezy', playing: true },
    ]);
    const paused = stageChips(t, snapshot(), {
      present: true,
      state: music({ paused: true, status: 'paused' }),
    });
    expect(paused[0]).toMatchObject({ label: 'Музыка · На паузе', playing: false });
    const empty = stageChips(t, snapshot(), { present: true, state: music({ status: 'idle', queue: [] }) });
    expect(empty[0]!.label).toBe('Музыка · Очередь пуста');
  });
});

function fakeMeeting(initial: Snapshot) {
  return {
    admission: { roomId: 'room', participantId: 'me', credential: 'token' },
    snapshot: new Store(initial),
    viewing: new Store(null),
    stageAway: new Store(null),
    cinema: new Store(null),
    ended: new Store<string | null>(null),
    media: {
      preferences: new Store(readPreferences()),
      saveSettings: vi.fn(),
      volumes: new Store({}),
      setVolume: vi.fn(),
      musicPlayoutMs: () => 0,
    },
  } as unknown as Meeting & { snapshot: Store<Snapshot> };
}

function show(meeting: Meeting, onOpen = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StageOverlay meeting={meeting} onOpenServices={onOpen} />
    </QueryClientProvider>,
  );
  return onOpen;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('слой поверх сцены', () => {
  it('без интеграций — пустой и скрыт от диктора', () => {
    show(fakeMeeting(snapshot()));
    const layer = document.querySelector('.stage-overlay')!;
    expect(layer).toBeEmptyDOMElement();
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('музыкальный бот во встрече — мини-плеер, а не чип панели; стол спрятан — плеер на слое сцены, чипа стола нет', async () => {
    // Служба музыки отвечает тем же, что видит панель интеграций.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(music()), { status: 200 }))),
    );
    // Смотрят чужой экран — стол спрятан (R121): его место в шапке есть, но мини-плеер туда не идёт.
    const room = fakeMeeting(
      snapshot({
        participants: [person('me'), person('bot', { service: 'music' })],
        durak: { seats: [{ memberId: 'me' }] },
      }),
    );
    (room as unknown as { viewing: Store<unknown> }).viewing.set({ screenId: 's', participantId: 'ann' });
    render(<IntegrationBarSlot />);
    show(room);
    const region = screen.getByRole('region', { name: 'Боты и интеграции' });
    const bar = await screen.findByRole('group', { name: 'Мини-плеер' });
    expect(region).toContainElement(bar);
    await waitFor(() => expect(bar.textContent).toContain('Put On'));
    expect(region.querySelector('.stage-chip')).toBeNull();
  });

  it('игра началась, пока смотрят чужой экран, — чипа нет: игру показывает чёлка', () => {
    const meeting = fakeMeeting(snapshot());
    (meeting as unknown as { viewing: Store<unknown> }).viewing.set({ screenId: 's', participantId: 'ann' });
    show(meeting);
    expect(screen.queryByRole('button')).toBeNull();
    act(() =>
      meeting.snapshot.set(snapshot({ durak: { seats: [{ memberId: 'me' }, { memberId: 'ann' }] } })),
    );
    expect(screen.queryByRole('button', { name: 'Дурак · 2 за столом' })).toBeNull();
  });
});
