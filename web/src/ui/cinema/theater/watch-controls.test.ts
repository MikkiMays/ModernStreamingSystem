import { describe, expect, it } from 'vitest';
import { controlsShown, framePress, playToggle, skipTarget } from './watch-controls';

describe('пульт кинозала', () => {
  /**
   * Жалоба звучала так: «на телефоне тычешь в экран — кино встаёт». Кино вставало у всей
   * комнаты, потому что нажатие по кадру означало паузу независимо от того, чем нажали.
   */
  it('пальцем и во весь экран нажатие по кадру только будит пульт', () => {
    const base = { coarse: false, fullscreen: false, live: false, canControl: true };
    expect(framePress({ ...base, coarse: true })).toBe('wake');
    expect(framePress({ ...base, fullscreen: true })).toBe('wake');
    expect(framePress({ ...base, coarse: true, live: true })).toBe('wake');
    expect(framePress({ ...base, coarse: true, canControl: false })).toBe('wake');
  });

  it('мышью в окне кадр по-прежнему ставит паузу — но не у эфира и не без прав', () => {
    const base = { coarse: false, fullscreen: false, live: false, canControl: true };
    expect(framePress(base)).toBe('toggle');
    expect(framePress({ ...base, live: true })).toBe('none');
    expect(framePress({ ...base, canControl: false })).toBe('none');
  });

  it('перемотка не уходит за начало и за конец ролика', () => {
    expect(skipTarget(60000, 15000, 300000)).toBe(75000);
    expect(skipTarget(60000, -15000, 300000)).toBe(45000);
    expect(skipTarget(5000, -15000, 300000)).toBe(0);
    expect(skipTarget(295000, 15000, 300000)).toBe(300000);
    // Длительность ещё неизвестна: ограничиваем только снизу.
    expect(skipTarget(5000, 15000, 0)).toBe(20000);
    expect(skipTarget(5000, -15000, 0)).toBe(0);
  });

  it('«играть/пауза»: комната на паузе — включить, играет — пауза, а значок ещё и по своему плееру', () => {
    expect(playToggle({ paused: true, over: false, playing: false })).toEqual({
      label: 'Включить для всех',
      command: 'watch.play',
      icon: 'play',
    });
    expect(playToggle({ paused: false, over: false, playing: true })).toEqual({
      label: 'Пауза для всех',
      command: 'watch.pause',
      icon: 'pause',
    });
    // Комната уже играет, свой плеер ещё не пошёл: остановить можно, но на экране — ▶.
    expect(playToggle({ paused: false, over: false, playing: false })).toEqual({
      label: 'Пауза для всех',
      command: 'watch.pause',
      icon: 'play',
    });
  });

  /**
   * Задача 11a оставила это на потом: после естественного конца комната не на паузе, и кнопка с ▶
   * звалась «Пауза для всех» и слала `watch.pause` — первое нажатие не делало ничего видимого.
   */
  it('досмотрели: кнопка — «Включить для всех» и шлёт watch.play, хотя паузы комната не ставила', () => {
    expect(playToggle({ paused: false, over: true, playing: false })).toEqual({
      label: 'Включить для всех',
      command: 'watch.play',
      icon: 'play',
    });
  });

  it('пульт уходит по бездействию и на паузе тоже, но не под открытым меню', () => {
    expect(controlsShown({ idle: false, menuOpen: false, ready: true })).toBe(true);
    expect(controlsShown({ idle: true, menuOpen: false, ready: true })).toBe(false);
    expect(controlsShown({ idle: true, menuOpen: true, ready: true })).toBe(true);
    // Пока плеер не готов, на кадре не пульт, а объяснение происходящего.
    expect(controlsShown({ idle: true, menuOpen: false, ready: false })).toBe(true);
  });
});
