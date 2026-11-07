import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RoomEvent,
  DisconnectReason,
  Track,
  LocalAudioTrack,
  LocalVideoTrack,
  createLocalAudioTrack,
  type RoomOptions,
} from 'livekit-client';
import {
  HANDED_MICROPHONE_MS,
  HOLD_CAMERA_MS,
  MediaSession,
  MIC_UNMUTE_GRACE_MS,
  SCREEN_GONE_GRACE_MS,
} from './session';
import type { RoomApi } from '../api/client';
import type { CaptureAdapter, ScreenAudioEvent, ScreenAudioSource } from './capture';
import { fakeCameraTrack } from './fake-track';
import { CordAudioProcessor } from './audio';
import { signal, soundVolume } from '../core/sounds';
import { savePreferences } from '../core/preferences';

vi.mock('../core/sounds', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/sounds')>()),
  signal: vi.fn(),
}));

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

  /**
   * livekit-client ставит показу VP9/AV1 `contentHint = 'motion'` внутри `publishTrack` — и
   * кодировщик теряет screencast-режим (Р-84). Подсказка возвращается после публикации, а захват и
   * кодировщик в «чёткости» по умолчанию просят не больше 15 кадров.
   */
  it('возвращает screencast-подсказку после публикации и просит у захвата частоту «чёткости»', async () => {
    const { media, room, video, permissions, publishTrack } = screenFixture();
    publishTrack.mockImplementation(async () => {
      // Как LiveKit: подсказка сбита посреди публикации.
      (video as unknown as { contentHint: string }).contentHint = 'motion';
      return {
        track: {
          source: Track.Source.ScreenShare,
          kind: Track.Kind.Video,
          mediaStreamTrack: video,
          stop: video.stop,
        },
      };
    });
    permissions.canPublishSources.push(Track.sourceToProto(Track.Source.ScreenShare));
    room.emit(RoomEvent.ParticipantPermissionsChanged);
    try {
      media.share({ resolution: 1080, fps: 30 });
      await vi.waitFor(() => expect(publishTrack).toHaveBeenCalledOnce());
      expect((video as unknown as { contentHint: string }).contentHint).toBe('detail');
      expect(video.applyConstraints).toHaveBeenCalledWith(
        expect.objectContaining({ frameRate: { max: 15 }, height: { max: 1080 } }),
      );
      expect((publishTrack.mock.calls[0] as unknown[])[1]).toMatchObject({
        screenShareEncoding: { maxFramerate: 15, maxBitrate: 4000000 },
      });
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

  it('звук встречи выключили, пока микрофон включался, — микрофон выключается, а со звуком возвращается', async () => {
    const { media } = micFixture();
    const inner = media as unknown as { deviceBusy: Set<string> };
    try {
      // Включение в пути (захват, окно разрешения): `state` ещё «выключен».
      inner.deviceBusy.add('microphone');
      media.micHeading.set(true);
      const deafen = media.setDeafened(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      media.state.set({ ...media.state.get(), microphone: true });
      media.micHeading.set(undefined);
      inner.deviceBusy.delete('microphone');
      await deafen;
      expect(media.deafened.get()).toBe(true);
      expect(media.state.get().microphone).toBe(false);
      await media.setDeafened(false);
      expect(media.state.get().microphone).toBe(true);
    } finally {
      await media.setDeafened(false);
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

/*
  Микрофон (R160): «включается очень долго, странные звуки, на каждое включение просит разрешение».
  Захват — один раз на встречу; дальше выключить/включить — mute/unmute той же дорожки, шумодав не
  пересобирается, сигнал звучит один раз. Звук встречи (R161) — только у этой сессии.
*/
describe('микрофон: один захват на встречу (R160)', () => {
  type Raw = EventTarget & { readyState: string; muted: boolean; enabled: boolean; stop: () => void };
  function rawTrack(): Raw {
    return Object.assign(new EventTarget(), {
      readyState: 'live',
      muted: false,
      enabled: true,
      stop: vi.fn(),
    });
  }
  /** Дорожка LiveKit без браузера: настоящие геттеры `LocalAudioTrack`, свои захват и обработчик. */
  function audioTrack(raw = rawTrack()) {
    const track = Object.create(LocalAudioTrack.prototype) as LocalAudioTrack & {
      _mediaStreamTrack: Raw;
      processor?: CordAudioProcessor;
      isMuted: boolean;
    };
    const setProcessor = vi.fn(async (processor: CordAudioProcessor) => {
      Object.assign(processor, { processedTrack: { readyState: 'live' }, input: track._mediaStreamTrack });
      track.processor = processor;
    });
    Object.assign(track, {
      _mediaStreamTrack: raw,
      processor: undefined,
      kind: Track.Kind.Audio,
      source: Track.Source.Microphone,
      isMuted: false,
      setAudioContext: vi.fn(),
      setProcessor,
      stopProcessor: vi.fn(async () => {
        track.processor = undefined;
      }),
      restartTrack: vi.fn(async () => {}),
      mute: vi.fn(async () => {
        track.isMuted = true;
      }),
      stop: vi.fn(),
    });
    return { track, raw, setProcessor };
  }
  function micSession(
    audio: { suppression: 'rnnoise' | 'browser'; gain?: number } = { suppression: 'rnnoise' },
  ) {
    savePreferences({
      audio: {
        suppression: audio.suppression,
        suppressionChosen: true,
        echoCancellation: true,
        autoGainControl: true,
        gain: audio.gain ?? 1,
      },
    });
    const f = fixture();
    const { track, raw, setProcessor } = audioTrack();
    vi.mocked(createLocalAudioTrack)
      .mockReset()
      .mockResolvedValue(track as never);
    const local = (f.room as unknown as { localParticipant: Record<string, unknown> }).localParticipant;
    const publications = local.trackPublications as Map<Track.Source, unknown>;
    const publication = {
      trackSid: 'TR_mic',
      source: Track.Source.Microphone,
      track,
      get isMuted() {
        return track.isMuted;
      },
    };
    const order: string[] = [];
    setProcessor.mockImplementation(async (processor: CordAudioProcessor) => {
      order.push('processor');
      Object.assign(processor, { processedTrack: { readyState: 'live' }, input: track._mediaStreamTrack });
      track.processor = processor;
    });
    local.isLocal = true;
    local.publishTrack = vi.fn(async () => {
      order.push(track.isMuted ? 'publish-muted' : 'publish');
      publications.set(Track.Source.Microphone, publication);
      local.isMicrophoneEnabled = !track.isMuted;
      return publication;
    });
    // Как LiveKit: `mute()` синхронно шлёт `TrackMuted` своего участника — посреди `toggle`.
    local.setMicrophoneEnabled = vi.fn(async (on: boolean) => {
      track.isMuted = !on;
      local.isMicrophoneEnabled = on;
      f.room.emit(on ? RoomEvent.TrackUnmuted : RoomEvent.TrackMuted, publication, local);
    });
    vi.mocked(signal).mockClear();
    return { ...f, local, track, raw, setProcessor, order, publication };
  }
  afterEach(() => localStorage.clear());

  it('включить, выключить, включить ×5 — один захват, шумодав собран один раз и до публикации', async () => {
    const { media, local, setProcessor, order } = micSession();
    try {
      for (let i = 0; i < 5; i++) {
        await media.toggle('microphone');
        expect(media.state.get().microphone).toBe(true);
        await media.toggle('microphone');
        expect(media.state.get().microphone).toBe(false);
      }
      expect(createLocalAudioTrack).toHaveBeenCalledOnce();
      expect(local.publishTrack).toHaveBeenCalledOnce();
      expect(setProcessor).toHaveBeenCalledOnce();
      // Комната не слышит сырой микрофон: обработчик стоит раньше публикации.
      expect(order).toEqual(['processor', 'publish']);
      expect(local.setMicrophoneEnabled).toHaveBeenCalledTimes(9);
    } finally {
      media.dispose();
    }
  });

  it('каждое переключение — один сигнал: свой TrackMuted не звучит вторым «выключен»', async () => {
    const { media } = micSession({ suppression: 'browser' });
    try {
      await media.toggle('microphone');
      await media.toggle('microphone');
      await media.toggle('microphone');
      expect(vi.mocked(signal).mock.calls.map(([cue]) => cue)).toEqual(['mic-on', 'mic-off', 'mic-on']);
    } finally {
      media.dispose();
    }
  });

  it('микрофон выключил ведущий — сигнал звучит, как и раньше', async () => {
    const { media, room, publication, local, track } = micSession({ suppression: 'browser' });
    try {
      await media.toggle('microphone');
      vi.mocked(signal).mockClear();
      track.isMuted = true;
      local.isMicrophoneEnabled = false;
      room.emit(RoomEvent.TrackMuted, publication, local);
      expect(vi.mocked(signal).mock.calls.map(([cue]) => cue)).toEqual(['mic-off']);
    } finally {
      media.dispose();
    }
  });

  it('кнопка знает, куда идёт включение, пока идут захват и публикация', async () => {
    const { media } = micSession({ suppression: 'browser' });
    let release!: () => void;
    vi.mocked(createLocalAudioTrack).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return audioTrack().track as never;
    });
    try {
      const going = media.toggle('microphone');
      expect(media.micHeading.get()).toBe(true);
      expect(media.state.get().microphone).toBe(false);
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      release();
      await going;
      expect(media.micHeading.get()).toBeUndefined();
    } finally {
      media.dispose();
    }
  });

  it('громкость меняется на месте, шумодав пересобирается только при смене самого шумодава', async () => {
    const { media, track, setProcessor } = micSession({ suppression: 'rnnoise' });
    Object.assign(track, { applyConstraints: vi.fn(async () => {}) });
    try {
      await media.toggle('microphone');
      const first = track.processor!;
      const setGain = vi.spyOn(first, 'setGain');
      const audio = media.preferences.get().audio;
      await media.setAudioSettings({ ...audio, gain: 1.5 });
      expect(setGain).toHaveBeenCalledWith(1.5);
      expect(setProcessor).toHaveBeenCalledOnce();
      await media.setAudioSettings({ ...audio, suppression: 'browser', gain: 1.5 });
      expect(setProcessor).toHaveBeenCalledTimes(2);
      await media.setAudioSettings({ ...audio, suppression: 'browser', gain: 1 });
      expect(track.stopProcessor).toHaveBeenCalledOnce();
    } finally {
      media.dispose();
    }
  });

  it('телефон (R147): заглушённый системой захват ждёт, пока система снимет заглушку сама', async () => {
    vi.useFakeTimers();
    const { media, track, raw } = micSession({ suppression: 'browser' });
    try {
      await media.toggle('microphone');
      await media.toggle('microphone');
      raw.muted = true;
      const on = media.toggle('microphone');
      await vi.advanceTimersByTimeAsync(100);
      raw.muted = false;
      raw.dispatchEvent(new Event('unmute'));
      await on;
      expect(track.restartTrack).not.toHaveBeenCalled();
      expect(media.state.get().microphone).toBe(true);

      await media.toggle('microphone');
      raw.muted = true;
      const again = media.toggle('microphone');
      await vi.advanceTimersByTimeAsync(MIC_UNMUTE_GRACE_MS);
      await again;
      // Не сняла — тогда перезахват, один.
      expect(track.restartTrack).toHaveBeenCalledOnce();
    } finally {
      media.dispose();
    }
  });

  it('сторож (R147) смотрит на захват, а не на выход шумодава: микрофон кончился — перезахват', async () => {
    const { media, track, raw } = micSession({ suppression: 'rnnoise' });
    try {
      await media.toggle('microphone');
      // Выход шумодава «жив», а сам микрофон отобрала система (звонок GSM).
      raw.readyState = 'ended';
      expect(track.mediaStreamTrack).toMatchObject({ readyState: 'live' });
      await (media as unknown as { micSentinel: { check(): Promise<void> } }).micSentinel.check();
      expect(track.restartTrack).toHaveBeenCalledOnce();
    } finally {
      media.dispose();
    }
  });

  it('смена обработки звука не стирает устройство захвата: перезахват LiveKit шёл бы в { audio: true }', async () => {
    const { media, track } = micSession({ suppression: 'browser' });
    const applyConstraints = vi.fn(async () => {});
    Object.assign(track, { applyConstraints });
    try {
      await media.toggle('microphone');
      const audio = media.preferences.get().audio;
      await media.setAudioSettings({ ...audio, echoCancellation: false });
      expect(applyConstraints).toHaveBeenCalled();
      const last = applyConstraints.mock.calls.at(-1) as unknown as [Record<string, unknown>];
      expect(last[0]).not.toHaveProperty('deviceId');
      expect(last[0]).toMatchObject({ echoCancellation: false });
    } finally {
      media.dispose();
    }
  });

  it('пока собирался шумодав, микрофон уже опубликовало переподключение — второй публикации нет', async () => {
    const { media, local, track, publication } = micSession({ suppression: 'rnnoise' });
    const publications = local.trackPublications as Map<Track.Source, unknown>;
    const second = audioTrack();
    vi.mocked(createLocalAudioTrack).mockResolvedValueOnce(second.track as never);
    let release!: () => void;
    second.setProcessor.mockImplementationOnce(async (processor: CordAudioProcessor) => {
      await new Promise<void>((resolve) => (release = resolve));
      second.track.processor = processor;
    });
    const unmute = vi.fn(async () => {
      track.isMuted = false;
    });
    Object.assign(track, { unmute });
    try {
      const going = media.toggle('microphone');
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      track.isMuted = true;
      publications.set(Track.Source.Microphone, publication);
      release();
      await going;
      expect(local.publishTrack).not.toHaveBeenCalled();
      expect(second.track.stop).toHaveBeenCalled();
      expect(unmute).toHaveBeenCalled();
    } finally {
      media.dispose();
    }
  });
});

describe('микрофон с предвхода (R160)', () => {
  function handed(deviceId = 'mic-a') {
    return Object.assign(new EventTarget(), {
      kind: 'audio',
      id: 'prejoin',
      readyState: 'live',
      muted: false,
      enabled: true,
      stop: vi.fn(),
      getSettings: () => ({ deviceId }),
      getConstraints: () => ({ deviceId }),
      applyConstraints: vi.fn(async () => {}),
    }) as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
  }
  function session() {
    vi.stubGlobal('MediaStream', class {});
    savePreferences({ devices: { microphone: 'mic-a' } });
    const f = fixture();
    const local = (f.room as unknown as { localParticipant: Record<string, unknown> }).localParticipant;
    local.publishTrack = vi.fn(async () => ({}));
    vi.mocked(createLocalAudioTrack).mockReset();
    return { ...f, local };
  }
  afterEach(() => localStorage.clear());

  it('первое включение во встрече публикует микрофон предвхода, второго захвата нет', async () => {
    const { media, local } = session();
    const track = handed();
    try {
      media.adoptMicrophone(track);
      await media.toggle('microphone', 'mic-a', false);
      expect(createLocalAudioTrack).not.toHaveBeenCalled();
      const [published] = vi.mocked(local.publishTrack as (t: unknown) => Promise<unknown>).mock.calls[0]!;
      expect(published).toBeInstanceOf(LocalAudioTrack);
      expect((published as LocalAudioTrack).mediaStreamTrack).toBe(track);
      expect(track.stop).not.toHaveBeenCalled();
    } finally {
      media.dispose();
    }
  });

  it('другое устройство, вышло время или встреча кончилась — микрофон предвхода отпускается', async () => {
    vi.useFakeTimers();
    const { media } = session();
    vi.mocked(createLocalAudioTrack).mockRejectedValue(new DOMException('нет', 'NotAllowedError'));
    try {
      const other = handed('mic-b');
      media.adoptMicrophone(other);
      await media.toggle('microphone', 'mic-a', false);
      expect(other.stop).toHaveBeenCalled();
      expect(createLocalAudioTrack).toHaveBeenCalledOnce();

      const late = handed();
      media.adoptMicrophone(late);
      await vi.advanceTimersByTimeAsync(HANDED_MICROPHONE_MS);
      expect(late.stop).toHaveBeenCalled();

      const left = handed();
      media.adoptMicrophone(left);
      media.dispose();
      expect(left.stop).toHaveBeenCalled();
    } finally {
      media.dispose();
    }
  });
});

describe('звук встречи — у встречи, а не в настройках (R161)', () => {
  afterEach(() => localStorage.clear());

  it('новая встреча начинается со звуком, даже если в прошлой его выключили', async () => {
    // Запись прошлых версий: тогда звук встречи помнился в настройках.
    localStorage.setItem('cord:preferences:v1', JSON.stringify({ deafened: true }));
    const first = fixture().media;
    expect(first.deafened.get()).toBe(false);
    localStorage.clear();
    await first.setDeafened(true);
    expect(first.deafened.get()).toBe(true);
    expect(soundVolume()).toBe(0);
    // В настройки (и оттуда — на другие серверы, R146) не попадает.
    expect(localStorage.getItem('cord:preferences:v1') ?? '').not.toContain('deafened');
    // Вышли из встречи — сигналы приложения снова звучат.
    first.dispose();
    expect(soundVolume()).toBeGreaterThan(0);
    const second = fixture().media;
    try {
      expect(second.deafened.get()).toBe(false);
    } finally {
      second.dispose();
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

/*
  Сеть не пропускает звонок (R149): сигнал до SFU дошёл, а ICE — нет. SDK в этом случае сначала шлёт
  `Disconnected`, потом отвергает `connect` («could not establish pc connection»).
*/
describe('сеть не пропускает звонок', () => {
  const TLS = [{ urls: ['turn:192.0.2.1:3478?transport=udp', 'turns:turn.example:443?transport=tcp'] }];
  type Fake = EventEmitter & {
    state: string;
    engine?: { latestJoinResponse?: { iceServers: typeof TLS } };
    connect: ReturnType<typeof vi.fn>;
  };
  function blockedFixture() {
    const f = fixture();
    Object.assign(f.api, { resume: vi.fn(async () => ({ reset: false, snapshot: null })) });
    const room = f.room as unknown as Fake;
    room.state = 'disconnected';
    /** Попытка, где сигнал доходит (`servers`) или нет (`null`), а медиа не встаёт. */
    const fail = (servers: typeof TLS | null) =>
      room.connect.mockImplementationOnce(async () => {
        if (servers) {
          room.engine = { latestJoinResponse: { iceServers: servers } };
          room.emit(RoomEvent.SignalConnected);
        }
        room.emit(RoomEvent.Disconnected, DisconnectReason.UNKNOWN_REASON);
        throw new Error(
          servers ? 'could not establish pc connection' : 'could not establish signal connection',
        );
      });
    const reports = () =>
      (f.api.command as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([command]) => (command as { option?: string }).option === 'ice-failed',
      );
    return { ...f, room, fail, reports };
  }

  it('вместо отсчёта и чужого английского — надпись; ядро узнаёт один раз; попытки идут без конца встречи', async () => {
    vi.useFakeTimers();
    const { media, room, fail, reports, ended } = blockedFixture();
    try {
      for (let i = 0; i < 20; i++) fail(TLS);
      await media.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(media.state.get()).toMatchObject({ status: 'connecting', blocked: { tls: true }, error: null });
      expect(media.recovery.active).toBe(false);
      expect(reports()).toHaveLength(1);
      expect(reports()[0]![0]).toMatchObject({ type: 'media.lost', generation: 1 });
      // Минута — втрое дольше окна восстановления: встреча идёт, попытки — раз в несколько секунд.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ended).not.toHaveBeenCalled();
      expect(room.connect.mock.calls.length).toBeGreaterThanOrEqual(10);
      expect(reports()).toHaveLength(1);
      expect(media.state.get().status).toBe('connecting');
      // Сеть нашлась: медиа встало — надписи нет.
      room.connect.mockReset();
      room.connect.mockImplementation(async () => {
        room.state = 'connected';
        room.emit(RoomEvent.Connected);
      });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(media.state.get()).toMatchObject({ status: 'connected', blocked: null });
    } finally {
      media.dispose();
    }
  });

  it('сервер без TURN/TLS — надпись просит владельца; сменилась сеть — попытка сразу', async () => {
    vi.useFakeTimers();
    const { media, room, fail } = blockedFixture();
    try {
      fail([{ urls: ['turn:192.0.2.1:3478?transport=udp'] }]);
      await media.start();
      expect(media.state.get().blocked).toEqual({ tls: false });
      fail(null);
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
      expect(room.connect).toHaveBeenCalledTimes(2);
      // Сигнал на этот раз не дошёл — это всё та же сеть, что не пропускает: без отсчёта, слово о TLS прежнее.
      expect(media.state.get()).toMatchObject({ status: 'connecting', blocked: { tls: false } });
    } finally {
      media.dispose();
    }
  });

  it('сигнал не дошёл при первом входе — как раньше: отсчёт восстановления и фраза для человека, а не текст SDK', async () => {
    vi.useFakeTimers();
    const { media, fail, reports } = blockedFixture();
    try {
      fail(null);
      await media.start();
      expect(media.state.get()).toMatchObject({ status: 'recovering', blocked: null });
      expect(media.state.get().error).toBe('Звук и видео пока не подключились — пробуем ещё раз');
      await vi.advanceTimersByTimeAsync(0);
      expect(reports()).toHaveLength(0);
    } finally {
      media.dispose();
    }
  });

  it('сначала не дошёл сигнал, потом — медиа: отсчёт снят, встреча не кончается через двадцать секунд', async () => {
    vi.useFakeTimers();
    const { media, fail, ended } = blockedFixture();
    try {
      fail(null);
      for (let i = 0; i < 20; i++) fail(TLS);
      await media.start();
      expect(media.state.get().status).toBe('recovering');
      await vi.advanceTimersByTimeAsync(0);
      expect(media.state.get()).toMatchObject({ status: 'connecting', blocked: { tls: true }, error: null });
      expect(media.recovery.active).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ended).not.toHaveBeenCalled();
      expect(media.state.get().status).toBe('connecting');
    } finally {
      media.dispose();
    }
  });

  it('после первого подключения провал с живым сигналом — обычное восстановление, а не «сеть не пропускает»', async () => {
    vi.useFakeTimers();
    const { media, room, fail } = blockedFixture();
    try {
      room.connect.mockImplementationOnce(async () => {
        room.state = 'connected';
        room.emit(RoomEvent.Connected);
      });
      await media.start();
      expect(media.state.get().status).toBe('connected');
      fail(TLS);
      room.state = 'disconnected';
      room.emit(RoomEvent.Disconnected, DisconnectReason.UNKNOWN_REASON);
      await vi.advanceTimersByTimeAsync(0);
      expect(media.state.get()).toMatchObject({ status: 'recovering', blocked: null });
    } finally {
      media.dispose();
    }
  });
});

/** Рычаг поддержки (`turn-tls.ts`): только ретранслятор и только `turns:` из ответа на вход. */
describe('только TURN по TLS', () => {
  afterEach(() => localStorage.removeItem('cord:relay'));

  it('connect получает rtcConfig: relay и серверы turns: — в момент сборки, после ответа на вход', async () => {
    localStorage.setItem('cord:relay', 'tls');
    const { media, room } = fixture();
    try {
      expect(media.relayOnly).toBe(true);
      await media.start();
      const options = (room as unknown as { connect: ReturnType<typeof vi.fn> }).connect.mock
        .calls[0]![2] as {
        rtcConfig: RTCConfiguration;
      };
      expect({ ...options.rtcConfig }).toEqual({ iceTransportPolicy: 'relay', iceServers: [] });
      Object.assign(room, {
        engine: {
          latestJoinResponse: {
            iceServers: [
              {
                urls: ['turn:192.0.2.1:3478?transport=udp', 'turns:turn.example:443?transport=tcp'],
                username: 'u',
                credential: 'c',
              },
            ],
          },
        },
      });
      expect({ ...options.rtcConfig }.iceServers).toEqual([
        { urls: ['turns:turn.example:443?transport=tcp'], username: 'u', credential: 'c' },
      ]);
    } finally {
      media.dispose();
    }
  });

  it('без флага — серверы ICE остаются за SDK', async () => {
    const { media, room } = fixture();
    try {
      await media.start();
      const options = (room as unknown as { connect: ReturnType<typeof vi.fn> }).connect.mock.calls[0]![2];
      expect(options).not.toHaveProperty('rtcConfig');
    } finally {
      media.dispose();
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
    // Отписка в SDK кончается событием: без него переподписка ждала бы свои 2 с настоящего таймера.
    let unsubscribed: (() => void) | undefined;
    const camera = {
      trackSid: 'TR_cam',
      source: Track.Source.Camera,
      kind: Track.Kind.Video,
      track,
      isSubscribed: true,
      isEnabled: true,
      isMuted: false,
      isDesired: true,
      once: vi.fn((_event: string, done: () => void) => (unsubscribed = done)),
      off: vi.fn(),
      setSubscribed: vi.fn((subscribed: boolean) => {
        if (!subscribed) unsubscribed?.();
      }),
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
      peer,
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
      expect(f.media.videoPaused.get()).toEqual({ TR_cam: 'sfu' });
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
      expect(f.media.videoPaused.get()).toEqual({ TR_cam: 'sfu' });
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
      expect(f.media.videoPaused.get()).toEqual({ TR_cam: 'sfu' });
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

  it('SFU замолчал без слова «пауза»: своя надпись, не «слабая связь», и сторож чинит, со звуком или без (R189)', async () => {
    vi.useFakeTimers();
    const f = peerWithCamera();
    try {
      await f.checkLive();
      // Кадры стоят 4 с — сторож пробует переподписать раньше, чем что-то скажет.
      for (let i = 0; i < 2; i++) {
        await vi.advanceTimersByTimeAsync(2000);
        await f.checkLive();
      }
      expect(f.camera.setSubscribed).toHaveBeenCalledWith(false);
      expect(f.media.videoPaused.get()).toEqual({});
      await vi.advanceTimersByTimeAsync(3000);
      expect(f.media.videoPaused.get()).toEqual({ TR_cam: 'silent' });
      // Паузой от SFU это не считается: её счётчик и слова — про канал зрителя.
      expect(f.media.videoPauseCount.get()).toBe(0);
      expect(f.media.videoStallCount.get()).toBe(1);
      // Сторож зависаний дальше смотрит за дорожкой: тишина его больше не выключает.
      expect(f.health().has('TR_cam')).toBe(true);
      f.grow();
      await f.checkLive();
      f.grow();
      await f.checkLive();
      expect(f.media.videoPaused.get()).toEqual({});
    } finally {
      f.media.dispose();
    }
  });

  it('SFU сказал «пауза» — ни одной переподписки, сколько бы она ни длилась', async () => {
    vi.useFakeTimers();
    const f = peerWithCamera();
    try {
      await f.checkLive();
      f.setState(f.camera, Track.StreamState.Paused);
      for (let i = 0; i < 40; i++) {
        await vi.advanceTimersByTimeAsync(2000);
        await f.checkLive();
      }
      expect(f.camera.setSubscribed).not.toHaveBeenCalled();
      expect(f.media.videoPaused.get()).toEqual({ TR_cam: 'sfu' });
    } finally {
      f.media.dispose();
    }
  });

  it('переподписка держит плитку: пока новой дорожки нет — прежняя, новая — той же плиткой', async () => {
    vi.useFakeTimers();
    const f = peerWithCamera();
    try {
      f.room.emit(RoomEvent.TrackSubscribed);
      await Promise.resolve();
      const before = f.media.tracks.get().find((tile) => tile.id === 'TR_cam')!;
      (f.media as unknown as { holdCamera(p: unknown): void }).holdCamera(f.camera);
      const old = f.camera.track;
      (f.camera as { track?: unknown }).track = undefined;
      f.room.emit(RoomEvent.TrackUnsubscribed);
      await Promise.resolve();
      expect(f.media.tracks.get().find((tile) => tile.id === 'TR_cam')?.track).toBe(before.track);
      // Подписка так и не вернулась — через срок плитка отдаёт место аватару.
      await vi.advanceTimersByTimeAsync(HOLD_CAMERA_MS);
      expect(f.media.tracks.get().find((tile) => tile.id === 'TR_cam')).toBeUndefined();
      // Вернулась — обычная плитка с новой дорожкой, и держать больше нечего.
      (f.media as unknown as { holdCamera(p: unknown): void }).holdCamera({ ...f.camera, track: old });
      const fresh = { ...old };
      (f.camera as { track?: unknown }).track = fresh;
      f.room.emit(RoomEvent.TrackSubscribed);
      await Promise.resolve();
      expect(f.media.tracks.get().find((tile) => tile.id === 'TR_cam')?.track).toBe(fresh);
      (f.camera as { track?: unknown }).track = undefined;
      f.room.emit(RoomEvent.TrackUnsubscribed);
      await Promise.resolve();
      expect(f.media.tracks.get().find((tile) => tile.id === 'TR_cam')).toBeUndefined();
    } finally {
      f.media.dispose();
    }
  });

  it('желанная без дорожки — подписка переключается заново; SDK сказал «не удалась» — не ждём', async () => {
    vi.useFakeTimers();
    const f = peerWithCamera();
    try {
      (f.camera as { track?: unknown }).track = undefined;
      (f.camera as { isSubscribed: boolean }).isSubscribed = false;
      await f.checkLive();
      await vi.advanceTimersByTimeAsync(3000);
      await f.checkLive();
      expect(f.camera.setSubscribed).not.toHaveBeenCalled();
      f.room.emit(RoomEvent.TrackSubscriptionFailed, 'TR_cam', f.peer, 'nope');
      const check = f.checkLive();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.camera.setSubscribed).toHaveBeenLastCalledWith(false);
      await vi.advanceTimersByTimeAsync(1000);
      await check;
      expect(f.camera.setSubscribed).toHaveBeenLastCalledWith(true);
    } finally {
      f.media.dispose();
    }
  });

  it('участник переподключается, камера заглушена, плитки не видно, вкладка скрыта — сторож молчит', async () => {
    vi.useFakeTimers();
    const f = peerWithCamera();
    const run = async (rounds = 20) => {
      for (let i = 0; i < rounds; i++) {
        await vi.advanceTimersByTimeAsync(2000);
        await f.checkLive();
      }
    };
    try {
      f.media.setRecoveringPeople(['peer']);
      await run();
      f.media.setRecoveringPeople([]);
      f.camera.isMuted = true;
      await run();
      f.camera.isMuted = false;
      f.camera.isEnabled = false;
      await run();
      f.camera.isEnabled = true;
      const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      await run();
      hidden.mockRestore();
      expect(f.camera.setSubscribed).not.toHaveBeenCalled();
    } finally {
      f.media.dispose();
    }
  });

  it('браузер не играет видео без жеста — кнопка; жест снимает её', async () => {
    const f = peerWithCamera();
    const room = f.room as unknown as { canPlaybackVideo: boolean; startVideo: () => Promise<void> };
    try {
      room.canPlaybackVideo = false;
      room.startVideo = vi.fn(async () => {
        room.canPlaybackVideo = true;
      });
      f.room.emit(RoomEvent.VideoPlaybackStatusChanged, false);
      expect(f.media.videoBlocked.get()).toBe(true);
      await f.media.unlockVideo();
      expect(room.startVideo).toHaveBeenCalledTimes(1);
      expect(f.media.videoBlocked.get()).toBe(false);
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
      expect(f.media.videoPaused.get()).toEqual({ TR_cam: 'sfu' });
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

      await media.setCameraProfile({ resolution: 1080, fps: 30 });

      // Камера и так отдаёт 1440p60 — лестницу `min` не трогаем (R189): каждый `applyConstraints`
      // с `min` перенастраивает источник и на полсекунды оставляет его без кадров.
      expect(capture.applyConstraints).not.toHaveBeenCalled();
      expect(sender.setParameters).toHaveBeenCalled();
      expect(restartTrack).not.toHaveBeenCalled();
      expect(local.unpublishTrack).not.toHaveBeenCalled();
      expect(local.publishTrack).not.toHaveBeenCalled();
      expect(publication.options.videoEncoding).toEqual({ maxBitrate: 4500000, maxFramerate: 30 });
    } finally {
      media.dispose();
      localStorage.clear();
    }
  });
});

describe('частота камеры требованием (R189)', () => {
  it('камера отдаёт меньше выбранного — просим `min`; отдаёт выбранное — не трогаем', async () => {
    const { media, room } = fixture();
    try {
      const { track, media: capture, settings } = fakeCameraTrack({ width: 1280, height: 720 });
      Object.assign(settings, { frameRate: 24 });
      const local = (room as unknown as { localParticipant: Record<string, unknown> }).localParticipant;
      (local.trackPublications as Map<Track.Source, unknown>).set(Track.Source.Camera, { track });
      (media as unknown as { wanted: { camera: boolean } }).wanted.camera = true;
      await (media as unknown as { enforceCameraRate: () => Promise<void> }).enforceCameraRate();
      expect(capture.applyConstraints).toHaveBeenCalledWith(
        expect.objectContaining({ frameRate: { min: 30, ideal: 30 } }),
      );
      Object.assign(settings, { frameRate: 30 });
      (capture.applyConstraints as ReturnType<typeof vi.fn>).mockClear();
      await (media as unknown as { enforceCameraRate: () => Promise<void> }).enforceCameraRate();
      expect(capture.applyConstraints).not.toHaveBeenCalled();
    } finally {
      media.dispose();
    }
  });
});

/** Первое включение камеры на телефоне — фронтальная, а не запомненная (27.10.2026, владелец). */
describe('нажатия посреди переключения (R163)', () => {
  /** Камера, включение которой ждёт, пока тест не отпустит: так видно, что творится посреди него. */
  function slowCamera() {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const { media, room } = fixture();
    const local = (room as unknown as { localParticipant: Record<string, unknown> }).localParticipant;
    const gates: (() => void)[] = [];
    const setCameraEnabled = vi.fn(async (enabled: boolean) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      local.isCameraEnabled = enabled;
    });
    local.setCameraEnabled = setCameraEnabled;
    return { media, local, gates, setCameraEnabled };
  }

  it('второе нажатие, пока камера ещё включается, не теряется: кнопка сразу «выключена», камера сводится к нему', async () => {
    const { media, local, gates, setCameraEnabled } = slowCamera();
    try {
      const first = media.toggle('camera');
      expect(media.cameraHeading.get()).toBe(true);
      await media.toggle('camera');
      expect(media.cameraHeading.get()).toBe(false);
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      expect(setCameraEnabled).toHaveBeenCalledTimes(1);
      gates[0]!();
      await first;
      await vi.waitFor(() => expect(setCameraEnabled).toHaveBeenCalledTimes(2));
      expect(setCameraEnabled.mock.calls[1]![0]).toBe(false);
      expect(media.cameraHeading.get()).toBe(false);
      gates[1]!();
      await vi.waitFor(() => expect(media.cameraHeading.get()).toBeUndefined());
      expect(local.isCameraEnabled).toBe(false);
      expect(media.state.get().camera).toBe(false);
    } finally {
      media.dispose();
    }
  });

  it('туда-обратно посреди включения: пришли, куда звали первым нажатием, — без лишнего переключения', async () => {
    const { media, local, gates, setCameraEnabled } = slowCamera();
    try {
      const first = media.toggle('camera');
      await media.toggle('camera');
      await media.toggle('camera');
      expect(media.cameraHeading.get()).toBe(true);
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      gates[0]!();
      await first;
      await vi.waitFor(() => expect(media.cameraHeading.get()).toBeUndefined());
      expect(setCameraEnabled).toHaveBeenCalledTimes(1);
      expect(local.isCameraEnabled).toBe(true);
    } finally {
      media.dispose();
    }
  });

  it('не вышло (нет доступа) — отложенное нажатие ошибку не повторяет, кнопка возвращается', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const { media, room } = fixture();
    const local = (room as unknown as { localParticipant: Record<string, unknown> }).localParticipant;
    let refuse!: (error: Error) => void;
    const setCameraEnabled = vi.fn(() => new Promise<void>((_resolve, reject) => (refuse = reject)));
    local.setCameraEnabled = setCameraEnabled;
    try {
      const first = media.toggle('camera');
      await media.toggle('camera');
      await media.toggle('camera');
      await vi.waitFor(() => expect(refuse).toBeTypeOf('function'));
      refuse(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
      await first;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(setCameraEnabled).toHaveBeenCalledTimes(1);
      expect(media.cameraHeading.get()).toBeUndefined();
    } finally {
      media.dispose();
    }
  });
});

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

  it('на телефоне — фронтальная, хотя запомнена задняя; повторное включение — уже выбранная камера', async () => {
    phone(true);
    localStorage.setItem('cord:preferences:v1', JSON.stringify({ devices: { camera: 'back-camera' } }));
    const { media, setCameraEnabled } = mount();
    try {
      expect(media.cameraChosen.get()).toBe(false);
      await media.toggle('camera');
      expect(setCameraEnabled.mock.calls[0]![1]).toMatchObject({ facingMode: 'user' });
      expect(setCameraEnabled.mock.calls[0]![1]).not.toHaveProperty('deviceId');
      expect(media.cameraChosen.get()).toBe(true);
      media.state.set({ ...media.state.get(), camera: true });
      await media.toggle('camera');
      media.state.set({ ...media.state.get(), camera: false });
      await media.toggle('camera');
      expect(setCameraEnabled.mock.calls[2]![1]).toMatchObject({ deviceId: 'back-camera' });
      expect(setCameraEnabled.mock.calls[2]![1]).not.toHaveProperty('facingMode');
    } finally {
      media.dispose();
      localStorage.clear();
    }
  });

  it('подсказку кодировщику ставит включение, и только если она другая; выключение её не трогает (R163)', async () => {
    phone(false);
    const { media, room, setCameraEnabled } = mount();
    const local = (room as unknown as { localParticipant: Record<string, unknown> }).localParticipant;
    const hints: string[] = [];
    const raw = {
      get contentHint() {
        return hints.at(-1) ?? '';
      },
      set contentHint(value: string) {
        hints.push(value);
      },
      getConstraints: () => ({}),
      getSettings: () => ({}),
      getCapabilities: () => ({}),
      applyConstraints: vi.fn(async () => {}),
    };
    const video = Object.create(LocalVideoTrack.prototype) as LocalVideoTrack;
    Object.defineProperty(video, 'mediaStreamTrack', { value: raw });
    Object.defineProperty(video, 'constraints', { value: {} });
    (local.trackPublications as Map<Track.Source, unknown>).set(Track.Source.Camera, {
      track: video,
      source: Track.Source.Camera,
    });
    try {
      await media.toggle('camera');
      expect(hints).toHaveLength(1);
      media.state.set({ ...media.state.get(), camera: true });
      await media.toggle('camera');
      expect(setCameraEnabled.mock.calls.at(-1)![0]).toBe(false);
      expect(hints).toHaveLength(1);
      media.state.set({ ...media.state.get(), camera: false });
      await media.toggle('camera');
      expect(hints).toHaveLength(1);
    } finally {
      media.dispose();
    }
  });

  it('на компьютере — выбранная в настройках камера, умолчания комнаты не трогаются', async () => {
    phone(false);
    localStorage.setItem('cord:preferences:v1', JSON.stringify({ devices: { camera: 'usb-camera' } }));
    const { media, room, setCameraEnabled } = mount();
    try {
      await media.toggle('camera');
      expect(setCameraEnabled.mock.calls[0]![1]).toMatchObject({ deviceId: 'usb-camera' });
      expect(setCameraEnabled.mock.calls[0]![1]).not.toHaveProperty('facingMode');
      expect(room.options.videoCaptureDefaults?.deviceId).toBe('usb-camera');
    } finally {
      media.dispose();
      localStorage.clear();
    }
  });

  /*
    Р-35 — про запомненную с прошлых встреч камеру, а не про выбор в этой. Камеру с включённого предвхода
    (там Р-35 уже применён) и камеру, выбранную во встрече до первого включения — переворотом при
    выключенной камере или списком в настройках, — включение берёт как есть.
  */
  it('камеру принесли с предвхода — включается она, а не фронтальная', async () => {
    phone(true);
    localStorage.setItem('cord:preferences:v1', JSON.stringify({ devices: { camera: 'back-camera' } }));
    const { media, setCameraEnabled } = mount();
    try {
      await media.toggle('camera', 'prejoin-camera');
      expect(setCameraEnabled.mock.calls[0]![1]).toMatchObject({ deviceId: 'prejoin-camera' });
      expect(setCameraEnabled.mock.calls[0]![1]).not.toHaveProperty('facingMode');
    } finally {
      media.dispose();
      localStorage.clear();
    }
  });

  it('камеру выбрали во встрече до первого включения — включается она', async () => {
    phone(true);
    const { media, room, setCameraEnabled } = mount();
    Object.assign(room, {
      switchActiveDevice: vi.fn(async (_kind: string, id: string) => {
        room.options.videoCaptureDefaults = { ...room.options.videoCaptureDefaults, deviceId: { exact: id } };
      }),
    });
    let remembered: unknown;
    setCameraEnabled.mockImplementationOnce(async () => {
      remembered = room.options.videoCaptureDefaults?.deviceId;
    });
    try {
      await media.switchDevice('videoinput', 'back-camera');
      expect(media.cameraChosen.get()).toBe(true);
      await media.toggle('camera');
      expect(setCameraEnabled.mock.calls[0]![1]).toMatchObject({ deviceId: 'back-camera' });
      expect(setCameraEnabled.mock.calls[0]![1]).not.toHaveProperty('facingMode');
      expect(remembered).toEqual({ exact: 'back-camera' });
    } finally {
      media.dispose();
      localStorage.clear();
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
      await media.toggle('camera');
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
      await media.toggle('camera');
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
