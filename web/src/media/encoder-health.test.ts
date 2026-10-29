import { expect, it } from 'vitest';
import { EncoderHealth } from './encoder-health';

it('falls back to a compatible codec only after three consecutive CPU-limited intervals', () => {
  const health = new EncoderHealth();
  expect(health.observe('cpu', true)).toBe('none');
  expect(health.observe('none', true)).toBe('none'); // a clear interval resets the run
  expect(health.observe('cpu', true)).toBe('none');
  expect(health.observe('cpu', true)).toBe('none');
  expect(health.observe('cpu', true)).toBe('fallback');
});

it('restores to the primary codec only as the fallback, after sustained calm', () => {
  const health = new EncoderHealth();
  for (let i = 0; i < 3; i++) health.observe('cpu', true); // fall (falls = 1)
  // On H.264 but not marked as the fallback (e.g. chosen from the start): never restores.
  for (let i = 0; i < 25; i++) expect(health.observe('none', false, false)).toBe('none');
  // On H.264 as the fallback: restores after a full calm window (20 intervals).
  for (let i = 0; i < 19; i++) expect(health.observe('none', false, true)).toBe('none');
  expect(health.observe('none', false, true)).toBe('restore');
});

it('counts bandwidth limits as calm but CPU and unknown as not calm', () => {
  const health = new EncoderHealth();
  for (let i = 0; i < 3; i++) health.observe('cpu', true); // fall
  for (let i = 0; i < 10; i++) expect(health.observe('bandwidth', false, true)).toBe('none');
  expect(health.observe('cpu', false, true)).toBe('none'); // CPU resets the calm run
  for (let i = 0; i < 10; i++) expect(health.observe('bandwidth', false, true)).toBe('none');
  expect(health.observe('unknown', false, true)).toBe('none'); // unknown also resets
  for (let i = 0; i < 19; i++) expect(health.observe('bandwidth', false, true)).toBe('none');
  expect(health.observe('bandwidth', false, true)).toBe('restore');
});

it('stops restoring after two fallbacks so a weak machine cannot flap codecs', () => {
  const health = new EncoderHealth();
  const fall = () => {
    let move = 'none';
    for (let i = 0; i < 3; i++) move = health.observe('cpu', true);
    return move;
  };
  const restore = () => {
    let move = 'none';
    for (let i = 0; i < 20; i++) move = health.observe('none', false, true);
    return move;
  };
  expect(fall()).toBe('fallback'); // falls = 1
  expect(restore()).toBe('restore');
  expect(fall()).toBe('fallback'); // falls = 2 → stay on H.264 for the session
  for (let i = 0; i < 40; i++) expect(health.observe('none', false, true)).toBe('none');
});
