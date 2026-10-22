import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Значение ползунка, которое едет за рукой, а пишется не чаще кадра (R14, X5).
 *
 * ПОЧЕМУ. Ползунок звал `savePreferences` на каждое событие `input` — около шестидесяти раз в
 * секунду: разобрать и записать JSON в `localStorage`, разослать `cord:preferences`, перерисовать
 * окно и встречу. Отсюда рывки бегунка. Теперь бегунок и подпись берут значение из своего
 * состояния сразу, запись — одна на кадр (`requestAnimationFrame`, последнее значение), а
 * окончательная — когда ползунок отпустили (`onCommit`, событие `change`).
 *
 * `live: false` — во время перетаскивания не писать вовсе, только при отпускании: громкость
 * микрофона во встрече — это `applyConstraints` и пересборка обработки, а себя человек всё равно
 * не слышит.
 */
export function useLiveValue(value: number, write: (value: number) => void, { live = true } = {}) {
  const [draft, setDraft] = useState<number | null>(null);
  const frame = useRef(0);
  const pending = useRef<number | null>(null);
  const writer = useRef(write);
  useLayoutEffect(() => {
    writer.current = write;
  });
  const flush = () => {
    frame.current = 0;
    if (pending.current === null) return;
    const next = pending.current;
    pending.current = null;
    writer.current(next);
  };
  // Окно закрыли посреди перетаскивания — недописанное значение не теряется.
  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
      flush();
    },
    [],
  );
  return {
    value: draft ?? value,
    /** Каждое движение: бегунок и подпись — сразу, запись — в ближайший кадр. */
    onChange(next: number) {
      setDraft(next);
      if (!live) return;
      pending.current = next;
      if (!frame.current) frame.current = requestAnimationFrame(flush);
    },
    /** Отпустили (или шаг клавишей): записать сейчас и отдать значение хранилищу. */
    onCommit(next: number) {
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      pending.current = null;
      writer.current(next);
      setDraft(null);
    },
  };
}
