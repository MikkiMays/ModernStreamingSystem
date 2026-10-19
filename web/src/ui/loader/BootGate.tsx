import { useEffect } from 'react';
import { dismissBoot } from './boot';

/**
 * Снимает статичную загрузку `index.html` после первого закоммиченного кадра приложения:
 * эффект — после коммита, `requestAnimationFrame` — после отрисовки. Задержки ради эффекта
 * нет (П14): если всё готово за 100 мс, сцена не успеет проявиться, и человек увидит только
 * фон, сменившийся экраном.
 */
export function BootGate() {
  useEffect(() => {
    const frame = requestAnimationFrame(() => void dismissBoot());
    return () => cancelAnimationFrame(frame);
  }, []);
  return null;
}
