import { beforeEach, expect, it, vi } from 'vitest';
import type { Admission } from '../api/types';
import { getRecent, recentMeetings, rememberMeeting } from './recent';
beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});
it('stores only the five most recently visited rooms and never retains chat bodies', () => {
  for (let i = 0; i < 8; i++) {
    vi.spyOn(Date, 'now').mockReturnValue(1000 + i);
    rememberMeeting({
      roomId: `room-${i}`,
      credential: 'credential',
      snapshot: { createdAt: 500, messages: [{ text: 'private' }] },
    } as unknown as Admission);
  }
  expect(recentMeetings().map((r) => r.roomId)).toEqual(['room-7', 'room-6', 'room-5', 'room-4', 'room-3']);
  expect(Object.keys(sessionStorage).filter((k) => k.startsWith('cord:session:'))).toHaveLength(5);
  expect(JSON.stringify(sessionStorage)).not.toContain('private');
  vi.spyOn(Date, 'now').mockReturnValue(2000);
  rememberMeeting(getRecent('room-3')!);
  expect(recentMeetings()[0]?.roomId).toBe('room-3');
});
