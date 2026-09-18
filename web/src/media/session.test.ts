import type { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomEvent, DisconnectReason, Track, type RoomOptions } from 'livekit-client';
import { MediaSession } from './session';
import type { RoomApi } from '../api/client';
import type { CaptureAdapter } from './capture';

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
    };
    constructor(readonly options: RoomOptions) {
      super();
    }
    disconnect = vi.fn(async () => {
      this.state = 'disconnected';
      this.emit(sdk.RoomEvent.Disconnected);
    });
    connect = vi.fn(async () => {});
  }
  return { ...sdk, Room: FakeRoom };
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
