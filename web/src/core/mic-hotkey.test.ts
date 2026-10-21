import { describe, expect, it, vi } from 'vitest';
import { MicHotkey } from './mic-hotkey';

/*
  Сочетание микрофона во встрече (T27, E01-B3): «включать и выключать» или «нажми и говори».
  Raw Input оболочки видит нажатие и в окне Cord, не отбирая его у страницы, — одно нажатие
  приходит дважды (страница и оболочка) и должно сработать один раз.
*/

function setup(mode: 'toggle' | 'hold') {
  let now = 0;
  const actions = { toggle: vi.fn(), set: vi.fn() };
  const mic = new MicHotkey(mode, actions, () => now);
  return { mic, actions, at: (ms: number) => (now = ms) };
}

describe('нажми и говори', () => {
  it('оболочка: down — включить, up — выключить', () => {
    const { mic, actions } = setup('hold');
    mic.press('shell', 'down');
    expect(actions.set).toHaveBeenLastCalledWith(true);
    mic.press('shell', 'up');
    expect(actions.set).toHaveBeenLastCalledWith(false);
    expect(actions.toggle).not.toHaveBeenCalled();
  });

  it('то же нажатие от страницы и от оболочки — один раз; запоздавший down оболочки не включает снова', () => {
    const { mic, actions, at } = setup('hold');
    at(0);
    mic.press('page', 'down');
    at(40);
    mic.press('page', 'up');
    // IPC оболочки отстал: её down пришёл уже после отпускания в окне.
    at(60);
    mic.press('shell', 'down');
    at(80);
    mic.press('shell', 'up');
    expect(actions.set.mock.calls).toEqual([[true], [false]]);
  });

  it('следующее нажатие после пары — снова работает', () => {
    const { mic, actions, at } = setup('hold');
    at(0);
    mic.press('shell', 'down');
    at(10);
    mic.press('page', 'down');
    at(100);
    mic.press('shell', 'up');
    at(110);
    mic.press('page', 'up');
    at(150);
    mic.press('page', 'down');
    expect(actions.set.mock.calls).toEqual([[true], [false], [true]]);
  });
});

describe('включать и выключать', () => {
  it('только down; дубль из другого источника не переключает обратно', () => {
    const { mic, actions, at } = setup('toggle');
    at(0);
    mic.press('page', 'down');
    at(20);
    mic.press('shell', 'down');
    mic.press('shell', 'up');
    expect(actions.toggle).toHaveBeenCalledTimes(1);
    expect(actions.set).not.toHaveBeenCalled();
  });

  it('частые нажатия из одного источника — каждое; из разных, но далеко по времени — каждое', () => {
    const { mic, actions, at } = setup('toggle');
    at(0);
    mic.press('shell', 'down');
    at(100);
    mic.press('shell', 'down');
    at(1000);
    mic.press('page', 'down');
    expect(actions.toggle).toHaveBeenCalledTimes(3);
  });
});
