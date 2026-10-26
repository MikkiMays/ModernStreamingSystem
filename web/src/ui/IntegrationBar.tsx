import { useCallback } from 'react';
import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Store } from '../core/store';
import { useStore } from './primitives';
import { STAGE_KEY_LABEL, useStageExit } from './stage-context';
import './stage-exit.css';

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
 * вместе не бывают (`stageBusy` ядра). Компонент общий, чтобы следующие соседи шапки вставали сюда же, а
 * не каждая шапка заводила своё: так встал выход к участникам (R121, {@link StageExitButton}).
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

/**
 * «Участники» — выход из интеграции к виду всех участников (R121), сосед мини-плеера в шапке интеграции.
 *
 * Владелец 25.10: «возможность выйти на просмотр всех участников даст возможность посмотреть все камеры
 * блоками как на встрече и также видеть окна людей, кто стримит». Интеграция при этом идёт для всех, а
 * вернуться в неё — чёлкой сверху. Кнопка одна на шапки столов (`bar`), пульт плеера (`theater` — пилюлей,
 * как «Каталог») и полосу каталога кинозала (`catalog` — значком: там тесно от поиска). Действие даёт
 * сцена (`StageExitContext`); вне сцены встречи кнопки нет.
 */
export function StageExitButton({ variant }: { variant: 'bar' | 'theater' | 'catalog' }) {
  const { t } = useTranslation();
  const { leave } = useStageExit();
  if (!leave) return null;
  const label = t(($) => $.stage.exit.label);
  const title = t(($) => $.stage.exit.title, { key: STAGE_KEY_LABEL });
  // В полосе каталога соседи — прежние кнопки-значки (`.icon-button`): та же метрика и тот же вид.
  if (variant === 'catalog')
    return (
      <button
        type="button"
        className="icon-button"
        aria-label={label}
        title={title}
        aria-keyshortcuts={STAGE_KEY_LABEL}
        data-stage-exit=""
        onClick={leave}
      >
        <Users size={20} aria-hidden="true" />
      </button>
    );
  return (
    <button
      type="button"
      className={variant === 'theater' ? 'watch-browse stage-exit' : 'stage-exit stage-exit--bar'}
      aria-label={label}
      title={title}
      aria-keyshortcuts={STAGE_KEY_LABEL}
      data-stage-exit=""
      onClick={leave}
    >
      <Users size={16} aria-hidden="true" />
      <span className="stage-exit__label">{label}</span>
    </button>
  );
}
