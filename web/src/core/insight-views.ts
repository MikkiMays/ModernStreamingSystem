import type { Snapshot } from '../api/types';
import { noteIntegrationView } from './insight';

/**
 * Сколько человек провёл за интеграциями (R239, событие `integration_view`, `contracts/insight.md` §1).
 *
 * Запуски и трафик интеграций знают ядро и службы; сколько людей и сколько времени их смотрели — только
 * клиент. Встреча раз в несколько секунд говорит сюда, что сейчас идёт, а раз в полминуты и при уходе
 * накопленное уходит событием: вид, площадка или игра, секунды и застои кино. Кино, игры и доска считаются,
 * пока страница видна; музыка — пока человек во встрече (её слушают и в соседней вкладке).
 */
export interface IntegrationNow {
  kind: 'cinema' | 'music' | 'game' | 'board';
  /** Площадка кинозала или игра; у музыки и доски её нет. */
  variant?: string;
}

/** Что идёт во встрече по её снимку. Музыка и игра могут идти вместе. */
export function activeIntegrations(snapshot: Snapshot): IntegrationNow[] {
  const active: IntegrationNow[] = [];
  if (snapshot.watch) active.push({ kind: 'cinema', variant: snapshot.watch.provider });
  if (snapshot.poker) active.push({ kind: 'game', variant: 'poker' });
  if (snapshot.durak) active.push({ kind: 'game', variant: 'durak' });
  if (snapshot.chess) active.push({ kind: 'game', variant: 'chess' });
  if (snapshot.gartic) active.push({ kind: 'game', variant: 'gartic' });
  if (snapshot.board) active.push({ kind: 'board' });
  if (snapshot.participants.some((p) => p.service === 'music' && p.status === 'CONNECTED'))
    active.push({ kind: 'music' });
  return active;
}

/** Пауза между замерами длиннее этой — вкладка спала: такое время просмотром не считается. */
const MAX_STEP_MS = 15_000;

let stalls = 0;
let stallMs = 0;

/** Кино у зрителя стояло `ms` и пошло снова (`usePlayback`): уйдёт со следующим событием просмотра кино. */
export function noteCinemaStall(ms: number): void {
  if (!(ms > 0)) return;
  stalls += 1;
  stallMs += ms;
}

export class IntegrationViews {
  private at: number | null = null;
  private seconds = new Map<string, { view: IntegrationNow; seconds: number }>();

  constructor(private readonly room: string) {}

  /** Замер: что идёт сейчас и видна ли страница. Время с прошлого замера засчитывается тому, что шло. */
  tick(active: readonly IntegrationNow[], visible: boolean, now: number): void {
    const step = this.at === null ? 0 : now - this.at;
    this.at = now;
    if (step <= 0 || step > MAX_STEP_MS) return;
    for (const view of active) {
      if (!visible && view.kind !== 'music') continue;
      const key = `${view.kind}/${view.variant ?? ''}`;
      const entry = this.seconds.get(key) ?? { view, seconds: 0 };
      entry.seconds += step / 1000;
      this.seconds.set(key, entry);
    }
  }

  /** Отправить накопленное. Меньше секунды — не просмотр: остаток ждёт следующего раза. */
  flush(): void {
    for (const [key, { view, seconds }] of this.seconds) {
      if (seconds < 1) continue;
      const cinema = view.kind === 'cinema';
      noteIntegrationView({
        room: this.room,
        kind: view.kind,
        variant: view.variant,
        seconds,
        stalls: cinema ? stalls : undefined,
        stallMs: cinema ? stallMs : undefined,
      });
      if (cinema) stalls = stallMs = 0;
      this.seconds.delete(key);
    }
  }
}

export function resetIntegrationViewsForTest(): void {
  stalls = stallMs = 0;
}
