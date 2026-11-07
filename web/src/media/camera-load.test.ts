import { describe, expect, it } from 'vitest';
import { CameraLoad, cameraLoadLadder } from './camera-load';

describe('ступени нагрузки камеры (R192)', () => {
  it('сверху — выбранное; ниже — кадр, у самого низа — частота', () => {
    expect(cameraLoadLadder({ resolution: 1080, fps: 30 })).toEqual([
      { resolution: 1080, fps: 30 },
      { resolution: 720, fps: 30 },
      { resolution: 480, fps: 30 },
      { resolution: 480, fps: 15 },
    ]);
    expect(cameraLoadLadder({ resolution: 480, fps: 30 })).toEqual([
      { resolution: 480, fps: 30 },
      { resolution: 480, fps: 15 },
    ]);
    expect(cameraLoadLadder({ resolution: 480, fps: 15 })).toEqual([{ resolution: 480, fps: 15 }]);
  });
});

describe('CameraLoad', () => {
  const over = (load: CameraLoad, times: number, deepest = 3) => {
    let last: number | null = null;
    for (let i = 0; i < times; i++) last = load.observe('over', deepest) ?? last;
    return last;
  };
  const calm = (load: CameraLoad, times: number, deepest = 3) => {
    let last: number | null = null;
    for (let i = 0; i < times; i++) last = load.observe('calm', deepest) ?? last;
    return last;
  };

  it('один всплеск ничего не значит; три замера подряд — ступень вниз', () => {
    const load = new CameraLoad();
    expect(load.observe('over', 3)).toBeNull();
    expect(load.observe('calm', 3)).toBeNull();
    expect(load.observe('over', 3)).toBeNull();
    expect(load.observe('over', 3)).toBeNull();
    expect(load.observe('over', 3)).toBe(1);
    expect(load.step).toBe(1);
  });

  it('нехватка канала и молчание браузера ступень не трогают: выбранный кадр важнее, чем канал', () => {
    const load = new CameraLoad();
    for (let i = 0; i < 40; i++) expect(load.observe('other', 3)).toBeNull();
    expect(load.step).toBe(0);
    over(load, 3);
    expect(load.step).toBe(1);
    // И не приближают возврат: это не спокойствие процессора.
    for (let i = 0; i < 40; i++) expect(load.observe('other', 3)).toBeNull();
    expect(load.step).toBe(1);
  });

  it('вниз не глубже нижней ступени', () => {
    const load = new CameraLoad();
    expect(over(load, 3, 1)).toBe(1);
    expect(over(load, 30, 1)).toBeNull();
    expect(load.step).toBe(1);
  });

  it('вверх — только после долгого спокойствия; сорвалось сразу — вдвое терпеливее', () => {
    const load = new CameraLoad();
    over(load, 3);
    expect(calm(load, CameraLoad.CALM_SAMPLES - 1)).toBeNull();
    expect(load.observe('calm', 3)).toBe(0);
    // Вернулись и тут же снова перегрузка: следующий возврат ждёт вдвое дольше.
    over(load, 3);
    expect(load.step).toBe(1);
    expect(calm(load, CameraLoad.CALM_SAMPLES * 2 - 1)).toBeNull();
    expect(load.observe('calm', 3)).toBe(0);
  });

  it('терпение не растёт без предела, а сброс возвращает выбранное', () => {
    const load = new CameraLoad();
    for (let i = 0; i < 12; i++) {
      over(load, 3);
      calm(load, CameraLoad.MAX_CALM_SAMPLES);
      expect(load.step).toBe(0);
    }
    over(load, 3);
    load.reset();
    expect(load.step).toBe(0);
    expect(calm(load, 200)).toBeNull();
  });
});
