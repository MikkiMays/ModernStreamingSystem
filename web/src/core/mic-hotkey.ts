import type { MicHotkeyMode } from './hotkeys';

/** Откуда пришло нажатие: клавиатура и мышь в окне страницы или событие оболочки `hotkey`. */
export type HotkeyOrigin = 'page' | 'shell';
export type HotkeyPhase = 'down' | 'up';

/** Окно, в котором то же нажатие из другого источника считается тем же самым. */
const PAIR_MS = 300;

/**
 * Сочетание микрофона во встрече (T27, E01-B3): «включать и выключать» или «нажми и говори».
 *
 * ЗАЧЕМ СВЕРКА ИСТОЧНИКОВ. `globalShortcut` отбирал сочетание у системы — страница его нажатия не
 * видела. Raw Input (`cord-native`) клавишу не отбирает, а видит её и в окне Cord, поэтому одно
 * нажатие приходит дважды: `keydown` страницы и `hotkey` оболочки, в любом порядке. Переключение
 * сработало бы дважды — то есть никак. Здесь нажатие из другого источника в пределах 300 мс после
 * несопоставленного — пара: срабатывает первое, второе гасится. Источник, который один (сочетание
 * только в окне, или окно Cord не впереди), срабатывает всегда.
 *
 * Удержание идемпотентно, но сверка нужна и ему: запоздавший `down` оболочки после `up` в окне
 * снова включил бы микрофон.
 */
export class MicHotkey {
  private readonly last = new Map<HotkeyPhase, { origin: HotkeyOrigin; at: number; paired: boolean }>();

  constructor(
    private readonly mode: MicHotkeyMode,
    private readonly actions: { toggle(): void; set(on: boolean): void },
    private readonly now: () => number = () => performance.now(),
  ) {}

  press(origin: HotkeyOrigin, phase: HotkeyPhase): void {
    if (this.pairs(origin, phase)) return;
    if (this.mode === 'hold') this.actions.set(phase === 'down');
    else if (phase === 'down') this.actions.toggle();
  }

  /** Это вторая половина уже отработанного нажатия? Тогда запомнить, что пара сложилась. */
  private pairs(origin: HotkeyOrigin, phase: HotkeyPhase): boolean {
    const at = this.now();
    const last = this.last.get(phase);
    if (last && !last.paired && last.origin !== origin && at - last.at <= PAIR_MS) {
      last.paired = true;
      return true;
    }
    this.last.set(phase, { origin, at, paired: false });
    return false;
  }
}
