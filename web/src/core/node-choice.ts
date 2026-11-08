import { Store } from './store';
import { nodeProbe, type NodeMeasure } from '../media/node-probe';

/**
 * «Авто / вручную» для узла медиа (R200, Р-101, `docs/architecture/server-selection.md` §3.1).
 *
 * По умолчанию — «Авто»: узел новой встречи выбирает ядро по замеру пути с этого устройства
 * (`media/node-probe.ts`). Человек может назвать узел руками в «Настройки → Сервер»: вне встречи выбор
 * относится к **следующей** встрече, которую он создаст, и помнится на устройстве до возврата на «Авто»;
 * входящий по ссылке на узел чужой встречи не влияет. Во встрече тот же список переводит эту встречу
 * (`RoomApi.moveMedia`) — это не здесь, а в `ServerSection`.
 *
 * Ядро узел всё равно проверяет: занятый или мёртвый узел оно заменит и скажет об этом
 * (`Admission.nodeFallback`), а не откажет.
 */
export const MANUAL_NODE_KEY = 'cord:node:manual';

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function read(): string | null {
  try {
    const raw = storage()?.getItem(MANUAL_NODE_KEY);
    return raw && /^[a-z][a-z0-9-]{0,15}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Узел, выбранный руками для следующей встречи; `null` — «Авто». */
export const manualNode = new Store<string | null>(read());

export function setManualNode(id: string | null) {
  manualNode.set(id);
  try {
    if (id) storage()?.setItem(MANUAL_NODE_KEY, id);
    else storage()?.removeItem(MANUAL_NODE_KEY);
  } catch {
    /* Приватное окно: выбор живёт до перезагрузки. */
  }
}

export interface CreateNodeChoice {
  preferredNode: string | null;
  measurements: NodeMeasure[];
  manual: boolean;
}

/**
 * Что отправить в `POST /rooms` (R195 + R200): ручной узел, если он есть и ядро его ещё называет
 * (узел убрали из реестра — выбор молча сбрасывается на «Авто»), иначе — результат замера. Замеры
 * идут и при ручном выборе: ядро по ним выберет замену, если узел занят.
 */
export async function nodeForCreate(): Promise<CreateNodeChoice> {
  const manual = manualNode.get();
  if (manual && !nodeProbe.known().some((n) => n.id === manual) && nodeProbe.known().length > 0) {
    setManualNode(null);
    return nodeForCreate();
  }
  const measured = await nodeProbe.preferred();
  if (manual) return { preferredNode: manual, measurements: measured.measures, manual: true };
  return { preferredNode: measured.node, measurements: measured.measures, manual: false };
}
