import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioChoice } from '../watch-tracks';
import { attachHls, hlsSupported } from './hls';

type Listener = (event: string, data: Record<string, unknown>) => void;

const mock = vi.hoisted(() => {
  const listeners = new Map<string, Listener>();
  const calls: string[] = [];
  class FakeHls {
    static isSupported = () => true;
    static Events = {
      MANIFEST_PARSED: 'manifestParsed',
      LEVEL_SWITCHED: 'levelSwitched',
      AUDIO_TRACKS_UPDATED: 'audioTracksUpdated',
      AUDIO_TRACK_SWITCHED: 'audioTrackSwitched',
      SUBTITLE_TRACKS_UPDATED: 'subtitleTracksUpdated',
      ERROR: 'hlsError',
    };
    static ErrorTypes = {
      NETWORK_ERROR: 'networkError',
      MEDIA_ERROR: 'mediaError',
      OTHER_ERROR: 'otherError',
    };
    config: unknown;
    subtitleDisplay = true;
    levels = [{ height: 180 }, { height: 144 }];
    autoLevelEnabled = true;
    currentLevel = -1;
    audioTracks: { name: string; lang?: string }[] = [];
    audioTrack = 0;
    subtitleTrack = -1;
    liveSyncPosition: number | null = null;
    playingDate: Date | null = null;
    constructor(config: unknown) {
      this.config = config;
      mock.instances.push(this);
    }
    on(name: string, listener: Listener) {
      listeners.set(name, listener);
    }
    loadSource(url: string) {
      calls.push(`loadSource ${url}`);
    }
    attachMedia() {
      calls.push('attachMedia');
    }
    startLoad = vi.fn((position?: number) => calls.push(`startLoad ${position ?? ''}`.trim()));
    recoverMediaError = vi.fn(() => calls.push('recoverMediaError'));
    setAudioOption = vi.fn((option: { lang?: string; name?: string }) =>
      calls.push(`setAudioOption ${option.lang}:${option.name}`),
    );
    destroy = vi.fn();
  }
  return { FakeHls, listeners, calls, instances: [] as FakeHls[] };
});
vi.mock('hls.js', () => ({ default: mock.FakeHls }));

const fire = (name: string, data: Record<string, unknown> = {}) => mock.listeners.get(name)!(name, data);
const hls = () => mock.instances.at(-1)!;

function callbacks(alive = true) {
  const log = mock.calls;
  return {
    alive: vi.fn(() => alive),
    levels: vi.fn(),
    automatic: vi.fn(),
    voices: vi.fn((_voices: AudioChoice[]) => log.push('voices')),
    wanted: vi.fn(() => 1),
    voice: vi.fn((index: number) => log.push(`voice ${index}`)),
    texts: vi.fn(),
    expired: vi.fn(() => true),
    fail: vi.fn(),
  };
}

beforeEach(() => {
  mock.listeners.clear();
  mock.calls.length = 0;
  mock.instances.length = 0;
});

describe('HLS через hls.js', () => {
  it('создаётся с прежней настройкой, прячет родные субтитры и грузит адрес в тот же <video>', () => {
    const video = document.createElement('video');
    attachHls(video, '/cinema/playlist?u=1', 'ru', callbacks());
    expect(hls().config).toEqual({
      enableWorker: true,
      backBufferLength: 120,
      maxBufferLength: 30,
      fragLoadingMaxRetry: 6,
      manifestLoadingMaxRetry: 4,
      capLevelToPlayerSize: false,
      maxBufferHole: 0.5,
      nudgeMaxRetry: 8,
      testBandwidth: false,
      abrEwmaDefaultEstimate: 2_500_000,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 12,
      audioPreference: { lang: 'ru' },
    });
    expect(hls().subtitleDisplay).toBe(false);
    expect(mock.calls).toEqual(['loadSource /cinema/playlist?u=1', 'attachMedia']);
    attachHls(video, '/x', '', callbacks());
    expect((hls().config as { audioPreference?: unknown }).audioPreference).toBeUndefined();
    expect(hlsSupported()).toBe(true);
  });

  it('сообщает ступени и какая выбрана руками, а переходы автоматики — отдельно', () => {
    const report = callbacks();
    const playback = attachHls(document.createElement('video'), '/x', '', report);
    fire('manifestParsed');
    expect(report.levels).toHaveBeenLastCalledWith(hls().levels, -1);
    hls().autoLevelEnabled = false;
    hls().currentLevel = 1;
    fire('manifestParsed');
    expect(report.levels).toHaveBeenLastCalledWith(hls().levels, 1);
    fire('levelSwitched', { level: 0 });
    expect(report.automatic).toHaveBeenCalledWith(0);
    expect(playback.levels).toBe(hls().levels);
  });

  it('на каждое обновление дорожек заново назначает выбранный язык — и переключает, только если нужно', () => {
    const report = callbacks();
    attachHls(document.createElement('video'), '/x', '', report);
    hls().audioTracks = [
      { name: 'English - original', lang: 'en' },
      { name: 'Русский - dubbed', lang: 'ru' },
    ];
    fire('audioTracksUpdated');
    expect(report.wanted).toHaveBeenCalledWith(hls().audioTracks);
    expect(report.voices.mock.calls[0]![0]).toEqual([
      { index: 0, original: true, label: 'Английский' },
      { index: 1, original: false, label: 'Русский' },
    ]);
    // Порядок прежний: список, переключение, выбранная строка.
    expect(mock.calls.slice(2)).toEqual(['voices', 'setAudioOption ru:Русский - dubbed', 'voice 1']);
    hls().audioTrack = 1;
    fire('audioTracksUpdated');
    expect(hls().setAudioOption).toHaveBeenCalledTimes(1);
    fire('audioTrackSwitched', { id: 0 });
    expect(report.voice).toHaveBeenLastCalledWith(0);
    const tracks = [{ name: 'Deutsch', lang: 'de' }];
    fire('subtitleTracksUpdated', { subtitleTracks: tracks });
    expect(report.texts).toHaveBeenCalledWith(tracks);
  });

  it('после разборки плеера молчит', () => {
    const report = callbacks(false);
    attachHls(document.createElement('video'), '/x', '', report);
    hls().audioTracks = [{ name: 'English', lang: 'en' }];
    fire('manifestParsed');
    fire('levelSwitched', { level: 1 });
    fire('audioTracksUpdated');
    fire('audioTrackSwitched', { id: 0 });
    fire('subtitleTracksUpdated', { subtitleTracks: [] });
    for (const name of ['levels', 'automatic', 'voices', 'wanted', 'voice', 'texts'] as const)
      expect(report[name]).not.toHaveBeenCalled();
  });

  it('ошибки: протухшую подпись обновляет владелец, сеть и декодер лечатся на месте, остальное — отказ', () => {
    const report = callbacks();
    attachHls(document.createElement('video'), '/x', '', report);
    fire('hlsError', { fatal: false, type: 'networkError' });
    expect(report.expired).not.toHaveBeenCalled();
    expect(hls().startLoad).not.toHaveBeenCalled();

    fire('hlsError', { fatal: true, type: 'networkError', response: { code: 403 } });
    expect(report.expired).toHaveBeenCalledTimes(1);
    expect(hls().startLoad).not.toHaveBeenCalled();

    report.expired.mockReturnValue(false);
    fire('hlsError', { fatal: true, type: 'networkError', response: { code: 410 } });
    expect(report.expired).toHaveBeenCalledTimes(2);
    expect(hls().startLoad).toHaveBeenCalledTimes(1);

    fire('hlsError', { fatal: true, type: 'networkError', response: { code: 500 } });
    expect(report.expired).toHaveBeenCalledTimes(2);
    expect(hls().startLoad).toHaveBeenCalledTimes(2);

    fire('hlsError', { fatal: true, type: 'mediaError' });
    expect(hls().recoverMediaError).toHaveBeenCalledTimes(1);
    expect(report.fail).not.toHaveBeenCalled();

    fire('hlsError', { fatal: true, type: 'otherError' });
    expect(report.fail).toHaveBeenCalledWith('Поток прервался. Попробуйте открыть видео заново');
  });

  it('снаружи — Playback: ступень, голос, субтитры, край эфира и разборка', () => {
    const playback = attachHls(document.createElement('video'), '/x', '', callbacks());
    playback.quality(1);
    expect(hls().currentLevel).toBe(1);
    playback.quality(-1);
    expect(hls().currentLevel).toBe(-1);

    hls().audioTracks = [{ name: 'English - original', lang: 'en' }, { name: 'Без языка' }];
    expect(playback.voice(0)).toBe('en');
    expect(hls().setAudioOption).toHaveBeenLastCalledWith({ lang: 'en', name: 'English - original' });
    expect(playback.voice(1)).toBe('');
    expect(playback.voice(5)).toBe('');
    expect(hls().setAudioOption).toHaveBeenCalledTimes(2);

    playback.subtitles!(2);
    expect(hls().subtitleTrack).toBe(2);
    playback.reload!();
    expect(hls().startLoad).toHaveBeenLastCalledWith(-1);

    expect(playback.liveSyncPosition).toBeNull();
    hls().liveSyncPosition = 42.5;
    const date = new Date(1_790_000_000_000);
    hls().playingDate = date;
    expect(playback.liveSyncPosition).toBe(42.5);
    expect(playback.playingDate).toBe(date);

    playback.destroy();
    expect(hls().destroy).toHaveBeenCalledOnce();
  });
});
