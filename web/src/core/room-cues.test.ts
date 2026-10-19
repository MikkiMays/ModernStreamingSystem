import { describe, expect, it } from 'vitest';
import type { Participant } from '../api/types';
import { RoomCues } from './room-cues';

const SELF = 'self';

function person(
  id: string,
  name: string,
  status: Participant['status'] = 'CONNECTED',
  service: string | null = null,
) {
  return {
    id,
    name,
    avatar: '',
    owner: false,
    status,
    generation: 1,
    recoveryDeadline: null,
    screen: false,
    service,
  } satisfies Participant;
}

describe('RoomCues', () => {
  it('announces a real arrival, a real departure and a knock', () => {
    const cues = new RoomCues(SELF);
    cues.seed([person(SELF, 'Я')]);
    expect(cues.next([person(SELF, 'Я'), person('a', 'Аня')], 1_000)).toEqual(['join']);
    expect(
      cues.next([person(SELF, 'Я'), person('a', 'Аня'), person('w', 'Гость', 'WAITING')], 2_000),
    ).toEqual(['knock']);
    expect(cues.next([person(SELF, 'Я'), person('w', 'Гость', 'WAITING')], 3_000)).toEqual(['leave']);
  });

  it('never announces the music bot — it is not a person', () => {
    const cues = new RoomCues(SELF);
    cues.seed([person(SELF, 'Я')]);
    expect(cues.next([person(SELF, 'Я'), person('m', 'Музыка', 'JOINING', 'music')], 1_000)).toEqual([]);
    expect(cues.next([person(SELF, 'Я')], 2_000)).toEqual([]);
  });

  it('a reconnect under a new id is not «left» plus «joined»', () => {
    const cues = new RoomCues(SELF);
    cues.seed([person(SELF, 'Я'), person('old', 'Аня')]);
    expect(cues.next([person(SELF, 'Я'), person('new', 'Аня', 'JOINING')], 1_000)).toEqual([]);
  });

  it('recovering is the same participation, not a departure', () => {
    const cues = new RoomCues(SELF);
    cues.seed([person(SELF, 'Я'), person('a', 'Аня')]);
    expect(cues.next([person(SELF, 'Я'), person('a', 'Аня', 'RECOVERING')], 1_000)).toEqual([]);
    expect(cues.next([person(SELF, 'Я'), person('a', 'Аня')], 2_000)).toEqual([]);
  });

  it('someone whose link expired during a server stall and came back is not announced twice', () => {
    const cues = new RoomCues(SELF);
    cues.seed([person(SELF, 'Я'), person('a', 'Аня')]);
    // The SFU lost her for longer than the recovery window: the core expires the member…
    expect(cues.next([person(SELF, 'Я')], 30_000)).toEqual(['leave']);
    // …and her client rejoins a few seconds later under a new id. That is a return, not news.
    expect(cues.next([person(SELF, 'Я'), person('b', 'Аня', 'JOINING')], 38_000)).toEqual([]);
  });

  it('a person who comes back after a real pause is announced again', () => {
    const cues = new RoomCues(SELF);
    cues.seed([person(SELF, 'Я'), person('a', 'Аня')]);
    expect(cues.next([person(SELF, 'Я')], 10_000)).toEqual(['leave']);
    expect(cues.next([person(SELF, 'Я'), person('b', 'Аня')], 10_000 + 5 * 60_000)).toEqual(['join']);
  });

  it('own arrival and departure are not read from the roster', () => {
    const cues = new RoomCues(SELF);
    cues.seed([]);
    expect(cues.next([person(SELF, 'Я')], 1_000)).toEqual([]);
  });

  it('remembers why each cue played, for the client journal', () => {
    const cues = new RoomCues(SELF);
    cues.seed([person(SELF, 'Я')]);
    cues.next([person(SELF, 'Я'), person('a', 'Аня')], 1_000);
    expect(cues.journal.at(-1)).toMatchObject({ cue: 'join', participantId: 'a', reason: 'arrived' });
  });
});
