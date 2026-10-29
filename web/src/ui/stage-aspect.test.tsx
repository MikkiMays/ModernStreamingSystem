import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Track } from 'livekit-client';
import type { Snapshot } from '../api/types';
import type { Meeting } from '../core/meeting';
import type { MediaTile } from '../media/session';
import { Store } from '../core/store';
import { Stage } from './Stage';

/*
  Пропорции плитки — по кадру, пока кадр есть, и обратно 16:10, как только его нет. Телефон шлёт
  портрет: плитка вытягивается под него, а после «камера выключена» на месте кадра аватар — и форма
  чужого портрета на нём остаться не должна.
*/

const person = (id: string, name: string) => ({
  id,
  name,
  avatar: '',
  status: 'CONNECTED',
  owner: false,
  generation: 0,
  recoveryDeadline: null,
  screen: false,
  service: null,
});

const camera = (participantId: string, muted = false) =>
  ({
    id: `TR_${participantId}`,
    participantId,
    name: participantId,
    source: Track.Source.Camera,
    local: false,
    muted,
    track: { kind: Track.Kind.Video, attach: vi.fn(), detach: vi.fn(), on: vi.fn(), off: vi.fn() },
  }) as unknown as MediaTile;

function fakeMeeting(tracks: MediaTile[]) {
  return {
    admission: { roomId: 'room', participantId: 'me', credential: 'token' },
    snapshot: new Store({
      participants: [person('me', 'Я'), person('ann', 'Аня')],
      integrationsAllowed: true,
      watch: null,
      poker: null,
      durak: null,
    } as unknown as Snapshot),
    viewing: new Store(null),
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
  } as unknown as Meeting & { media: { tracks: Store<MediaTile[]> } };
}

const tileOf = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('.person-tile')].find((tile) =>
    tile.querySelector('.person-caption')?.textContent?.startsWith(name),
  )!;

/** Кадр пришёл: у `<video>` появился размер, браузер шлёт `loadedmetadata`. */
function frame(tile: HTMLElement, width: number, height: number) {
  const video = tile.querySelector('video')!;
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: width });
  Object.defineProperty(video, 'videoHeight', { configurable: true, value: height });
  act(() => {
    video.dispatchEvent(new Event('loadedmetadata'));
  });
}

afterEach(cleanup);

describe('пропорции плитки', () => {
  it('портрет с телефона вытягивает плитку под кадр', () => {
    render(<Stage meeting={fakeMeeting([camera('ann')])} />);
    frame(tileOf('Аня'), 720, 1280);
    expect(tileOf('Аня').style.getPropertyValue('--tile-aspect')).toBe('720 / 1280');
  });

  it('камеру выключили — плитка возвращается к обычной форме', () => {
    const meeting = fakeMeeting([camera('ann')]);
    render(<Stage meeting={meeting} />);
    frame(tileOf('Аня'), 720, 1280);
    act(() => meeting.media.tracks.set([camera('ann', true)]));
    expect(tileOf('Аня').querySelector('video')).toBeNull();
    expect(tileOf('Аня').style.getPropertyValue('--tile-aspect')).toBe('');
  });

  it('дорожку сняли совсем — то же самое', () => {
    const meeting = fakeMeeting([camera('ann')]);
    render(<Stage meeting={meeting} />);
    frame(tileOf('Аня'), 720, 1280);
    act(() => meeting.media.tracks.set([]));
    expect(tileOf('Аня').style.getPropertyValue('--tile-aspect')).toBe('');
  });

  it('камеру включили снова — пропорции снова по новому кадру', () => {
    const meeting = fakeMeeting([camera('ann')]);
    render(<Stage meeting={meeting} />);
    frame(tileOf('Аня'), 720, 1280);
    act(() => meeting.media.tracks.set([camera('ann', true)]));
    act(() => meeting.media.tracks.set([camera('ann')]));
    frame(tileOf('Аня'), 1280, 720);
    expect(tileOf('Аня').style.getPropertyValue('--tile-aspect')).toBe('1280 / 720');
  });
});
