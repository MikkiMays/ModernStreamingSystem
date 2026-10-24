import type { PokerTable } from '../../api/types';
import { readyCount } from '../../core/poker';

/**
 * Что шапка покерного стола говорит между раздачами (R46).
 *
 * ОДНО СОСТОЯНИЕ В ШАПКЕ ВМЕСТО ТРЁХ ПЛАШЕК. Раньше «нужен ещё игрок» лежало карточкой на сукне,
 * «сядьте за стол, чтобы играть · раздать можно, когда за столом двое» — серой строкой под ним
 * (R45), а «за столом никого: игра закончится через 8 мин» — ещё одной плашкой поверх (R27).
 * Теперь стол отвечает на один вопрос «что сейчас» одним словом в шапке, там же, где во время
 * раздачи стоит «Ходит Аня». Пока раздача идёт, отвечает не эта функция, а ход — поэтому `null`.
 *
 * Слова и обратный отсчёт подбирает отрисовка: здесь только какое состояние и до какой метки
 * ядра считать.
 */
export type TableStatus =
  | { kind: 'closing'; until: number }
  | { kind: 'paused' }
  | { kind: 'waiting'; ready: number; need: 2 }
  | { kind: 'dealing'; until: number }
  | { kind: 'ready' }
  | { kind: 'dealer' };

export function tableStatus(table: PokerTable, dealer: boolean): TableStatus | null {
  const between = table.phase === 'lobby' || table.phase === 'over';
  if (!between) return null;
  // Пустой стол уходит со сцены сам — об этом сказать важнее всего, и после конца игры тоже.
  if (table.closesAt > 0) return { kind: 'closing', until: table.closesAt };
  if (table.phase === 'over') return null;
  if (table.paused) return { kind: 'paused' };
  const ready = readyCount(table);
  if (ready < 2) return { kind: 'waiting', ready, need: 2 };
  if (table.deadline > 0) return { kind: 'dealing', until: table.deadline };
  return dealer ? { kind: 'ready' } : { kind: 'dealer' };
}
