import { Store } from '../core/store';

/**
 * Журнал камеры (R189, И7): кольцо последних событий — что сторож заметил и что сделал, что стало с
 * фоном. Показывается в «Диагностике» и уходит с ней в обращение: без него «камера отвалилась» у
 * человека нечем разобрать — сервер камеру не видит. Без текста и идентификаторов (П8): вид события и
 * короткая техническая подробность (имя ошибки, причина).
 */
export interface CameraEvent {
  at: number;
  kind: string;
  detail?: string;
}

export const CAMERA_LOG_SIZE = 30;

export class CameraLog {
  readonly events = new Store<readonly CameraEvent[]>([]);

  constructor(private readonly now: () => number = () => Date.now()) {}

  note(kind: string, detail?: string): void {
    this.events.update((events) => {
      const next = [...events, { at: this.now(), kind, ...(detail ? { detail } : {}) }];
      return next.length > CAMERA_LOG_SIZE ? next.slice(next.length - CAMERA_LOG_SIZE) : next;
    });
  }

  /** Строки для «Диагностики» и обращения: время по часам, вид, подробность. */
  lines(): string[] {
    return this.events.get().map((event) => {
      const time = new Date(event.at).toISOString().slice(11, 19);
      return `camera ${time} ${event.kind}${event.detail ? ` ${event.detail}` : ''}`;
    });
  }
}
