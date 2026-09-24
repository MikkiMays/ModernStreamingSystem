import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { ProviderId, SceneId } from '../../../core/cinema';
import type { Meeting } from '../../../core/meeting';

/** Что сцена кинозала получает от сцены встречи. */
export interface SceneProps {
  /** Открытая площадка. У сцены с несколькими площадками она меняется без пересоздания сцены. */
  provider: ProviderId;
  meeting: Meeting;
  /** Перейти на другую площадку, не закрывая каталог. */
  onProvider: (provider: ProviderId) => void;
  onClose: () => void;
}

/**
 * Сцены кинозала по их именам в реестре площадок (`PROVIDERS[id].scene`).
 *
 * Каждая — своим ленивым чанком, как и прежний каталог: встрече, в которой кино не открывали,
 * их код не нужен вовсе. Карта полная по {@link SceneId}: площадка не может назвать сцену,
 * которой нет, — это не соберётся.
 */
export const SCENES: Record<SceneId, LazyExoticComponent<ComponentType<SceneProps>>> = {
  switcher: lazy(() => import('./SwitcherScene')),
  rutube: lazy(() => import('./RutubeScene')),
};
