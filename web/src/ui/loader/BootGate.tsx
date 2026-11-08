import { useEffect } from 'react';
import { notifyDesktop } from '../../core/desktop';
import { dismissBoot } from './boot';

/**
 * Снимает статичную загрузку `index.html` после первого закоммиченного кадра приложения:
 * эффект — после коммита, `requestAnimationFrame` — после отрисовки. Задержки ради эффекта
 * нет (П14): если всё готово за 100 мс, сцена не успеет проявиться, и человек увидит только
 * фон, сменившийся экраном.
 */
export function BootGate() {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void dismissBoot();
      // Клиент Windows держит заставку, пока интерфейс не нарисован, и показывает окно ровно сейчас (R203):
      // без этого заставка пропадала, а окно ещё секунды грузилось.
      notifyDesktop('app.ready');
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return null;
}
