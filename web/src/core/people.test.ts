import { expect, it } from 'vitest';
import { humans, presentHumans } from './people';

const room = [
  { id: 'host', service: null, status: 'CONNECTED' as const },
  { id: 'music', service: 'music', status: 'CONNECTED' as const },
  { id: 'telegram', service: 'telegram', status: 'JOINING' as const },
  { id: 'guest', service: null, status: 'WAITING' as const },
  { id: 'back', service: null, status: 'RECOVERING' as const },
];

it('never counts bots and integrations as people', () => {
  expect(humans(room).map((p) => p.id)).toEqual(['host', 'guest', 'back']);
});

it('leaves people waiting at the door out of those already in the meeting', () => {
  expect(presentHumans(room).map((p) => p.id)).toEqual(['host', 'back']);
});

it('keeps a host alone with the music bot an empty meeting', () => {
  expect(presentHumans(room.slice(0, 2))).toHaveLength(1);
});
