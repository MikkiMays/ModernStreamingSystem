import { describe, expect, it, vi } from 'vitest';
import { playLadder } from './autoplay';

const video = (outcomes: ('ok' | 'policy' | 'other')[]) => {
  const element = { muted: false, play: vi.fn() } as unknown as HTMLVideoElement & {
    play: ReturnType<typeof vi.fn>;
  };
  for (const outcome of outcomes)
    element.play.mockImplementationOnce(() =>
      outcome === 'ok'
        ? Promise.resolve()
        : Promise.reject(
            Object.assign(new Error(outcome), {
              name: outcome === 'policy' ? 'NotAllowedError' : 'AbortError',
            }),
          ),
    );
  return element;
};

describe('запуск без жеста — лестницей (R150)', () => {
  it('со звуком, если можно', async () => {
    const element = video(['ok']);
    expect(await playLadder(element)).toBe('sound');
    expect(element.muted).toBe(false);
  });

  it('политика отказала — тот же фильм без звука, звук включит касание', async () => {
    const element = video(['policy', 'ok']);
    expect(await playLadder(element)).toBe('muted');
    expect(element.muted).toBe(true);
  });

  it('отказали и беззвучно — прежняя кнопка «Смотреть вместе», звук не заглушён навсегда', async () => {
    const element = video(['policy', 'policy']);
    expect(await playLadder(element)).toBe('blocked');
    expect(element.muted).toBe(false);
  });

  it('другая ошибка — не политика: беззвучной ступени нет', async () => {
    const element = video(['other']);
    expect(await playLadder(element)).toBe('blocked');
    expect(element.play).toHaveBeenCalledTimes(1);
  });
});
