import { describe, expect, it } from 'vitest';
import { CAMERA_LOG_SIZE, CameraLog } from './camera-log';

describe('журнал камеры (R189, И7)', () => {
  it('держит последние события кольцом и печатает их строками без идентификаторов', () => {
    let now = Date.UTC(2026, 10, 5, 12, 0, 0);
    const log = new CameraLog(() => now);
    for (let i = 0; i < CAMERA_LOG_SIZE + 5; i++) {
      log.note(i === 0 ? 'camera-ended' : 'camera-heal-failed', i === 0 ? undefined : 'NotReadableError');
      now += 1000;
    }
    const events = log.events.get();
    expect(events).toHaveLength(CAMERA_LOG_SIZE);
    expect(events[0]?.kind).toBe('camera-heal-failed');
    expect(log.lines().at(-1)).toBe('camera 12:00:34 camera-heal-failed NotReadableError');
  });

  it('журнал микрофона (R191) — то же кольцо со своим первым словом', () => {
    const log = new CameraLog(() => Date.UTC(2026, 10, 7, 12, 0, 0), 'mic');
    log.note('mic-slow', 'total=1640 unmute=1600 recapture signal=connected');
    expect(log.lines()).toEqual(['mic 12:00:00 mic-slow total=1640 unmute=1600 recapture signal=connected']);
  });
});
