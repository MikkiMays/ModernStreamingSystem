import { describe, expect, it } from 'vitest';
import { HoldLevel, RETURN_TICKS } from './hold';

const SETTLE = 2;

describe('удержание выбранного уровня', () => {
  it('в окне разгона жалобы не считаются вовсе', () => {
    const hold = new HoldLevel({ resolution: 1080, fps: 60 }, SETTLE);
    expect(hold.observe('bandwidth')).toBeNull();
    expect(hold.observe('bandwidth')).toBeNull();
    expect(hold.observe('bandwidth')).toBeNull();
    expect(hold.current).toEqual({ resolution: 1080, fps: 60 });
  });

  it('после окна две жалобы подряд опускают разрешение на ступень, частота остаётся', () => {
    const hold = new HoldLevel({ resolution: 1080, fps: 60 }, SETTLE);
    hold.observe('none');
    hold.observe('none');
    expect(hold.observe('bandwidth')).toBeNull();
    expect(hold.observe('cpu')).toEqual({ resolution: 720, fps: 60 });
  });

  it('одна жалоба — случайность, а не повод', () => {
    const hold = new HoldLevel({ resolution: 1080, fps: 30 }, 0);
    expect(hold.observe('bandwidth')).toBeNull();
    expect(hold.observe('none')).toBeNull();
    expect(hold.observe('bandwidth')).toBeNull();
    expect(hold.current).toEqual({ resolution: 1080, fps: 30 });
  });

  it('720p — пол: ниже не спускается ни при каких жалобах, и 15 fps не появляется', () => {
    const hold = new HoldLevel({ resolution: 720, fps: 30 }, 0);
    for (let i = 0; i < 20; i++) expect(hold.observe('bandwidth')).toBeNull();
    expect(hold.current).toEqual({ resolution: 720, fps: 30 });
  });

  it('второй ступени вниз нет: после 1080p → 720p жалобы больше ничего не меняют', () => {
    const hold = new HoldLevel({ resolution: 1440, fps: 60 }, 0);
    hold.observe('bandwidth');
    expect(hold.observe('bandwidth')).toEqual({ resolution: 1080, fps: 60 });
    // Новое окно разгона после шага, затем сколько угодно жалоб.
    for (let i = 0; i < 10; i++) expect(hold.observe('bandwidth')).toBeNull();
    expect(hold.current).toEqual({ resolution: 1080, fps: 60 });
  });

  it('возвращается к выбранному после спокойных опросов и снова ждёт разгон', () => {
    const hold = new HoldLevel({ resolution: 1080, fps: 60 }, SETTLE);
    hold.observe('none');
    hold.observe('none');
    hold.observe('bandwidth');
    expect(hold.observe('bandwidth')).toEqual({ resolution: 720, fps: 60 });
    // Окно разгона после шага.
    for (let i = 0; i < SETTLE; i++) expect(hold.observe('none')).toBeNull();
    for (let i = 0; i < RETURN_TICKS - 1; i++) expect(hold.observe('none')).toBeNull();
    expect(hold.observe('none')).toEqual({ resolution: 1080, fps: 60 });
    expect(hold.observe('bandwidth')).toBeNull();
    expect(hold.current).toEqual({ resolution: 1080, fps: 60 });
  });

  it('жалоба посреди спокойствия обнуляет отсчёт возврата', () => {
    const hold = new HoldLevel({ resolution: 1080, fps: 30 }, 0);
    hold.observe('bandwidth');
    hold.observe('bandwidth');
    for (let i = 0; i < RETURN_TICKS - 1; i++) hold.observe('none');
    hold.observe('bandwidth');
    for (let i = 0; i < RETURN_TICKS - 1; i++) expect(hold.observe('none')).toBeNull();
    expect(hold.observe('none')).toEqual({ resolution: 1080, fps: 30 });
  });
});
