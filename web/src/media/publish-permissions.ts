import { RoomEvent, Track, type Room } from 'livekit-client';

/** The control API acknowledgement can arrive before the SFU permission update. */
export function waitForPublishPermissions(
  room: Room,
  sources: Track.Source[],
  signal: AbortSignal,
  timeoutMs = 10000,
): Promise<void> {
  const permitted = () => {
    const permissions = room.localParticipant.permissions;
    return (
      !!permissions?.canPublish &&
      (permissions.canPublishSources.length === 0 ||
        sources.every((source) => permissions.canPublishSources.includes(Track.sourceToProto(source))))
    );
  };
  if (signal.aborted) return Promise.reject(new DOMException('Демонстрация отменена', 'AbortError'));
  if (permitted()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      room.off(RoomEvent.ParticipantPermissionsChanged, check);
      room.off(RoomEvent.Reconnecting, cancel);
      room.off(RoomEvent.SignalReconnecting, cancel);
      room.off(RoomEvent.Disconnected, cancel);
      signal.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (permitted()) finish();
    };
    const cancel = () => finish(new DOMException('Демонстрация отменена', 'AbortError'));
    const timer = setTimeout(
      () => finish(new Error('Не получено разрешение медиасервера. Попробуйте включить демонстрацию снова.')),
      timeoutMs,
    );
    room.on(RoomEvent.ParticipantPermissionsChanged, check);
    room.on(RoomEvent.Reconnecting, cancel);
    room.on(RoomEvent.SignalReconnecting, cancel);
    room.on(RoomEvent.Disconnected, cancel);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    else check();
  });
}
