import { beforeEach, expect, it, vi } from 'vitest';
import { attachDash } from './dash';

const mock = vi.hoisted(() => {
  const listeners = new Map<string, () => void>();
  const representations = [
    { id: 'hd', height: 1080, bandwidth: 4e6, codecs: 'avc1.64002a', frameRate: 60 },
    { id: 'qhd', height: 1440, bandwidth: 6e6, codecs: 'av01.0.12M.08', frameRate: 60 },
  ];
  const player = {
    updateSettings: vi.fn(),
    initialize: vi.fn(),
    reset: vi.fn(),
    setInitialMediaSettingsFor: vi.fn(),
    setCustomInitialTrackSelectionFunction: vi.fn(),
    setRepresentationForTypeById: vi.fn(),
    setCurrentTrack: vi.fn(),
    getRepresentationsByTypeUnfiltered: () => representations,
    getCurrentRepresentationForType: () => representations[1],
    getTracksFor: () => [
      { id: 'en', lang: 'en', labels: [] },
      { id: 'ru', lang: 'ru', labels: [] },
    ],
    getCurrentTrackFor: () => ({ id: 'en' }),
    on: (name: string, fn: () => void) => listeners.set(name, fn),
  };
  return { player, listeners };
});
vi.mock('dashjs', () => ({
  MediaPlayer: Object.assign(() => ({ create: () => mock.player }), {
    events: {
      STREAM_INITIALIZED: 'ready',
      QUALITY_CHANGE_RENDERED: 'quality',
      TRACK_CHANGE_RENDERED: 'track',
      ERROR: 'error',
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mock.listeners.clear();
});

it('uses the existing video, offers 1440p independent of viewport and selects stable representation IDs', async () => {
  const video = document.createElement('video');
  const levels = vi.fn();
  const voices = vi.fn();
  const engine = await attachDash(video, '/cinema/dash/test', 'ru', {
    alive: () => true,
    levels,
    voices,
    error: vi.fn(),
  });
  expect(mock.player.initialize).toHaveBeenCalledWith(video, '/cinema/dash/test', false);
  expect(mock.player.setInitialMediaSettingsFor).toHaveBeenCalledWith('audio', { lang: 'ru' });
  const select = mock.player.setCustomInitialTrackSelectionFunction.mock.calls[0]![0];
  const h264 = { type: 'video', bitrateList: [{ height: 1080 }] };
  const av1 = { type: 'video', bitrateList: [{ height: 1440 }, { height: 2160 }] };
  expect(select([h264, av1])).toEqual([av1]);
  const dubbed = { type: 'audio', roles: [], codec: 'mp4a.40.2' };
  const original = { type: 'audio', roles: [{ value: 'main' }], codec: 'mp4a.40.2' };
  expect(select([dubbed, original])).toEqual([original]);
  mock.listeners.get('ready')!();
  expect(levels.mock.calls[0]![0][1].height).toBe(1440);
  engine!.quality(1);
  expect(mock.player.setRepresentationForTypeById).toHaveBeenCalledWith('video', 'qhd', false);
  engine!.quality(-1);
  expect(mock.player.updateSettings).toHaveBeenLastCalledWith({
    streaming: { abr: { autoSwitchBitrate: { video: true } } },
  });
  expect(engine!.voice(1)).toBe('ru');
  engine!.destroy();
  expect(mock.player.reset).toHaveBeenCalledOnce();
  const count = levels.mock.calls.length;
  mock.listeners.get('quality')!();
  expect(levels).toHaveBeenCalledTimes(count);
});

it('does not initialize a late dynamic import after teardown', async () => {
  expect(
    await attachDash(document.createElement('video'), '/x', '', {
      alive: () => false,
      levels: vi.fn(),
      voices: vi.fn(),
      error: vi.fn(),
    }),
  ).toBeNull();
  expect(mock.player.initialize).not.toHaveBeenCalled();
});

it('reports engine failure for the owning player to refresh or fall back', async () => {
  const error = vi.fn();
  await attachDash(document.createElement('video'), '/x', '', {
    alive: () => true,
    levels: vi.fn(),
    voices: vi.fn(),
    error,
  });
  mock.listeners.get('error')!();
  expect(error).toHaveBeenCalledOnce();
});
