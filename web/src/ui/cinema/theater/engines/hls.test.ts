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
      LEVEL_LOADED: 'levelLoaded',
      FRAG_BUFFERED: 'fragBuffered',
      FRAG_LOADING: 'fragLoading',
      FRAG_LOADED: 'fragLoaded',
      ERROR: 'hlsError',
    };
    static ErrorTypes = {
      NETWORK_ERROR: 'networkError',
      MEDIA_ERROR: 'mediaError',
      OTHER_ERROR: 'otherError',
    };
    config: Record<string, unknown>;
    subtitleDisplay = true;
    levels: { height: number; bitrate?: number }[] = [{ height: 180 }, { height: 144 }];
    bandwidthEstimate = 2_500_000;
    nextLoadLevel = 0;
    autoLevelEnabled = true;
    autoLevelCapping = -1;
    currentLevel = -1;
    audioTracks: { name: string; lang?: string }[] = [];
    audioTrack = 0;
    subtitleTrack = -1;
    liveSyncPosition: number | null = null;
    playingDate: Date | null = null;
    constructor(config: Record<string, unknown>) {
      this.config = { ...config };
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
    swapAudioCodec = vi.fn(() => calls.push('swapAudioCodec'));
    stopLoad = vi.fn(() => calls.push('stopLoad'));
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
  it('создаётся с настройкой, которая переживает замирание хоста, прячет родные субтитры и грузит адрес в тот же <video>', () => {
    const video = document.createElement('video');
    attachHls(video, '/cinema/playlist?u=1', 'ru', callbacks());
    expect(hls().config).toEqual({
      enableWorker: true,
      backBufferLength: 30,
      maxBufferLength: 20,
      maxMaxBufferLength: 20,
      abrBandWidthFactor: 0.8,
      abrBandWidthUpFactor: 0.6,
      fragLoadingMaxRetry: 8,
      fragLoadingRetryDelay: 500,
      fragLoadingMaxRetryTimeout: 4000,
      manifestLoadingMaxRetry: 4,
      capLevelToPlayerSize: false,
      maxBufferHole: 0.5,
      nudgeMaxRetry: 8,
      testBandwidth: false,
      abrEwmaDefaultEstimate: 2_500_000,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 12,
      audioPreference: { lang: 'ru' },
      enableInterstitialPlayback: false,
      startFragPrefetch: true,
    });
    expect(hls().subtitleDisplay).toBe(false);
    expect(mock.calls).toEqual(['loadSource /cinema/playlist?u=1', 'attachMedia']);
    attachHls(video, '/x', '', callbacks());
    expect((hls().config as { audioPreference?: unknown }).audioPreference).toBeUndefined();
    expect(hlsSupported()).toBe(true);
  });

  it('вперёд держит 20–30 с по запасу канала над играющей ступенью, и каждый кусочек — заново (R172)', () => {
    attachHls(document.createElement('video'), '/x', '', callbacks());
    const engine = hls();
    const ahead = () => [engine.config.maxBufferLength, engine.config.maxMaxBufferLength];
    expect(ahead()).toEqual([20, 20]);
    engine.levels = [{ height: 720, bitrate: 2_000_000 }];
    engine.currentLevel = 0;
    engine.bandwidthEstimate = 10_000_000;
    fire('fragBuffered');
    expect(ahead()).toEqual([30, 30]);
    engine.bandwidthEstimate = 4_500_000;
    fire('fragBuffered');
    expect(ahead()).toEqual([25, 25]);
    engine.bandwidthEstimate = 2_500_000;
    fire('fragBuffered');
    expect(ahead()).toEqual([20, 20]);
  });

  it('рекламу, которую пометил поток записи, сообщает отрезками; у эфира — нет', () => {
    const breaks = vi.fn();
    attachHls(document.createElement('video'), '/x', '', { ...callbacks(), breaks });
    const fragment = (index: number, tags: string[][] = []) => ({
      start: index * 6,
      duration: 6,
      programDateTime: null,
      tagList: [['INF', '6'], ...tags],
    });
    const fragments = [
      fragment(0),
      fragment(1, [['EXT-X-CUE-OUT', '12']]),
      fragment(2),
      fragment(3, [['EXT-X-CUE-IN']]),
      fragment(4),
    ];
    fire('levelLoaded', { details: { live: false, fragments } });
    expect(breaks).toHaveBeenCalledWith([{ start: 6, end: 18 }]);
    breaks.mockClear();
    fire('levelLoaded', { details: { live: true, fragments } });
    expect(breaks).not.toHaveBeenCalled();
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

  it('ошибки: протухшую подпись обновляет владелец, сеть и декодер лечатся на месте с паузами, потом — заново и отказ', () => {
    vi.useFakeTimers();
    try {
      const report = { ...callbacks(), reopen: vi.fn(() => true) };
      attachHls(document.createElement('video'), '/x', '', report);
      fire('hlsError', { fatal: false, type: 'networkError' });
      expect(report.expired).not.toHaveBeenCalled();
      expect(hls().startLoad).not.toHaveBeenCalled();

      fire('hlsError', { fatal: true, type: 'networkError', response: { code: 403 } });
      expect(report.expired).toHaveBeenCalledTimes(1);
      expect(hls().startLoad).not.toHaveBeenCalled();

      // Сеть (R216): три попытки за минуту — через 1, 2 и 4 с, а не сразу и по кругу.
      report.expired.mockReturnValue(false);
      fire('hlsError', { fatal: true, type: 'networkError', response: { code: 410 } });
      expect(report.expired).toHaveBeenCalledTimes(2);
      expect(hls().startLoad).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(hls().startLoad).toHaveBeenCalledTimes(1);
      fire('hlsError', { fatal: true, type: 'networkError', response: { code: 500 } });
      vi.advanceTimersByTime(1999);
      expect(hls().startLoad).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(hls().startLoad).toHaveBeenCalledTimes(2);
      fire('hlsError', { fatal: true, type: 'networkError' });
      vi.advanceTimersByTime(4000);
      expect(hls().startLoad).toHaveBeenCalledTimes(3);
      expect(report.reopen).not.toHaveBeenCalled();
      // Четвёртая за минуту — уже не мигнувшая сеть: поток открывается заново.
      fire('hlsError', { fatal: true, type: 'networkError' });
      vi.advanceTimersByTime(10_000);
      expect(hls().startLoad).toHaveBeenCalledTimes(3);
      expect(report.reopen).toHaveBeenCalledTimes(1);

      // Декодер: пересборка, потом пересборка с другим кодеком звука, потом — заново.
      fire('hlsError', { fatal: true, type: 'mediaError' });
      expect(hls().recoverMediaError).toHaveBeenCalledTimes(1);
      expect(hls().swapAudioCodec).not.toHaveBeenCalled();
      fire('hlsError', { fatal: true, type: 'mediaError' });
      expect(hls().swapAudioCodec).toHaveBeenCalledTimes(1);
      expect(hls().recoverMediaError).toHaveBeenCalledTimes(2);
      fire('hlsError', { fatal: true, type: 'mediaError' });
      expect(hls().recoverMediaError).toHaveBeenCalledTimes(2);
      expect(report.reopen).toHaveBeenCalledTimes(2);
      expect(report.fail).not.toHaveBeenCalled();

      // Открыть заново больше нельзя — честный отказ, а не вечный чёрный кадр.
      report.reopen.mockReturnValue(false);
      fire('hlsError', { fatal: true, type: 'otherError' });
      expect(report.fail).toHaveBeenCalledWith('Поток прервался. Попробуйте открыть видео заново');
    } finally {
      vi.useRealTimers();
    }
  });

  it('без `reopen` у владельца исчерпанное лечение — сразу честный отказ; после разборки ошибки молчат', () => {
    const report = callbacks();
    const engine = attachHls(document.createElement('video'), '/x', '', report);
    fire('hlsError', { fatal: true, type: 'otherError' });
    expect(report.fail).toHaveBeenCalledTimes(1);
    engine.destroy();
    fire('hlsError', { fatal: true, type: 'otherError' });
    expect(report.fail).toHaveBeenCalledTimes(1);
  });

  it('лечение застрявшего плеера: загрузка заново с позиции, пересборка, ступень ниже того же кодека', () => {
    const video = document.createElement('video');
    const engine = attachHls(video, '/x', '', callbacks());
    expect(engine.health!()).toEqual({ loading: false, fedAgoMs: null, auto: true });
    fire('fragLoading');
    expect(engine.health!().loading).toBe(true);
    fire('fragLoaded');
    expect(engine.health!()).toMatchObject({ loading: false, auto: true });
    expect(engine.health!().fedAgoMs).toBeGreaterThanOrEqual(0);

    video.currentTime = 42;
    expect(engine.heal!('kick')).toBe(true);
    expect(mock.calls.slice(-2)).toEqual(['stopLoad', 'startLoad 42']);
    expect(engine.heal!('rebuild')).toBe(true);
    expect(hls().recoverMediaError).toHaveBeenCalledTimes(1);

    hls().levels = [
      { height: 360, bitrate: 800_000, videoCodec: 'avc1.4D401E' },
      { height: 480, bitrate: 1_100_000, videoCodec: 'vp09.00.30.08' },
      { height: 720, bitrate: 4_500_000, videoCodec: 'avc1.4D4020' },
    ] as never;
    hls().currentLevel = 2;
    expect(engine.heal!('lower')).toBe(true);
    // Ниже 720p H.264 — 360p H.264, а не 480p VP9: кодек посреди просмотра hls.js не меняет.
    expect(hls().autoLevelCapping).toBe(0);
    expect(hls().nextLoadLevel).toBe(0);
    hls().currentLevel = 0;
    expect(engine.heal!('lower')).toBe(false);
    expect(engine.heal!('nudge')).toBe(false);
  });

  it('кодек картинки, выбранный устройством, — с первого куска', () => {
    attachHls(document.createElement('video'), '/x', '', callbacks(), { videoCodec: 'avc1' });
    expect(hls().config.videoPreference).toEqual({ videoCodec: 'avc1' });
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
