import type { Admission } from '../api/types';

const prefix = 'cord:session:';
export type RecentMeeting = Admission & { visitedAt: number };
export function removeRecent(id: string) {
  sessionStorage.removeItem(`${prefix}${id}`);
  sessionStorage.removeItem(`cord:ended:${id}`);
}
export function recentMeetings(): RecentMeeting[] {
  const rooms: RecentMeeting[] = [];
  for (const key of Object.keys(sessionStorage).filter((k) => k.startsWith(prefix))) {
    try {
      const data = JSON.parse(sessionStorage.getItem(key)!);
      if (
        !data?.roomId ||
        !data.credential ||
        !data.snapshot ||
        (data.snapshot.closedAt && data.snapshot.closedAt + 3600000 <= Date.now())
      ) {
        removeRecent(key.slice(prefix.length));
        continue;
      }
      rooms.push({ ...data, visitedAt: data.visitedAt ?? data.snapshot.createdAt });
    } catch {
      removeRecent(key.slice(prefix.length));
    }
  }
  rooms.sort((a, b) => b.visitedAt - a.visitedAt);
  for (const room of rooms.slice(5)) removeRecent(room.roomId);
  return rooms.slice(0, 5);
}
export function rememberMeeting(admission: Admission) {
  sessionStorage.setItem(
    `${prefix}${admission.roomId}`,
    JSON.stringify({
      ...admission,
      snapshot: { ...admission.snapshot, messages: [] },
      visitedAt: Date.now(),
    }),
  );
  recentMeetings();
}
export function getRecent(id: string): RecentMeeting | undefined {
  return recentMeetings().find((r) => r.roomId === id);
}
