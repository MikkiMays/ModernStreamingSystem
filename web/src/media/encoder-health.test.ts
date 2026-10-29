import { expect, it } from 'vitest';
import { EncoderHealth } from './encoder-health';

it('falls back to a compatible codec only after three consecutive CPU-limited intervals', () => {
  const h = new EncoderHealth();
  expect(h.observe('cpu', true)).toBe('none');
  expect(h.observe('none', true)).toBe('none'); // a clear interval resets the run
  expect(h.observe('cpu', true)).toBe('none');
  expect(h.observe('cpu', true)).toBe('none');
  expect(h.observe('cpu', true)).toBe('fallback');
});

it('restores to the primary codec after a short calm (~12s), and only as the fallback', () => {
  const h = new EncoderHealth();
  for (let i = 0; i < 3; i++) h.observe('cpu', true); // fall (falls = 1)
  // On H.264 but not marked as the fallback (chosen from the start): never restores.
  for (let i = 0; i < 10; i++) expect(h.observe('none', false, false)).toBe('none');
  // On H.264 as the fallback: first restore after 4 calm intervals.
  for (let i = 0; i < 3; i++) expect(h.observe('none', false, true)).toBe('none');
  expect(h.observe('none', false, true)).toBe('restore');
});

it('counts bandwidth limits as calm but CPU and unknown as not calm', () => {
  const h = new EncoderHealth();
  for (let i = 0; i < 3; i++) h.observe('cpu', true); // fall
  expect(h.observe('bandwidth', false, true)).toBe('none'); // calm 1
  expect(h.observe('cpu', false, true)).toBe('none'); // resets the calm run
  for (let i = 0; i < 3; i++) expect(h.observe('bandwidth', false, true)).toBe('none');
  expect(h.observe('bandwidth', false, true)).toBe('restore');
});

it('gets twice as patient each fallback and stops after the third so it cannot flap', () => {
  const h = new EncoderHealth();
  const fall = () => {
    let move = 'none';
    for (let i = 0; i < 3; i++) move = h.observe('cpu', true);
    return move;
  };
  const calm = (n: number) => {
    let move = 'none';
    for (let i = 0; i < n; i++) move = h.observe('none', false, true);
    return move;
  };
  expect(fall()).toBe('fallback'); // falls = 1
  expect(calm(4)).toBe('restore'); // ~12s
  expect(fall()).toBe('fallback'); // falls = 2
  expect(calm(7)).toBe('none'); // now needs 8
  expect(h.observe('none', false, true)).toBe('restore');
  expect(fall()).toBe('fallback'); // falls = 3 → stay on H.264
  for (let i = 0; i < 30; i++) expect(h.observe('none', false, true)).toBe('none');
});
