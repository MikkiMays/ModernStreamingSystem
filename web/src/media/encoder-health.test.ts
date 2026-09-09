import { expect, it } from 'vitest';
import { EncoderHealth } from './encoder-health';
it('changes an advanced codec only after three consecutive CPU-limited intervals', () => {
  const health = new EncoderHealth();
  expect(health.observe('cpu', true)).toBe(false);
  expect(health.observe('none', true)).toBe(false);
  expect(health.observe('cpu', true)).toBe(false);
  expect(health.observe('cpu', true)).toBe(false);
  expect(health.observe('cpu', true)).toBe(true);
  for (let i = 0; i < 5; i++) expect(health.observe('cpu', false)).toBe(false);
});
