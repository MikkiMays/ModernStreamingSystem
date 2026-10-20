/**
 * «Вы ещё здесь?» (A2 модели угроз, E10-B): браузер сам говорит ядру, что за ним кто-то есть.
 *
 * Ядро не видит ни мыши, ни клавиатуры, а голос знает только SFU. Поэтому присутствие сообщает сам
 * браузер — командой `presence.confirm`, не чаще раза в {@link CONFIRM_EVERY_MS} и только если человек
 * был здесь после прошлого раза: говорил, держал камеру, двигал мышь, жал клавиши, трогал экран. Кто
 * молчит дольше `stream.meeting.presence-check` (по умолчанию два часа), того ядро спрашивает полем
 * `you.presenceBy`, и плашка «Вы ещё здесь?» отвечает ему тем же `presence.confirm`.
 *
 * Забытая вкладка поэтому больше не держит место сутки, а человек, который слушает доклад молча,
 * отвечает одним нажатием раз в два часа.
 */
export const CONFIRM_EVERY_MS = 10 * 60_000;

/** Как часто смотреть на голос и камеру — достаточно, чтобы заметить реплику длиннее пары слов. */
export const SAMPLE_MS = 5_000;

export type PresenceSignals = {
  /** Говорит ли человек сейчас (своя ступень уровня голоса, `media/levels.ts`). */
  speaking(): boolean;
  /** Включена ли его камера. */
  camera(): boolean;
};

export class Presence {
  private activeAt = 0;
  private sentAt: number;
  private sending = false;

  constructor(
    private readonly send: () => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {
    // Ядро считает от входа — вход и есть первое «я здесь».
    this.sentAt = now();
  }

  /** Человек что-то сделал: мышь, клавиша, касание. */
  touch() {
    this.activeAt = this.now();
  }

  /** Проход раз в {@link SAMPLE_MS}: голос и камера — тоже присутствие. */
  tick(signals: PresenceSignals) {
    if (signals.speaking() || signals.camera()) this.touch();
    const now = this.now();
    if (this.sending || this.activeAt <= this.sentAt || now - this.sentAt < CONFIRM_EVERY_MS) return;
    // Не дошло — не беда: следующий проход попробует снова.
    this.deliver().catch(() => {});
  }

  /** Ответ на «Вы ещё здесь?» — сразу. */
  confirm() {
    this.touch();
    return this.deliver();
  }

  private async deliver() {
    const previous = this.sentAt;
    this.sentAt = this.now();
    this.sending = true;
    try {
      await this.send();
    } catch (error) {
      // Не дошло — интервал не потрачен: следующий проход попробует снова.
      this.sentAt = previous;
      throw error;
    } finally {
      this.sending = false;
    }
  }
}
