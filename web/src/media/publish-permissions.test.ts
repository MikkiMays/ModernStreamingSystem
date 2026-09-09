import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomEvent, Track, type Room } from 'livekit-client';
import { waitForPublishPermissions } from './publish-permissions';

function fixture(sources: Track.Source[] = [Track.Source.Camera, Track.Source.Microphone]) {
  const events = new EventEmitter();
  const participant = {
    permissions: { canPublish: true, canPublishSources: sources.map(Track.sourceToProto) },
  };
  const room = Object.assign(events, { localParticipant: participant }) as unknown as Room;
  const abort = new AbortController();
  const grant = (...next: Track.Source[]) => {
    participant.permissions.canPublishSources = next.map(Track.sourceToProto);
    events.emit(RoomEvent.ParticipantPermissionsChanged);
  };
  return { room, events, participant, abort, grant };
}
afterEach(() => vi.useRealTimers());

describe('publication permission handoff', () => {
  it('starts immediately when permissions already arrived', async () => {
    const { room, events, abort } = fixture([Track.Source.ScreenShare]);
    await waitForPublishPermissions(room, [Track.Source.ScreenShare], abort.signal);
    expect(events.eventNames()).toEqual([]);
  });

  it('waits for all captured sources, then removes every subscription', async () => {
    const { room, events, abort, grant } = fixture();
    const complete = vi.fn();
    const waiting = waitForPublishPermissions(
      room,
      [Track.Source.ScreenShare, Track.Source.ScreenShareAudio],
      abort.signal,
    ).then(complete);
    events.emit(RoomEvent.ParticipantPermissionsChanged);
    grant(Track.Source.ScreenShare);
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    grant(Track.Source.ScreenShare, Track.Source.ScreenShareAudio);
    await waiting;
    expect(complete).toHaveBeenCalledOnce();
    expect(events.eventNames()).toEqual([]);
  });

  it('keeps one deadline despite repeated permission updates', async () => {
    vi.useFakeTimers();
    const { room, events, abort } = fixture();
    const rejected = expect(
      waitForPublishPermissions(room, [Track.Source.ScreenShare], abort.signal),
    ).rejects.toThrow('Не получено разрешение');
    await vi.advanceTimersByTimeAsync(9000);
    events.emit(RoomEvent.ParticipantPermissionsChanged);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(events.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['abort', 'disconnect', 'reconnect'] as const)(
    'cancels on %s and ignores late grants',
    async (reason) => {
      vi.useFakeTimers();
      const { room, events, abort, grant } = fixture();
      const rejected = expect(
        waitForPublishPermissions(room, [Track.Source.ScreenShare], abort.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
      if (reason === 'abort') abort.abort();
      else events.emit(reason === 'disconnect' ? RoomEvent.Disconnected : RoomEvent.Reconnecting);
      grant(Track.Source.ScreenShare);
      await rejected;
      expect(events.eventNames()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
