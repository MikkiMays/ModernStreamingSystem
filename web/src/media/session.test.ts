import type { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomEvent, DisconnectReason, Track, createLocalAudioTrack, type RoomOptions } from 'livekit-client';
import { MediaSession } from './session';
import type { RoomApi } from '../api/client';
import type { CaptureAdapter, ScreenAudioEvent, ScreenAudioSource } from './capture';
import { fakeCameraTrack } from './fake-track';

vi.mock('livekit-client', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('livekit-client')>();
  const { EventEmitter } = await import('node:events');
  class FakeRoom extends EventEmitter {
    state = 'connected';
    remoteParticipants = new Map();
    localParticipant = {
      trackPublications: new Map<Track.Source, { track?: unknown }>(),
      isMicrophoneEnabled: false,
      isCameraEnabled: false,
      isScreenShareEnabled: false,
      getTrackPublication(source: Track.Source) {
        return this.trackPublications.get(source);
      },
      publishTrack: vi.fn(async () => ({})),
    };
    constructor(readonly options: RoomOptions) {
      super();
    }
    disconnect = vi.fn(async () => {
      this.state = 'disconnected';
      this.emit(sdk.RoomEvent.Disconnected);
    });
    connect = vi.fn(async () => {});
    simulateScenario = vi.fn(async () => {});
  }
  return { ...sdk, Room: FakeRoom, createLocalAudioTrack: vi.fn() };
});

function fixture(capture?: CaptureAdapter) {
  const api = {
    admission: { participantId: 'self' },
    snapshot: vi.fn(async () => ({ participants: [{ id: 'self', generation: 1 }] })),
    command: vi.fn(async () => ({})),
    token: vi.fn(async () => ({ url: 'ws://localhost', token: 'test' })),
    screen: vi.fn(async () => ({})),
  } as unknown as RoomApi;
  const ended = vi.fn();
  const media = new MediaSession(api, ended, capture);
  return {
    api,
    media,
    ended,
    room: media.room as unknown as EventEmitter & {
      options: RoomOptions;
      remoteParticipants: Map<string, unknown>;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function screenFixture() {
  vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [] }) });
  const video = Object.assign(new EventTarget(), {
    kind: 'video',
    readyState: 'live',
    getSettings: () => ({ width: 1920, height: 1080 }),
    applyConstraints: vi.fn(async () => {}),
    stop: vi.fn(),
  });
  const stream = {
    getVideoTracks: () => [video],
    getAudioTracks: () => [],
    getTracks: () => [video],
  } as unknown as MediaStream;
  const result = fixture({ supported: () => true, capture: async () => stream });
  const permissions = {
    canPublish: true,
    canPublishSources: [Track.sourceToProto(Track.Source.Camera)],
  };
  const publishTrack = vi.fn(async () => ({
    track: {
      source: Track.Source.ScreenShare,
      kind: Track.Kind.Video,
      mediaStreamTrack: video,
      stop: video.stop,
    },
  }));
  Object.assign(result.media.room.localParticipant, { permissions, publishTrack });
  return { ...result, video, permissions, publishTrack };
}

describe('screen publication handoff', () => {
  it('does not publish before the SDK receives the granted permission', async () => {
    const { media, api, room, permissions, publishTrack } = screenFixture();
    try {
      media.share(media.requestedProfile);
      await vi.waitFor(() => expect(api.screen).toHaveBeenCalledWith(true));
      expect(publishTrack).not.toHaveBeenCalled();
      permissions.canPublishSources.push(Track.sourceToProto(Track.Source.ScreenShare));
      room.emit(RoomEvent.ParticipantPermissionsChanged);
      await vi.waitFor(() => expect(publishTrack).toHaveBeenCalledOnce());
      expect(api.screen).not.toHaveBeenCalledWith(false);
    } finally {
      media.dispose();
    }
  });

  it('releases the reservation and capture if the participant leaves while waiting', async () => {
    const { media, api, video, publishTrack } = screenFixture();
    media.share(media.requestedProfile);
    await vi.waitFor(() => expect(api.screen).toHaveBeenCalledWith(true));
    media.dispose();
    await vi.waitFor(() => expect(api.screen).toHaveBeenCalledWith(false));
    expect(video.stop).toHaveBeenCalled();
    expect(publishTrack).not.toHaveBeenCalled();
  });
});

/*
  Звук приложения и «система кроме Cord» в клиенте на Electron (E01-B3): дорожка приходит не из
  getDisplayMedia, а событием оболочки — и публикуется рядом с экраном как ScreenShareAudio.
*/
describe('звук показа от оболочки', () => {
  function audioFixture() {
    const f = screenFixture();
    f.permissions.canPublishSources.push(
      Track.sourceToProto(Track.Source.ScreenShare),
      Track.sourceToProto(Track.Source.ScreenShareAudio),
    );
    const audio = { kind: 'audio', readyState: 'live', stop: vi.fn() } as unknown as MediaStreamTrack;
    const publishTrack = vi.fn(async (track: MediaStreamTrack, _options?: { source?: Track.Source }) => ({
      track: {
        source: track.kind === 'audio' ? Track.Source.ScreenShareAudio : Track.Source.ScreenShare,
        kind: track.kind === 'audio' ? Track.Kind.Audio : Track.Kind.Video,
        mediaStreamTrack: track,
        stop: () => track.stop(),
      },
    }));
    Object.assign(f.media.room.localParticipant, { publishTrack });
    let listener: ((event: ScreenAudioEvent) => void) | undefined;
    const unwatch = vi.fn();
    const source: ScreenAudioSource = {
      watch: vi.fn((next: (event: ScreenAudioEvent) => void) => {
        listener = next;
        return unwatch;
      }),
    };
    const audioPublished = () => publishTrack.mock.calls.filter(([track]) => track === audio);
    return {
      ...f,
      publishTrack,
      audio,
      source,
      unwatch,
      audioPublished,
      emit: (e: ScreenAudioEvent) => listener!(e),
    };
  }

  it('подписка — до getDisplayMedia; ready раньше видео — публикуется после него как ScreenShareAudio', async () => {
    const f = audioFixture();
    try {
      f.media.share(f.media.requestedProfile, f.source);
      expect(f.source.watch).toHaveBeenCalledOnce();
      f.emit({ state: 'ready', track: f.audio });
      await vi.waitFor(() => expect(f.audioPublished()).toHaveLength(1));
      expect(f.publishTrack.mock.calls[0]![0]).toBe(f.video);
      expect(f.audioPublished()[0]![1]).toMatchObject({ source: Track.Source.ScreenShareAudio, dtx: false });
      // Своя дорожка оболочки — не звук системы: заметки «зрители услышат разговор» нет.
      expect(f.media.state.get().error).toBeNull();
    } finally {
      f.media.dispose();
    }
  });

  it('ready после видео — сразу; конец показа — track.stop() и отписка', async () => {
    const f = audioFixture();
    try {
      f.media.share(f.media.requestedProfile, f.source);
      await vi.waitFor(() => expect(f.publishTrack).toHaveBeenCalledOnce());
      f.emit({ state: 'ready', track: f.audio });
      await vi.waitFor(() => expect(f.audioPublished()).toHaveLength(1));
      await f.media.stopScreen();
      expect(f.audio.stop).toHaveBeenCalled();
      expect(f.unwatch).toHaveBeenCalled();
    } finally {
      f.media.dispose();
    }
  });

  it('failed — подсказка, показ идёт дальше без звука', async () => {
    const f = audioFixture();
    try {
      f.media.share(f.media.requestedProfile, f.source);
      await vi.waitFor(() => expect(f.publishTrack).toHaveBeenCalledOnce());
      f.emit({ state: 'failed', message: 'Звук показа не включился. Показ идёт без звука.' });
      expect(f.media.state.get().error).toBe('Звук показа не включился. Показ идёт без звука.');
      expect(f.audioPublished()).toHaveLength(0);
      expect(f.video.stop).not.toHaveBeenCalled();
    } finally {
      f.media.dispose();
    }
  });

  it('показ отменили раньше, чем пришёл звук, — опоздавшая дорожка останавливается, а не публикуется', async () => {
    const f = audioFixture();
    try {
      f.media.share(f.media.requestedProfile, f.source);
      await vi.waitFor(() => expect(f.publishTrack).toHaveBeenCalledOnce());
      await f.media.stopScreen();
      f.emit({ state: 'ready', track: f.audio });
      expect(f.audio.stop).toHaveBeenCalled();
      expect(f.audioPublished()).toHaveLength(0);
    } finally {
      f.media.dispose();
    }
  });
});

describe('нажми и говори: setMicrophone', () => {
  function micFixture(delay = 20) {
    const f = fixture();
    const toggle = vi.spyOn(f.media, 'toggle').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      f.media.state.set({ ...f.media.state.get(), microphone: !f.media.state.get().microphone });
    });
    return { ...f, toggle };
  }

  it('короткое нажатие: отпускание во время включения всё равно выключает', async () => {
    const { media, toggle } = micFixture();
    try {
      const down = media.setMicrophone(true);
      const up = media.setMicrophone(false);
      await Promise.all([down, up]);
      expect(toggle).toHaveBeenCalledTimes(2);
      expect(media.state.get().microphone).toBe(false);
      // Без звуковых сигналов на каждое нажатие.
      expect(toggle.mock.calls.every((call) => call[2] === false)).toBe(true);
    } finally {
      media.dispose();
    }
  });

  it('уже в нужном состоянии — ничего не делает', async () => {
    const { media, toggle } = micFixture();
    try {
      await media.setMicrophone(false);
      expect(toggle).not.toHaveBeenCalled();
      await media.setMicrophone(true);
      await media.setMicrophone(true);
      expect(toggle).toHaveBeenCalledOnce();
    } finally {
      media.dispose();
    }
  });
});

describe('media lifecycle', () => {
  it('enforces the original deadline even when the SDK asks for a retry before emitting Reconnecting', async () => {
    vi.useFakeTimers();
    const { media, room, ended, api } = fixture();
    room.options.reconnectPolicy!.nextRetryDelayInMs({ retryCount: 0, elapsedMs: 0 });
    room.emit(RoomEvent.Reconnecting);
    await vi.advanceTimersByTimeAsync(10000);
    room.emit(RoomEvent.Reconnecting);
    await vi.advanceTimersByTimeAsync(10000);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(media.state.get().status).toBe('ended');
    room.emit(RoomEvent.Reconnected);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(30000);
    expect(media.state.get().status).toBe('ended');
    expect(api.token).not.toHaveBeenCalled();
  });
  it('ends immediately on removal, without trying to obtain a new token', async () => {
    const { media, room, ended, api } = fixture();
    room.emit(RoomEvent.Disconnected, DisconnectReason.PARTICIPANT_REMOVED);
    await Promise.resolve();
    expect(ended).toHaveBeenCalledOnce();
    expect(api.token).not.toHaveBeenCalled();
    expect(media.state.get().status).toBe('ended');
  });
  it('reads publications after the SDK finishes unsubscribing a track', async () => {
    const { media, room } = fixture();
    const publications = new Map([['screen', { trackSid: 'screen', source: 'screen_share', track: {} }]]);
    room.remoteParticipants.set('peer', {
      identity: 'peer',
      trackPublications: publications,
      videoTrackPublications: publications,
    });
    room.emit(RoomEvent.TrackSubscribed);
    await Promise.resolve();
    expect(media.tracks.get()).toHaveLength(1);
    room.emit(RoomEvent.TrackUnsubscribed);
    publications.clear();
    await Promise.resolve();
    expect(media.tracks.get()).toHaveLength(0);
    media.dispose();
  });
});

describe('selective screen subscriptions', () => {
  it('keeps microphones and cameras connected while selecting only one screen and its audio', () => {
    const { media, room } = fixture();
    const publication = (source: Track.Source) => ({
      source,
      isDesired: false,
      setSubscribed: vi.fn(function (this: { isDesired: boolean }, value: boolean) {
        this.isDesired = value;
      }),
    });
    const a = [
      publication(Track.Source.Microphone),
      publication(Track.Source.Camera),
      publication(Track.Source.ScreenShare),
      publication(Track.Source.ScreenShareAudio),
    ];
    const b = [publication(Track.Source.ScreenShare), publication(Track.Source.ScreenShareAudio)];
    room.remoteParticipants.set('a', { identity: 'a', trackPublications: new Map(a.map((p, i) => [i, p])) });
    room.remoteParticipants.set('b', { identity: 'b', trackPublications: new Map(b.map((p, i) => [i, p])) });
    media.watchScreen(null);
    expect(a.map((p) => p.isDesired)).toEqual([true, true, false, false]);
    media.watchScreen('a');
    expect(a.map((p) => p.isDesired)).toEqual([true, true, true, true]);
    expect(b.map((p) => p.isDesired)).toEqual([false, false]);
    media.watchScreen('b');
    expect(a.map((p) => p.isDesired)).toEqual([true, true, false, false]);
    expect(b.map((p) => p.isDesired)).toEqual([true, true]);
    media.watchScreen(null);
    expect(b.map((p) => p.isDesired)).toEqual([false, false]);
    media.dispose();
  });
});

/**
 * Показ открывается зрителям после кадра целевого качества (T48): `screen.started` уходит, когда
 * верхний слой закодировал кадр того размера, что просили, — или когда кончилось окно разгона.
 */
describe('показ открывается зрителям после кадра целевого качества', () => {
  function readyFixture(settleMs: number) {
    localStorage.setItem(
      'cord:quality:v1',
      JSON.stringify({
        default: { resolution: 720, fps: 30 },
        ceiling: { resolution: 1080, fps: 60 },
        settleMs,
        cameraYieldsToScreen: false,
      }),
    );
    const f = screenFixture();
    let frame = { width: 640, height: 360 };
    const report = () =>
      new Map([
        [
          'f',
          {
            type: 'outbound-rtp',
            kind: 'video',
            frameWidth: frame.width,
            frameHeight: frame.height,
            framesEncoded: 3,
          },
        ],
      ]) as unknown as RTCStatsReport;
    f.publishTrack.mockImplementation(async () => ({
      track: {
        source: Track.Source.ScreenShare,
        kind: Track.Kind.Video,
        mediaStreamTrack: f.video,
        stop: f.video.stop,
        getRTCStatsReport: async () => report(),
      },
    }));
    Object.assign(f.api, { screen: vi.fn(async () => ({ value: 'slot' })) });
    f.permissions.canPublishSources.push(Track.sourceToProto(Track.Source.ScreenShare));
    const started = () =>
      (f.api.command as ReturnType<typeof vi.fn>).mock.calls.some(
        ([command]) => (command as { type: string }).type === 'screen.started',
      );
    return { ...f, started, encode: (width: number, height: number) => (frame = { width, height }) };
  }
  afterEach(() => localStorage.clear());

  it('не шлёт screen.started, пока верхний слой мельче целевого, и шлёт по кадру целевого размера', async () => {
    const f = readyFixture(10000);
    try {
      f.media.share(f.media.requestedProfile);
      await vi.waitFor(() => expect(f.publishTrack).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(f.started()).toBe(false);
      // Захват 1920×1080 под уровень 720p — цель 1280×720.
      f.encode(1280, 720);
      await vi.waitFor(() => expect(f.started()).toBe(true), { timeout: 3000 });
    } finally {
      f.media.dispose();
    }
  });

  it('по истечении окна разгона открывает то, что есть', async () => {
    const f = readyFixture(600);
    try {
      f.media.share(f.media.requestedProfile);
      await vi.waitFor(() => expect(f.publishTrack).toHaveBeenCalled());
      expect(f.started()).toBe(false);
      await vi.waitFor(() => expect(f.started()).toBe(true), { timeout: 3000 });
    } finally {
      f.media.dispose();
    }
  });
});

/** Знак сети при живом SDK — немедленный resume, а не ожидание таймаута пинга (T50). */
describe('знак сети', () => {
  it('по online при «подключённом» SDK просит resume сразу, но не чаще раза в несколько секунд', () => {
    const { media, room } = fixture();
    const resume = (room as unknown as { simulateScenario: ReturnType<typeof vi.fn> }).simulateScenario;
    try {
      window.dispatchEvent(new Event('online'));
      expect(resume).toHaveBeenCalledWith('signal-reconnect');
      window.dispatchEvent(new Event('online'));
      expect(resume).toHaveBeenCalledTimes(1);
    } finally {
      media.dispose();
    }
  });

  it('пока SDK переподключается сам, не мешает ему', () => {
    const { media, room } = fixture();
    const resume = (room as unknown as { simulateScenario: ReturnType<typeof vi.fn> }).simulateScenario;
    try {
      (room as unknown as { state: string }).state = 'reconnecting';
      window.dispatchEvent(new Event('online'));
      expect(resume).not.toHaveBeenCalled();
    } finally {
      media.dispose();
    }
  });
});

/** Телефон в кармане (E12): уход с экрана ничего не рвёт, возвращение из заморозки — сразу resume. */
describe('разговор в фоне', () => {
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  afterEach(() => {
    delete (document as { hidden?: boolean }).hidden;
  });

  it('свернули и развернули — resume не нужен: JS работал, обрыв SDK заметил бы сам', () => {
    const { media, room } = fixture();
    const resume = (room as unknown as { simulateScenario: ReturnType<typeof vi.fn> }).simulateScenario;
    try {
      setHidden(true);
      setHidden(false);
      expect(resume).not.toHaveBeenCalled();
    } finally {
      media.dispose();
    }
  });

  it('вернулись из заморозки — сразу resume, не дожидаясь таймаута пинга', () => {
    const { media, room } = fixture();
    const resume = (room as unknown as { simulateScenario: ReturnType<typeof vi.fn> }).simulateScenario;
    try {
      setHidden(true);
      document.dispatchEvent(new Event('freeze'));
      setHidden(false);
      expect(resume).toHaveBeenCalledWith('signal-reconnect');
    } finally {
      media.dispose();
    }
  });

  it('пока страница скрыта, окно восстановления стоит', () => {
    vi.useFakeTimers();
    const { media, room } = fixture();
    try {
      room.emit(RoomEvent.Reconnecting);
      setHidden(true);
      vi.advanceTimersByTime(60_000);
      expect(media.state.get().status).toBe('recovering');
      expect(media.recovery.holding).toBe(true);
      setHidden(false);
      expect(media.recovery.holding).toBe(false);
    } finally {
      media.dispose();
    }
  });

  function withUserAgent(userAgent: string, run: () => Promise<void>) {
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
    Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
    return run().finally(() => {
      delete (navigator as { userAgent?: string }).userAgent;
      if (original) Object.defineProperty(Navigator.prototype, 'userAgent', original);
    });
  }

  it('телефон: вошедший с выключенным микрофоном захватывает его заглушённым — до публикации', () =>
    withUserAgent('Mozilla/5.0 (Linux; Android 15; Pixel 8) Chrome/141.0 Mobile Safari/537.36', async () => {
      const order: string[] = [];
      const track = {
        mute: vi.fn(async () => {
          order.push('mute');
        }),
        stop: vi.fn(),
      };
      vi.mocked(createLocalAudioTrack).mockResolvedValueOnce(track as never);
      const { media } = fixture();
      const publish = (media.room.localParticipant as unknown as { publishTrack: ReturnType<typeof vi.fn> })
        .publishTrack;
      publish.mockImplementationOnce(async () => {
        order.push('publish');
        return {};
      });
      try {
        expect(media.platform.mobile).toBe(true);
        await media.holdMicrophone();
        expect(order).toEqual(['mute', 'publish']);
        expect(publish).toHaveBeenCalledWith(
          track,
          expect.objectContaining({ source: Track.Source.Microphone }),
        );
      } finally {
        media.dispose();
      }
    }));

  it('ПК: выключенный микрофон не захватывается, как и раньше', async () => {
    vi.mocked(createLocalAudioTrack).mockClear();
    const { media } = fixture();
    try {
      expect(media.platform.mobile).toBe(false);
      await media.holdMicrophone();
      expect(createLocalAudioTrack).not.toHaveBeenCalled();
    } finally {
      media.dispose();
    }
  });

  it('телефон без доступа к микрофону: встреча идёт, ошибки на сцене нет', () =>
    withUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) Safari/604.1', async () => {
      vi.mocked(createLocalAudioTrack).mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { media } = fixture();
      try {
        await media.holdMicrophone();
        expect(media.state.get().error).toBeNull();
        expect(media.captured.get()).toBe(false);
      } finally {
        warn.mockRestore();
        media.dispose();
      }
    }));
});
