import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Cue } from './sounds';

// The audio context is module state by design — one per page, unlocked once. Each test needs
// its own, so the module is loaded fresh every time.
const load = () => import('./sounds');
beforeEach(() => vi.resetModules());

function stubAudio(state = 'running') {
  const create = vi.fn(() => ({
    frequency: { value: 0 },
    connect: vi.fn(() => ({ connect: vi.fn() })),
    start: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
    type: '',
    onended: null,
  }));
  vi.stubGlobal(
    'AudioContext',
    class {
      state = state;
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
  return create;
}
afterEach(() => vi.unstubAllGlobals());

it('waits for the entrance gesture and plays each room event once', async () => {
  const create = stubAudio();
  const { NotificationSounds, unlockNotificationAudio } = await load();
  unlockNotificationAudio();
  const sounds = new NotificationSounds();
  sounds.start();
  document.dispatchEvent(new Event('pointerdown'));
  sounds.play('screen', 'first');
  sounds.play('screen', 'first');
  expect(create, 'a replayed event must not sound twice').toHaveBeenCalledTimes(2);
  sounds.play('viewer', 'viewer');
  sounds.play('viewer', 'viewer');
  expect(create).toHaveBeenCalledTimes(5);
  sounds.dispose();
});

it('gives arrivals, departures and knocks their own shape', async () => {
  const create = stubAudio();
  const { NotificationSounds, unlockNotificationAudio } = await load();
  unlockNotificationAudio();
  document.dispatchEvent(new Event('pointerdown'));
  const sounds = new NotificationSounds();
  // Three notes for you, two for anyone else, two taps for a knock: enough to tell apart
  // without looking at the screen.
  for (const [cue, notes] of [
    ['self-join', 3],
    ['self-leave', 3],
    ['join', 2],
    ['leave', 2],
    ['knock', 2],
    // Микрофон — тоже две ноты, но октавой: включение вверх, выключение вниз.
    ['mic-on', 2],
    ['mic-off', 2],
  ] as [Cue, number][]) {
    create.mockClear();
    sounds.play(cue);
    expect(create, cue).toHaveBeenCalledTimes(notes);
  }
});

it('answers the microphone the moment it is switched, and quietly', async () => {
  const create = stubAudio();
  const { NotificationSounds, unlockNotificationAudio } = await load();
  unlockNotificationAudio();
  document.dispatchEvent(new Event('pointerdown'));
  const sounds = new NotificationSounds();
  const frequencies = (cue: Cue): number[] => {
    create.mockClear();
    sounds.play(cue);
    return create.mock.results.map(
      (result) => (result.value as { frequency: { value: number } }).frequency.value,
    );
  };
  // Одна и та же пара в разном порядке: спутать включение с выключением нельзя.
  const [onLow, onHigh] = frequencies('mic-on');
  const off = frequencies('mic-off');
  expect(onHigh!).toBeGreaterThan(onLow!);
  expect(off[1]!).toBeLessThan(off[0]!);
  const on = [onLow, onHigh];
  expect(on).toEqual([...off].reverse());
});

it('says when the last cue has finished so the window can close after it', async () => {
  vi.useFakeTimers();
  try {
    stubAudio();
    const { NotificationSounds, unlockNotificationAudio } = await load();
    unlockNotificationAudio();
    document.dispatchEvent(new Event('pointerdown'));
    const sounds = new NotificationSounds();
    sounds.play('self-leave');
    let finished = false;
    void sounds.settled().then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(finished).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('stays silent, and settled, when the browser never let audio start', async () => {
  stubAudio('suspended');
  const { NotificationSounds, unlockNotificationAudio } = await load();
  unlockNotificationAudio();
  document.dispatchEvent(new Event('pointerdown'));
  const sounds = new NotificationSounds();
  expect(() => sounds.play('join')).not.toThrow();
  await expect(sounds.settled()).resolves.toBeUndefined();
});
