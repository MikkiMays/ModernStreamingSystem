import { expect, it } from 'vitest';
import { setWatchLevel } from './usePlayback';

// R213: на iPhone `volume` элемента только для чтения — «без звука» обязан ставить `muted`, иначе кнопка не глушит.
it('ноль глушит через muted, громкость больше нуля снимает его', () => {
  const element = { volume: 1, muted: false } as HTMLMediaElement;
  setWatchLevel(element, 0);
  expect(element.muted).toBe(true);
  setWatchLevel(element, 0.4);
  expect(element).toMatchObject({ muted: false, volume: 0.4 });
});
