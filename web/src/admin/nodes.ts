import { useQuery } from '@tanstack/react-query';
import { fleet, type Machine, type NodesView } from './api';

/*
  Медиаузлы и ядро продукта (R220, вопрос владельца 09.11: «почему сервера хельсинков и москвы не связаны с
  ядром?»). У машины-узла (`role: media-node`, `nodeId`) своего ядра нет и быть не должно: её комнаты назначает
  ядро продукта, а связь — магистраль mTLS, по которой ядро раз в 2 с опрашивает узел (`cord_node_up{node}`).
  Поэтому «ядра нет» у узла — не беда, а показывать надо его связь с ядром: состояние в реестре ядра и магистраль.
*/

/** Ядро продукта: машина-ядро с учётными данными пульта; продукт — в первую очередь. */
export function productCore(machines: Machine[]): Machine | null {
  const withCore = machines.filter((m) => m.core?.credential);
  return withCore.find((m) => m.role === 'product-core') ?? withCore[0] ?? null;
}

export type NodeState = {
  id: string;
  title: string | null;
  country: string | null;
  control: boolean;
  enabled: boolean;
  /** Состояние по ядру: ok, busy, full, down, drained; `null` — ядро о ступенях не ответило. */
  state: string | null;
  level: number | null;
};

/** Узлы ядра по реестру и ступеням (`GET /nodes/{машина}`), по id узла. */
export function nodeStates(view: NodesView | undefined): Map<string, NodeState> {
  const states = new Map<string, NodeState>();
  const levels = new Map((view?.levels.data ?? []).map((l) => [l.id, l]));
  for (const node of view?.registry?.nodes ?? []) {
    const level = levels.get(node.id);
    states.set(node.id, {
      id: node.id,
      title: node.title?.ru ?? level?.title.ru ?? null,
      country: node.country ?? level?.country ?? null,
      control: !!node.control,
      enabled: node.enabled !== false,
      state: node.enabled === false ? 'drained' : (level?.state ?? null),
      level: level?.level ?? null,
    });
  }
  for (const level of view?.levels.data ?? [])
    if (!states.has(level.id))
      states.set(level.id, {
        id: level.id,
        title: level.title.ru ?? null,
        country: level.country,
        control: level.control,
        enabled: level.state !== 'drained',
        state: level.state,
        level: level.level,
      });
  return states;
}

/** Реестр и ступени узлов ядра продукта — тот же запрос и тот же кэш, что у раздела «Узлы». */
export function useProductNodes(machines: Machine[]) {
  const core = productCore(machines);
  const view = useQuery({
    queryKey: ['nodes', core?.id ?? ''],
    queryFn: () => fleet.get<NodesView>(`/nodes/${core!.id}`),
    enabled: !!core,
    refetchInterval: 15_000,
  });
  return { core, states: nodeStates(view.data), error: view.error };
}

export const NODE_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  ok: 'ok',
  busy: 'warn',
  full: 'warn',
  down: 'bad',
  drained: 'neutral',
};
