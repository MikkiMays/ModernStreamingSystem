import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RoomEvent,
  DisconnectReason,
  Track,
  LocalVideoTrack,
  createLocalAudioTrack,
  type RoomOptions,
} from 'livekit-client';
import { MediaSession, SCREEN_GONE_GRACE_MS } from './session';
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
  it('вход в комнату разрешает SFU ставить чужое видео на паузу (R119): иначе SFU 1.13.6 читает «нет» поверх своего allow_pause', async () => {
    const { media, room } = fixture();
    try {
      await media.start();
      expect((room as unknown as { connect: ReturnType<typeof vi.fn> }).connect).toHaveBeenCalledWith(
        'ws://localhost',
        'test',
        expect.objectContaining({ subscriberAllowPause: true, autoSubscribe: false }),
      );
    } finally {
      media.dispose();
    }
  });
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
 * R107: «звук говорящего будто обрезается». Сброс зависшей картинки переподписывал и микрофон того
 * же человека — у слушателя пропадал голос на время переподписки, хотя со звуком всё было в порядке.
 */
describe('сброс живой картинки не трогает голос', () => {
  it('«Вернуться в эфир» переподписывает камеру, а микрофон остаётся подписанным', async () => {
    const { media, room } = fixture();
    (media as unknown as { patch(v: object): void }).patch({ status: 'connected' });
    const publication = (source: Track.Source, sid: string) => {
      const p = Object.assign(new EventEmitter(), {
        source,
        trackSid: sid,
        isSubscribed: true,
        isEnabled: true,
        isMuted: false,
        setSubscribed: vi.fn(function (this: { emit(e: string): void }, value: boolean) {
          if (!value) queueMicrotask(() => this.emit('unsubscribed'));
        }),
      });
      return p;
    };
    const camera = publication(Track.Source.Camera, 'TR_cam');
    const microphone = publication(Track.Source.Microphone, 'TR_mic');
    room.remoteParticipants.set('a', {
      identity: 'a',
      trackPublications: new Map([
        ['TR_cam', camera],
        ['TR_mic', microphone],
      ]),
    });
    await media.returnToLive();
    expect(camera.setSubscribed).toHaveBeenCalledWith(false);
    expect(microphone.setSubscribed).not.toHaveBeenCalled();
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

  it('«Остановить показ» во время разгона останавливает сразу — screen.started не уходит (R81, R60)', async () => {
    const f = readyFixture(10000);
    try {
      f.media.share(f.media.requestedProfile);
      await vi.waitFor(() => expect(f.publishTrack).toHaveBeenCalled());
      // Кнопка на пульте уже «Остановить показ», а кадра целевого размера ещё нет.
      f.media.share(f.media.requestedProfile);
      await vi.waitFor(() => expect(f.api.screen).toHaveBeenCalledWith(false));
      f.encode(1280, 720);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(f.started()).toBe(false);
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

/** Конец чужого показа (R81): событие после паузы, а переопубликация — не конец. */
describe('конец чужого показа у зрителя', () => {
  function peerWithScreen() {
    const { media, room, api } = fixture();
    const screen = {
      trackSid: 'scr',
      source: Track.Source.ScreenShare,
      track: {},
      isDesired: true,
      setSubscribed: vi.fn(),
    };
    const publications = new Map<string, unknown>([['scr', screen]]);
    const peer = { identity: 'peer', trackPublications: publications, videoTrackPublications: publications };
    room.remoteParticipants.set('peer', peer);
    media.watchScreen('peer');
    return { media, room, api, peer, screen, publications };
  }
  afterEach(() => vi.useRealTimers());

  it('снятая дорожка без замены за 400 мс — показ кончился, событие со счётчиком', () => {
    vi.useFakeTimers();
    const f = peerWithScreen();
    try {
      f.publications.delete('scr');
      f.room.emit(RoomEvent.TrackUnpublished, f.screen, f.peer);
      expect(f.media.screenGone.get()).toBeNull();
      vi.advanceTimersByTime(SCREEN_GONE_GRACE_MS + 1);
      expect(f.media.screenGone.get()).toEqual({ identity: 'peer', seq: 1 });
      // Второй конец показа того же человека — новый номер, а не то же значение.
      f.room.emit(RoomEvent.TrackUnpublished, f.screen, f.peer);
      vi.advanceTimersByTime(SCREEN_GONE_GRACE_MS + 1);
      expect(f.media.screenGone.get()).toEqual({ identity: 'peer', seq: 2 });
    } finally {
      f.media.dispose();
    }
  });

  it('переопубликация (смена качества, кодека, переподключение) зрителя не выкидывает', () => {
    vi.useFakeTimers();
    const f = peerWithScreen();
    try {
      f.publications.delete('scr');
      f.room.emit(RoomEvent.TrackUnpublished, f.screen, f.peer);
      vi.advanceTimersByTime(SCREEN_GONE_GRACE_MS / 2);
      const again = {
        trackSid: 'scr2',
        source: Track.Source.ScreenShare,
        track: {},
        isDesired: true,
        setSubscribed: vi.fn(),
      };
      f.publications.set('scr2', again);
      f.room.emit(RoomEvent.TrackPublished, again, f.peer);
      vi.advanceTimersByTime(SCREEN_GONE_GRACE_MS * 2);
      expect(f.media.screenGone.get()).toBeNull();
    } finally {
      f.media.dispose();
    }
  });

  it('чужой показ, который мы не смотрим, события не рождает', () => {
    vi.useFakeTimers();
    const f = peerWithScreen();
    try {
      f.media.watchScreen(null);
      f.publications.delete('scr');
      f.room.emit(RoomEvent.TrackUnpublished, f.screen, f.peer);
      vi.advanceTimersByTime(SCREEN_GONE_GRACE_MS * 2);
      expect(f.media.screenGone.get()).toBeNull();
    } finally {
      f.media.dispose();
    }
  });
});

/** Сброс пары экрана по его звуку не трогает камеру и микрофон стримящего. */
describe('переподписка пары дорожек', () => {
  it('звук показа — та же пара, что и его картинка', async () => {
    const { media, room } = fixture();
    const make = (sid: string, source: Track.Source) => {
      const listeners = new Map<string, () => void>();
      return {
        trackSid: sid,
        source,
        isSubscribed: true,
        isDesired: true,
        isEnabled: true,
        isMuted: false,
        setSubscribed: vi.fn((on: boolean) => {
          if (!on) listeners.get('unsubscribed')?.();
        }),
        once: (event: string, fn: () => void) => listeners.set(event, fn),
        off: vi.fn(),
      };
    };
    const screen = make('scr', Track.Source.ScreenShare);
    const screenAudio = make('scra', Track.Source.ScreenShareAudio);
    const camera = make('cam', Track.Source.Camera);
    const mic = make('mic', Track.Source.Microphone);
    room.remoteParticipants.set('peer', {
      identity: 'peer',
      trackPublications: new Map([
        ['scr', screen],
        ['scra', screenAudio],
        ['cam', camera],
        ['mic', mic],
      ]),
    });
    media.watchScreen('peer');
    try {
      await (
        media as unknown as { resetLivePair(i: string, s: Track.Source, a: boolean): Promise<void> }
      ).resetLivePair('peer', Track.Source.ScreenShareAudio, false);
      expect(screen.setSubscribed).toHaveBeenCalledWith(false);
      expect(screenAudio.setSubscribed).toHaveBeenCalledWith(false);
      expect(camera.setSubscribed).not.toHaveBeenCalledWith(false);
      expect(mic.setSubscribed).not.toHaveBeenCalledWith(false);
    } finally {
      media.dispose();
    }
  });
});

/** Игла музыки вычитает наш же запас буфера (R03); без музыки — ноль. */
describe('запас музыки для иглы', () => {
  it('отдаёт запрошенный запас дорожки бота и ноль без неё', () => {
    const { media, room } = fixture();
    try {
      expect(media.musicPlayoutMs()).toBe(0);
      const publication = {
        trackSid: 'music',
        source: Track.Source.Microphone,
        isSubscribed: true,
        track: {},
      };
      room.remoteParticipants.set('bot', {
        identity: 'bot',
        trackPublications: new Map([['music', publication]]),
        audioTrackPublications: new Map([['music', publication]]),
      });
      media.setServiceParticipants(['bot']);
      const playout = (media as unknown as { playout: { prime(t: unknown): number } }).playout;
      playout.prime({ id: 'music', kind: 'media', stats: async () => undefined });
      expect(media.musicPlayoutMs()).toBe(600);
    } finally {
      media.dispose();
    }
  });
});

/** Превью показа: выключено в настройках — кадры не снимаются; включено — уходят командой ядра. */
describe('превью своего показа', () => {
  it('preview:false — источник превью не запускается', () => {
    localStorage.setItem(
      'cord:preferences:v1',
      JSON.stringify({ screen: { resolution: 720, fps: 30, preview: false } }),
    );
    const { media } = fixture();
    try {
      const source = (media as unknown as { previewSource: { start: () => void; stop: () => void } })
        .previewSource;
      const start = vi.spyOn(source, 'start');
      const stop = vi.spyOn(source, 'stop');
      const track = Object.create(LocalVideoTrack.prototype) as LocalVideoTrack;
      Object.defineProperty(track, 'mediaStreamTrack', { value: {} });
      (media as unknown as { screenTracks: unknown[] }).screenTracks = [track];
      (media as unknown as { syncPreview(): void }).syncPreview();
      expect(start).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalled();
    } finally {
      (media as unknown as { screenTracks: unknown[] }).screenTracks = [];
      media.dispose();
      localStorage.clear();
    }
  });

  it('кадр уходит командой screen.preview, а чужой — принимается из сокета', () => {
    const { media, api } = fixture();
    try {
      const source = (
        media as unknown as { previewSource: { start: (t: unknown, send: (b: Uint8Array) => void) => void } }
      ).previewSource;
      let send: ((bytes: Uint8Array) => void) | undefined;
      vi.spyOn(source, 'start').mockImplementation((_track, callback) => {
        send = callback;
      });
      const track = Object.create(LocalVideoTrack.prototype) as LocalVideoTrack;
      Object.defineProperty(track, 'mediaStreamTrack', { value: {} });
      (media as unknown as { screenTracks: unknown[] }).screenTracks = [track];
      (media as unknown as { syncPreview(): void }).syncPreview();
      send!(new Uint8Array([255, 216, 255]));
      expect(api.command).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'screen.preview', image: btoa('\xff\xd8\xff') }),
      );
      vi.stubGlobal('URL', { createObjectURL: () => 'blob:p', revokeObjectURL: () => {} });
      media.acceptPreview('peer', btoa('\xff\xd8\xff'));
      expect(media.screenPreviews.get()).toEqual({ peer: 'blob:p' });
      media.acceptPreview('peer', '***мусор***');
      expect(media.screenPreviews.get()).toEqual({ peer: 'blob:p' });
    } finally {
      (media as unknown as { screenTracks: unknown[] }).screenTracks = [];
      media.dispose();
    }
  });
});

/**
 * Пауза видео от SFU (R117): `TrackStreamStateChanged` → надпись у плитки и показа с задержкой против
 * мигания; пока своя связь потеряна — молчим; сторож зависаний дорожку на паузе не трогает.
 */
describe('пауза видео от SFU', () => {
  function peerWithCamera() {
    const { media, room } = fixture();
    (media as unknown as { patch(v: object): void }).patch({ status: 'connected' });
    let received = 100;
    const stats = vi.fn(
      async () =>
        new Map([
          [
            'in',
            {
              type: 'inbound-rtp',
              kind: 'video',
              timestamp: Date.now(),
              bytesReceived: 1000,
              framesDecoded: 90,
              framesReceived: received,
            },
          ],
        ]),
    );
    const track = { kind: Track.Kind.Video, streamState: Track.StreamState.Active, getRTCStatsReport: stats };
    const camera = {
      trackSid: 'TR_cam',
      source: Track.Source.Camera,
      kind: Track.Kind.Video,
      track,
      isSubscribed: true,
      isEnabled: true,
      isMuted: false,
      isDesired: true,
      setSubscribed: vi.fn(),
    };
    const mic = { ...camera, trackSid: 'TR_mic', source: Track.Source.Microphone, kind: Track.Kind.Audio };
    const peer = {
      identity: 'peer',
      trackPublications: new Map<string, unknown>([
        ['TR_cam', camera],
        ['TR_mic', mic],
      ]),
      videoTrackPublications: new Map([['TR_cam', camera]]),
    };
    room.remoteParticipants.set('peer', peer);
    const setState = (publication: typeof camera, state: Track.StreamState) => {
      publication.track.streamState = state;
      room.emit(RoomEvent.TrackStreamStateChanged, publication, state, peer);
    };
    const checkLive = () => (media as unknown as { checkLive(): Promise<void> }).checkLive();
    const health = () => (media as unknown as { liveHealth: Map<string, unknown> }).liveHealth;
    return {
      media,
      room,
      camera,
      mic,
      setState,
      checkLive,
      health,
      grow: () => (received += 5),
    };
  }

  it('Paused → надпись не раньше 700 мс → Active гасит сразу; звук паузы не рождает', async () => {
    vi.useFakeTimers();
    const f = peerWithCamera();
    try {
      f.setState(f.mic, Track.StreamState.Paused);
      f.setState(f.camera, Track.StreamState.Paused);
      vi.advanceTimersByTime(699);
      expect(f.media.videoPaused.get()).toEqual({});
      vi.advanceTimersByTime(1);
      expect(f.media.videoPaused.get()).toEqual({ TR_cam: true });
      expect(f.media.videoPauseCount.get()).toBe(1);
      f.setState(f.camera, Track.StreamState.Active);
      expect(f.media.videoPaused.get()).toEqual({});
    } finally {
      f.media.dispose();
    }
  });

  it('своя связь потеряна — надпись гаснет; resume с той же паузой — снова через порог', async () => {
    vi.useFakeTimers();
    const f = peerWithCamera();
    try {
      f.setState(f.camera, Track.StreamState.Paused);
      vi.advanceTimersByTime(700);
      f.room.emit(RoomEvent.Reconnecting);
      expect(f.media.videoPaused.get()).toEqual({});
      vi.advanceTimersByTime(3000);
      expect(f.media.videoPaused.get()).toEqual({});
      f.room.emit(RoomEvent.Reconnected);
      vi.advanceTimersByTime(699);
      expect(f.media.videoPaused.get()).toEqual({});
      vi.advanceTimersByTime(1);
      expect(f.media.videoPaused.get()).toEqual({ TR_cam: true });
      // Та же пауза, а не новая.
      expect(f.media.videoPauseCount.get()).toBe(1);
    } finally {
      f.media.dispose();
    }
  });

  it('после полного переподключения дорожка снова идёт — старая пауза не возвращается', async () => {
    vi.useFakeTimers();
    const f = peerWithCamera();
    try {
      f.setState(f.camera, Track.StreamState.Paused);
      vi.advanceTimersByTime(700);
      f.room.emit(RoomEvent.Reconnecting);
      f.camera.track.streamState = Track.StreamState.Active;
      f.room.emit(RoomEvent.Reconnected);
      vi.advanceTimersByTime(5000);
      expect(f.media.videoPaused.get()).toEqual({});
    } finally {
      f.media.dispose();
    }
  });

  it('сторож зависаний не трогает дорожку на паузе; новые кадры из сети гасят надпись без Active', async () => {
    vi.useFakeTimers();
    const f = peerWithCamera();
    try {
      await f.checkLive();
      expect(f.health().has('TR_cam')).toBe(true);
      f.setState(f.camera, Track.StreamState.Paused);
      vi.advanceTimersByTime(700);
      await f.checkLive();
      // На паузе — ни наблюдения, ни истории: после паузы сторож начнёт с чистого листа.
      expect(f.health().has('TR_cam')).toBe(false);
      await f.checkLive();
      expect(f.media.videoPaused.get()).toEqual({ TR_cam: true });
      f.grow();
      await f.checkLive();
      expect(f.media.videoPaused.get()).toEqual({});
      expect(f.camera.setSubscribed).not.toHaveBeenCalled();
      // Картинка идёт — сторож снова смотрит за ней.
      await f.checkLive();
      expect(f.health().has('TR_cam')).toBe(true);
    } finally {
      f.media.dispose();
    }
  });

  it('SFU замолчал без слова «пауза»: кадров нет 4 с при живом звуке — та же надпись, новые кадры гасят (R119)', async () => {
    vi.useFakeTimers();
    const f = peerWithCamera();
    const flowing = (on: boolean) => ((f.media as unknown as { audioFlowing: boolean }).audioFlowing = on);
    // Опрос буфера здесь не идёт (в комнате нет звука): свидетель звука задаётся руками.
    (f.media as unknown as { tunePlayout(): Promise<void> }).tunePlayout = async () => {};
    try {
      flowing(true);
      await f.checkLive();
      await vi.advanceTimersByTimeAsync(2000);
      await f.checkLive();
      await vi.advanceTimersByTimeAsync(2000);
      await f.checkLive();
      expect(f.media.videoPaused.get()).toEqual({});
      await vi.advanceTimersByTimeAsync(700);
      expect(f.media.videoPaused.get()).toEqual({ TR_cam: true });
      expect(f.media.videoPauseCount.get()).toBe(1);
      // Сторож зависаний на выведенной паузе молчит, как и на паузе от SFU.
      await f.checkLive();
      expect(f.health().has('TR_cam')).toBe(false);
      expect(f.camera.setSubscribed).not.toHaveBeenCalled();
      f.grow();
      await f.checkLive();
      expect(f.media.videoPaused.get()).toEqual({});
      // Без звука тишина камеры — не пауза: молчит весь путь.
      flowing(false);
      await f.checkLive();
      await vi.advanceTimersByTimeAsync(6000);
      await f.checkLive();
      await vi.advanceTimersByTimeAsync(700);
      expect(f.media.videoPaused.get()).toEqual({});
    } finally {
      f.media.dispose();
    }
  });

  it('отписка от дорожки снимает её паузу', async () => {
    vi.useFakeTimers();
    const f = peerWithCamera();
    try {
      f.room.emit(RoomEvent.TrackSubscribed);
      await Promise.resolve();
      f.setState(f.camera, Track.StreamState.Paused);
      vi.advanceTimersByTime(700);
      expect(f.media.videoPaused.get()).toEqual({ TR_cam: true });
      (f.camera as { track?: unknown }).track = undefined;
      f.room.emit(RoomEvent.TrackUnsubscribed);
      await Promise.resolve();
      expect(f.media.videoPaused.get()).toEqual({});
    } finally {
      f.media.dispose();
    }
  });
});

/**
 * Смена качества камеры во встрече — на месте (27.10.2026). Раньше это был новый захват, снятие с
 * публикации и публикация заново: у зрителя плитка гасла, а на телефоне камера оставалась
 * выключенной до нового нажатия.
 */
describe('качество камеры во встрече', () => {
  it('меняет кадр и полосу у той же дорожки, не захватывая и не публикуя её заново', async () => {
    const { media, room } = fixture();
    try {
      const { track, media: capture, sender } = fakeCameraTrack();
      const restartTrack = vi.fn(async () => {});
      Object.assign(track, { restartTrack });
      const publication = { track, options: { videoEncoding: { maxBitrate: 3000000, maxFramerate: 30 } } };
      const local = (room as unknown as { localParticipant: Record<string, unknown> }).localParticipant;
      (local.trackPublications as Map<Track.Source, unknown>).set(Track.Source.Camera, publication);
      local.unpublishTrack = vi.fn(async () => {});
      (media as unknown as { wanted: { camera: boolean } }).wanted.camera = true;

      await media.setCameraProfile({ resolution: 1080, fps: 60 });

      expect(capture.applyConstraints).toHaveBeenCalledWith(
        expect.objectContaining({ frameRate: { min: 60, ideal: 60 } }),
      );
      expect(sender.setParameters).toHaveBeenCalled();
      expect(restartTrack).not.toHaveBeenCalled();
      expect(local.unpublishTrack).not.toHaveBeenCalled();
      expect(local.publishTrack).not.toHaveBeenCalled();
      expect(publication.options.videoEncoding).toEqual({ maxBitrate: 10000000, maxFramerate: 60 });
    } finally {
      media.dispose();
      localStorage.clear();
    }
  });
});

/** Первое включение камеры на телефоне — фронтальная, а не запомненная (27.10.2026, владелец). */
describe('первое включение камеры', () => {
  function phone(coarse: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: coarse && query === '(pointer: coarse)' }));
  }
  function mount() {
    const { media, room } = fixture();
    const local = (room as unknown as { localParticipant: Record<string, unknown> }).localParticipant;
    const setCameraEnabled = vi.fn(async (enabled: boolean, _capture?: unknown) => {
      local.isCameraEnabled = enabled;
    });
    local.setCameraEnabled = setCameraEnabled;
    return { media, room, setCameraEnabled };
  }
  afterEach(() => vi.unstubAllGlobals());

  it('на телефоне — фронтальная; повторное включение — уже выбранная камера', async () => {
    phone(true);
    const { media, setCameraEnabled } = mount();
    try {
      await media.toggle('camera', 'back-camera');
      expect(setCameraEnabled.mock.calls[0]![1]).toMatchObject({ facingMode: 'user' });
      expect(setCameraEnabled.mock.calls[0]![1]).not.toHaveProperty('deviceId');
      media.state.set({ ...media.state.get(), camera: true });
      await media.toggle('camera');
      media.state.set({ ...media.state.get(), camera: false });
      await media.toggle('camera', 'back-camera');
      expect(setCameraEnabled.mock.calls[2]![1]).toMatchObject({ deviceId: 'back-camera' });
    } finally {
      media.dispose();
    }
  });

  it('на компьютере — выбранная в настройках камера', async () => {
    phone(false);
    const { media, setCameraEnabled } = mount();
    try {
      await media.toggle('camera', 'usb-camera');
      expect(setCameraEnabled.mock.calls[0]![1]).toMatchObject({ deviceId: 'usb-camera' });
      expect(setCameraEnabled.mock.calls[0]![1]).not.toHaveProperty('facingMode');
    } finally {
      media.dispose();
    }
  });

  /*
    LiveKit дописывает к захвату `deviceId` из умолчаний комнаты (`videoCaptureDefaults`) и делает строку
    точным требованием (`{ exact }`): запомненная после «перевернуть» задняя перебивала `facingMode: 'user'`,
    и встреча начиналась с задней камеры — даже после фронтальной на предвходе.
  */
  it('на телефоне запомненная задняя не попадает в захват фронтальной', async () => {
    phone(true);
    localStorage.setItem('cord:preferences:v1', JSON.stringify({ devices: { camera: 'back-camera' } }));
    const { media, room, setCameraEnabled } = mount();
    let remembered: unknown = 'не звали';
    setCameraEnabled.mockImplementationOnce(async () => {
      remembered = room.options.videoCaptureDefaults?.deviceId;
    });
    try {
      await media.toggle('camera', 'back-camera');
      expect(setCameraEnabled.mock.calls[0]![1]).toMatchObject({ facingMode: 'user' });
      expect(remembered).toBeUndefined();
    } finally {
      media.dispose();
      localStorage.clear();
    }
  });

  it('включилась фронтальная — она и запоминается: настройки, смена качества и восстановление берут её', async () => {
    phone(true);
    localStorage.setItem('cord:preferences:v1', JSON.stringify({ devices: { camera: 'back-camera' } }));
    const { media, room, setCameraEnabled } = mount();
    const camera = fakeCameraTrack();
    Object.assign(camera.settings, { deviceId: 'front-camera', facingMode: 'user' });
    const local = media.room.localParticipant as unknown as {
      trackPublications: Map<Track.Source, { track?: unknown }>;
      isCameraEnabled: boolean;
    };
    setCameraEnabled.mockImplementationOnce(async () => {
      local.isCameraEnabled = true;
      local.trackPublications.set(Track.Source.Camera, { track: camera.track });
    });
    try {
      await media.toggle('camera', 'back-camera');
      expect(media.preferences.get().devices.camera).toBe('front-camera');
      expect(JSON.parse(localStorage.getItem('cord:preferences:v1')!).devices.camera).toBe('front-camera');
      expect(room.options.videoCaptureDefaults?.deviceId).toBe('front-camera');
    } finally {
      media.dispose();
      localStorage.clear();
    }
  });
});

/*
  Зум (R36) просится у телефона в самом захвате (`zoom: true`). Chromium не терпит его в
  `applyConstraints` рядом с кадром: «Mixing ImageCapture and non-ImageCapture constraints is not
  currently supported». А LiveKit применяет захват именно так — после перезапуска дорожки: при
  включении камеры после выключения, перевороте, смене камеры и качества. На Android камера после
  выключения больше не включалась, а переворот гасил её совсем.
*/
describe('зум и перезапуск камеры на телефоне', () => {
  function phone() {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }));
  }
  afterEach(() => vi.unstubAllGlobals());

  it('включили — дорожка не помнит зум: включение после выключения и смена камеры не падают', async () => {
    phone();
    const { media } = fixture();
    const local = media.room.localParticipant as unknown as {
      trackPublications: Map<Track.Source, { track?: unknown }>;
      isCameraEnabled: boolean;
      setCameraEnabled: unknown;
    };
    const camera = fakeCameraTrack();
    Object.assign(camera.track, { _constraints: { width: 854, height: 480, frameRate: 30, zoom: true } });
    local.setCameraEnabled = vi.fn(async () => {
      local.isCameraEnabled = true;
      local.trackPublications.set(Track.Source.Camera, { track: camera.track });
    });
    try {
      await media.toggle('camera');
      expect(camera.track.constraints).toEqual({ width: 854, height: 480, frameRate: 30 });
    } finally {
      media.dispose();
      localStorage.clear();
    }
  });

  it('перевернуть — перезапуск без зума', async () => {
    phone();
    const { media } = fixture();
    const local = media.room.localParticipant as unknown as {
      trackPublications: Map<Track.Source, { track?: unknown }>;
    };
    const camera = fakeCameraTrack();
    Object.assign(camera.settings, { deviceId: 'front-camera', facingMode: 'user' });
    const restartTrack = vi.fn(async (_options?: Record<string, unknown>) => {});
    Object.assign(camera.track, { restartTrack });
    local.trackPublications.set(Track.Source.Camera, { track: camera.track });
    media.state.set({ ...media.state.get(), camera: true });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices: async () => [] },
    });
    try {
      await media.flipCamera();
      expect(restartTrack).toHaveBeenCalledTimes(1);
      expect(restartTrack.mock.calls[0]![0]).toMatchObject({ facingMode: 'environment' });
      expect(restartTrack.mock.calls[0]![0]).not.toHaveProperty('zoom');
    } finally {
      media.dispose();
      localStorage.clear();
      delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    }
  });
});
