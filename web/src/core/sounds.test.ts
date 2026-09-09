import { expect, it, vi } from 'vitest';
import { NotificationSounds, unlockNotificationAudio } from './sounds';
it('uses the entrance gesture and plays each event once without replaying missed sounds', () => {
  const oscillator = () => ({
    frequency: { value: 0 },
    connect: vi.fn(() => ({ connect: vi.fn() })),
    start: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
    type: '',
    onended: null,
  });
  const create = vi.fn(oscillator);
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running';
      currentTime = 0;
      destination = {};
      resume = vi.fn(async () => {});
      createOscillator = create;
      createGain = () => ({
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        disconnect: vi.fn(),
      });
    },
  );
  unlockNotificationAudio();
  document.dispatchEvent(new Event('pointerdown'));
  const sounds = new NotificationSounds();
  sounds.start();
  sounds.play('start', 'first');
  sounds.play('start', 'first');
  expect(create).toHaveBeenCalledTimes(2);
  sounds.play('viewer', 'viewer');
  sounds.play('viewer', 'viewer');
  expect(create).toHaveBeenCalledTimes(5);
  sounds.dispose();
  vi.unstubAllGlobals();
});
