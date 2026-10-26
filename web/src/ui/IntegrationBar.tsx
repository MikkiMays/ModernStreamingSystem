import { useCallback } from 'react';
import { Store } from '../core/store';
import { useStore } from './primitives';

/**
 * Место в шапке интеграции (R128) — для того, что идёт рядом с ней.
 *
 * Владелец (дополнение 26.10): «этот плеер во время интеграций показывать в шапке интеграции, если
 * сервис музыки во встрече». Раньше мини-плеер над столом висел отдельной плашкой поверх сцены справа
 * внизу. Теперь у каждой шапки стола (покер, дурак, шахматы, рисование) есть это место: шапка сама
 * решает, где оно у неё (справа, перед действиями ведущего), а слой сцены (`StageOverlay`) переносит
 * туда мини-плеер порталом — его состояние, открытый виджет и фокус остаются при нём.
 *
 * Место одно на сцену: интеграция на сцене одна. Кинозала здесь нет — музыка и кинозал во встрече
 * вместе не бывают (`stageBusy` ядра). Компонент общий, чтобы следующие соседи шапки (возврат в
 * интеграцию, R121) вставали сюда же, а не каждая шапка заводила своё.
 */
const slot = new Store<HTMLElement | null>(null);

export function IntegrationBarSlot({ className }: { className?: string }) {
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    slot.set(node);
    return () => {
      if (slot.get() === node) slot.set(null);
    };
  }, []);
  return (
    <div ref={ref} className={className ? `integration-bar-slot ${className}` : 'integration-bar-slot'} />
  );
}

/** Место в шапке интеграции, если интеграция сейчас на сцене, — иначе `null`. */
export function useIntegrationBarSlot(): HTMLElement | null {
  return useStore(slot);
}
