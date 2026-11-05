import { readFileSync } from 'node:fs';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Track } from 'livekit-client';
import type { Snapshot } from '../api/types';
import type { Meeting } from '../core/meeting';
import type { MediaTile } from '../media/session';
import { videoPool } from '../media/video-pool';
import { Store } from '../core/store';
import { Stage } from './Stage';

/*
  Камера на плитке (R189, И5): перенос плитки не пересоздаёт `<video>`, под ним всегда аватар, а видео
  открывается с первым кадром.
*/

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

const fakeTrack = () => ({
  kind: Track.Kind.Video,
  attach: vi.fn(),
  detach: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
});

const tile = (id: string, participantId: string, source: Track.Source) =>
  ({
    id,
    participantId,
    name: participantId,
    source,
    local: false,
    muted: false,
    track: fakeTrack(),
  }) as unknown as MediaTile;

function fakeMeeting(tracks: MediaTile[], layout = 'grid') {
  return {
    admission: { roomId: 'room', participantId: 'me', credential: 'token' },
    snapshot: new Store({
      participants: [
        person('me', 'Я'),
        person('ann', 'Аня', { screen: true, screenId: 'S1', screenStarted: true }),
      ],
      integrationsAllowed: true,
      watch: null,
      poker: null,
      durak: null,
    } as unknown as Snapshot),
    viewing: new Store<{ participantId: string; screenId: string } | null>(null),
    stageAway: new Store(null),
    pinnedCamera: new Store<string | null>(null),
    cinema: new Store(null),
    cinemaAt: new Store(null),
    media: {
      tracks: new Store(tracks),
      speaking: new Store<string[]>([]),
      screenPreviews: new Store({}),
      videoPaused: new Store<Record<string, string>>({}),
      volumes: new Store({}),
      preferences: new Store({ layout }),
      levels: { watch: () => () => {}, tier: () => 0 },
      setVolume: vi.fn(),
      toggleParticipantMute: vi.fn(),
    },
    screenPlaying: vi.fn(),
    command: vi.fn(() => Promise.resolve()),
  } as unknown as Meeting & {
    viewing: Store<{ participantId: string; screenId: string } | null>;
    pinnedCamera: Store<string | null>;
    media: { videoPaused: Store<Record<string, string>>; tracks: Store<MediaTile[]> };
  };
}

const tileOf = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('.person-tile')].find((element) =>
    element.querySelector('.person-caption')?.textContent?.startsWith(name),
  )!;

afterEach(() => {
  cleanup();
  videoPool.clear();
});

describe('один `<video>` на дорожку', () => {
  it('показ открылся и закрылся: плитка переехала в ленту и обратно, элемент тот же, attach один', () => {
    const camera = tile('TR_cam', 'ann', Track.Source.Camera);
    const meeting = fakeMeeting([camera]);
    render(<Stage meeting={meeting} />);
    const video = tileOf('Аня').querySelector('video.camera-video')!;
    expect(document.querySelector('.people-grid')!.contains(video)).toBe(true);

    act(() => meeting.viewing.set({ participantId: 'ann', screenId: 'S1' }));
    expect(document.querySelector('.presentation-strip')!.contains(video)).toBe(true);
    expect(tileOf('Аня').querySelector('video.camera-video')).toBe(video);

    act(() => meeting.viewing.set(null));
    expect(document.querySelector('.people-grid')!.contains(video)).toBe(true);
    expect(camera.track.attach).toHaveBeenCalledTimes(1);
    expect(camera.track.detach).not.toHaveBeenCalled();
  });

  it('закрепление: из сетки на крупное место — тот же элемент', () => {
    const camera = tile('TR_cam', 'ann', Track.Source.Camera);
    const meeting = fakeMeeting([camera]);
    render(<Stage meeting={meeting} />);
    const video = tileOf('Аня').querySelector('video.camera-video')!;
    act(() => meeting.pinnedCamera.set('ann'));
    expect(document.querySelector('.spotlight-main')!.contains(video)).toBe(true);
    expect(camera.track.attach).toHaveBeenCalledTimes(1);
  });

  it('камеру выключили: элемент уходит, дорожка отвязывается, остаётся аватар', () => {
    vi.useFakeTimers();
    try {
      const camera = tile('TR_cam', 'ann', Track.Source.Camera);
      const meeting = fakeMeeting([camera]);
      render(<Stage meeting={meeting} />);
      act(() => meeting.media.tracks.set([]));
      expect(tileOf('Аня').querySelector('video')).toBeNull();
      expect(tileOf('Аня').querySelector('.person-placeholder')).not.toBeNull();
      act(() => vi.advanceTimersByTime(5000));
      expect(camera.track.detach).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('переподписка той же публикации: новая дорожка, тот же элемент', () => {
    const camera = tile('TR_cam', 'ann', Track.Source.Camera);
    const meeting = fakeMeeting([camera]);
    render(<Stage meeting={meeting} />);
    const video = tileOf('Аня').querySelector('video.camera-video')!;
    const next = { ...camera, track: fakeTrack() } as unknown as MediaTile;
    act(() => meeting.media.tracks.set([next]));
    expect(tileOf('Аня').querySelector('video.camera-video')).toBe(video);
    expect(camera.track.detach).toHaveBeenCalledWith(video);
    expect(next.track.attach).toHaveBeenCalledWith(video);
  });

  it('подпись и зеркало — на переехавшем элементе; своя камера зеркальна', () => {
    const camera = { ...tile('TR_me', 'me', Track.Source.Camera), local: true, name: 'Я' };
    Object.assign(camera.track, { mediaStreamTrack: { getSettings: () => ({}) } });
    render(<Stage meeting={fakeMeeting([camera])} />);
    const video = tileOf('Я').querySelector<HTMLVideoElement>('video')!;
    expect(video.getAttribute('aria-label')).toBe('Камера: Я');
    expect(video.style.transform).toBe('scaleX(-1)');
  });
});

describe('чёрного нет', () => {
  it('под видео всегда аватар; с камерой он скрыт от читалки — плитку называет видео', () => {
    render(<Stage meeting={fakeMeeting([tile('TR_cam', 'ann', Track.Source.Camera)])} />);
    const placeholder = tileOf('Аня').querySelector('.person-placeholder')!;
    expect(placeholder.getAttribute('aria-hidden')).toBe('true');
    expect(placeholder.getAttribute('data-under')).toBe('true');
    expect(tileOf('Я').querySelector('.person-placeholder')!.getAttribute('aria-hidden')).toBeNull();
    // Аватар раньше видео в разметке: видео рисуется поверх него.
    const video = tileOf('Аня').querySelector('video')!;
    expect(placeholder.compareDocumentPosition(video) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('видео открывается с первым кадром; после переноса ждать его не надо', () => {
    const meeting = fakeMeeting([tile('TR_cam', 'ann', Track.Source.Camera)]);
    render(<Stage meeting={meeting} />);
    const video = tileOf('Аня').querySelector('video')!;
    expect(video.parentElement!.hasAttribute('data-frame')).toBe(false);
    act(() => {
      video.dispatchEvent(new Event('loadeddata'));
    });
    expect(video.parentElement!.hasAttribute('data-frame')).toBe(true);
    act(() => meeting.viewing.set({ participantId: 'ann', screenId: 'S1' }));
    expect(tileOf('Аня').querySelector('video')!.parentElement!.hasAttribute('data-frame')).toBe(true);
  });
});

describe('надпись', () => {
  it('«слабая связь» — только от SFU; причина неизвестна — другие слова', () => {
    const meeting = fakeMeeting([tile('TR_cam', 'ann', Track.Source.Camera)]);
    render(<Stage meeting={meeting} />);
    act(() => meeting.media.videoPaused.set({ TR_cam: 'silent' }));
    expect(within(tileOf('Аня')).getByText('Картинка не обновляется')).toBeVisible();
    expect(screen.queryByText('Видео приостановлено: слабая связь')).toBeNull();
    act(() => meeting.media.videoPaused.set({ TR_cam: 'sfu' }));
    expect(within(tileOf('Аня')).getByText('Видео приостановлено: слабая связь')).toBeVisible();
    expect(screen.queryByText('Картинка не обновляется')).toBeNull();
  });

  it('кадр под надписью не тускнеет: вуаль читалась как «камера гаснет»', () => {
    const css = readFileSync('src/ui/video-paused.css', 'utf8');
    expect(css).not.toMatch(/data-paused[^{]*\{[^}]*opacity/);
    expect(css).not.toContain('0.45');
  });
});
