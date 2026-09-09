import type { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomEvent, DisconnectReason, type RoomOptions } from 'livekit-client';
import { MediaSession } from './session';
import type { RoomApi } from '../api/client';

vi.mock('livekit-client', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('livekit-client')>();
  const { EventEmitter } = await import('node:events');
  class FakeRoom extends EventEmitter {
    state = 'connected';
    remoteParticipants = new Map();
    localParticipant = {
      trackPublications: new Map(),
      isMicrophoneEnabled: false,
      isCameraEnabled: false,
      isScreenShareEnabled: false,
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

function fixture() {
  const api = {
    admission: { participantId: 'self' },
    snapshot: vi.fn(async () => ({ participants: [{ id: 'self', generation: 1 }] })),
    command: vi.fn(async () => ({})),
    token: vi.fn(async () => ({ url: 'ws://localhost', token: 'test' })),
  } as unknown as RoomApi;
  const ended = vi.fn();
  const media = new MediaSession(api, ended);
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
afterEach(() => vi.useRealTimers());

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
