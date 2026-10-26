import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Track } from 'livekit-client';
import type { Snapshot } from '../api/types';
import type { Meeting } from '../core/meeting';
import type { MediaTile } from '../media/session';
import { Store } from '../core/store';
import { Stage } from './Stage';

/*
  Пауза видео от SFU (R117) на плитке и на показе. Задержку против мигания держит сессия
  (`media/video-pause.ts`), здесь — что и где видно, и старшинство: выключенная камера и «Подключаемся
  к стриму…» — паузы нет; переподключается участник — «Восстанавливаем связь…» вместо неё;
  «Готовится показ…» — про экран, живёт в середине и с паузой камеры не спорит.
*/

const PAUSED = 'Видео приостановлено: слабая связь';

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

const video = (id: string, participantId: string, source: Track.Source, muted = false) =>
  ({
    id,
    participantId,
    name: participantId,
    source,
    local: false,
    muted,
    track: { kind: Track.Kind.Video, attach: vi.fn(), detach: vi.fn(), on: vi.fn(), off: vi.fn() },
  }) as unknown as MediaTile;

function fakeMeeting({
  people = [person('me', 'Я'), person('ann', 'Аня')],
  tracks = [video('TR_cam', 'ann', Track.Source.Camera)],
  viewing = null,
}: {
  people?: ReturnType<typeof person>[];
  tracks?: MediaTile[];
  viewing?: { participantId: string; screenId: string } | null;
} = {}) {
  return {
    admission: { roomId: 'room', participantId: 'me', credential: 'token' },
    snapshot: new Store({
      participants: people,
      integrationsAllowed: true,
      watch: null,
      poker: null,
      durak: null,
    } as unknown as Snapshot),
    viewing: new Store(viewing),
    stageAway: new Store(null),
    pinnedCamera: new Store(null),
    cinema: new Store(null),
    cinemaAt: new Store(null),
    media: {
      tracks: new Store(tracks),
      speaking: new Store<string[]>([]),
      screenPreviews: new Store({}),
      videoPaused: new Store<Record<string, true>>({}),
      volumes: new Store({}),
      preferences: new Store({ layout: 'grid' }),
      levels: { watch: () => () => {}, tier: () => 0 },
      setVolume: vi.fn(),
      toggleParticipantMute: vi.fn(),
    },
    screenPlaying: vi.fn(),
    command: vi.fn(() => Promise.resolve()),
  } as unknown as Meeting & { media: { videoPaused: Store<Record<string, true>> } };
}

const tileOf = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('.person-tile')].find((tile) =>
    tile.querySelector('.person-caption')?.textContent?.startsWith(name),
  )!;

afterEach(cleanup);

describe('пауза камеры на плитке', () => {
  it('надпись и приглушённый кадр — пока пауза есть, и сразу гаснут с ней', () => {
    const meeting = fakeMeeting();
    render(<Stage meeting={meeting} />);
    expect(screen.queryByText(PAUSED)).toBeNull();
    act(() => meeting.media.videoPaused.set({ TR_cam: true }));
    expect(within(tileOf('Аня')).getByText(PAUSED)).toBeVisible();
    expect(tileOf('Аня').getAttribute('data-paused')).toBe('true');
    // Последний кадр остаётся под надписью — он приглушается, а не пропадает.
    expect(tileOf('Аня').querySelector('video.camera-video')).not.toBeNull();
    expect(tileOf('Я').getAttribute('data-paused')).toBeNull();
    act(() => meeting.media.videoPaused.set({}));
    expect(screen.queryByText(PAUSED)).toBeNull();
    expect(tileOf('Аня').getAttribute('data-paused')).toBeNull();
  });

  it('камера выключена — паузы не видно: приглушать нечего, на плитке аватар', () => {
    const meeting = fakeMeeting({ tracks: [video('TR_cam', 'ann', Track.Source.Camera, true)] });
    meeting.media.videoPaused.set({ TR_cam: true });
    render(<Stage meeting={meeting} />);
    expect(screen.queryByText(PAUSED)).toBeNull();
    expect(tileOf('Аня').getAttribute('data-paused')).toBeNull();
  });

  it('участник переподключается — «Восстанавливаем связь…» вместо паузы', () => {
    const meeting = fakeMeeting({
      people: [person('me', 'Я'), person('ann', 'Аня', { status: 'RECOVERING' })],
    });
    meeting.media.videoPaused.set({ TR_cam: true });
    render(<Stage meeting={meeting} />);
    expect(within(tileOf('Аня')).getByText('Восстанавливаем связь…')).toBeVisible();
    expect(screen.queryByText(PAUSED)).toBeNull();
    expect(tileOf('Аня').getAttribute('data-paused')).toBeNull();
  });

  it('«Готовится показ…» — про экран: с паузой камеры они рядом, а не вместо', () => {
    const meeting = fakeMeeting({
      people: [
        person('me', 'Я'),
        person('ann', 'Аня', { screen: true, screenId: 'S1', screenStarted: false }),
      ],
    });
    meeting.media.videoPaused.set({ TR_cam: true });
    render(<Stage meeting={meeting} />);
    expect(within(tileOf('Аня')).getByText('Готовится показ…')).toBeVisible();
    expect(within(tileOf('Аня')).getByText(PAUSED)).toBeVisible();
  });
});

describe('пауза показа', () => {
  const viewing = { participantId: 'ann', screenId: 'S1' };
  const sharing = person('ann', 'Аня', { screen: true, screenId: 'S1', screenStarted: true });

  it('надпись посередине кадра — объявляется; гаснет с паузой', () => {
    const meeting = fakeMeeting({
      people: [person('me', 'Я'), sharing],
      tracks: [video('TR_scr', 'ann', Track.Source.ScreenShare)],
      viewing,
    });
    render(<Stage meeting={meeting} />);
    act(() => meeting.media.videoPaused.set({ TR_scr: true }));
    expect(screen.getByRole('status')).toHaveTextContent(PAUSED);
    expect(document.querySelector('.watch-stage')!.getAttribute('data-paused')).toBe('true');
    act(() => meeting.media.videoPaused.set({}));
    expect(screen.queryByText(PAUSED)).toBeNull();
    expect(document.querySelector('.watch-stage')!.getAttribute('data-paused')).toBeNull();
  });

  it('кадра ещё нет — «Подключаемся к стриму…», паузы нет', () => {
    const meeting = fakeMeeting({ people: [person('me', 'Я'), sharing], tracks: [], viewing });
    meeting.media.videoPaused.set({ TR_scr: true });
    render(<Stage meeting={meeting} />);
    expect(screen.getByRole('status')).toHaveTextContent('Подключаемся к стриму…');
    expect(screen.queryByText(PAUSED)).toBeNull();
  });

  it('показывающий переподключается — паузы на его кадре не говорим', () => {
    const meeting = fakeMeeting({
      people: [person('me', 'Я'), { ...sharing, status: 'RECOVERING' }],
      tracks: [video('TR_scr', 'ann', Track.Source.ScreenShare)],
      viewing,
    });
    meeting.media.videoPaused.set({ TR_scr: true });
    render(<Stage meeting={meeting} />);
    expect(screen.queryByText(PAUSED)).toBeNull();
  });
});
