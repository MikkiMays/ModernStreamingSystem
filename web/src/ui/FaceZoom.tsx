import type { CSSProperties } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { nextZoom, readZooms, saveZoom, zoomLabel, type FaceZoom } from '../core/face-zoom';
import type { GameKind } from '../core/preferences';
import { Store } from '../core/store';
import { useStore } from './primitives';
import '../game-people.css';

/** Один выбор на игру для всех мест стола: кнопка у одного лица перерисовывает только его. */
const stores = new Map<GameKind, Store<Record<string, FaceZoom>>>();
function storeFor(game: GameKind) {
  let store = stores.get(game);
  if (!store) {
    store = new Store(readZooms(game));
    stores.set(game, store);
  }
  return store;
}

/** Размер лица этого человека у этого зрителя и то, как его поменять. */
export function useFaceZoom(game: GameKind, person: string | null | undefined) {
  const store = storeFor(game);
  const zooms = useStore(store);
  const zoom: FaceZoom = (person && zooms[person]) || 1;
  return {
    zoom,
    /** CSS-переменная для лица: стол её читает и растит лицо наружу, от сукна. */
    style: { '--face-zoom': zoom } as CSSProperties,
    cycle: () => {
      if (person) store.set(saveZoom(game, person, nextZoom(zoom)));
    },
  };
}

/**
 * Кнопка «увеличить» в правом верхнем углу лица (T11). Видна при наведении и фокусе, на
 * сенсорном экране — всегда, но приглушённо: наводить там нечем.
 */
export function FaceZoomButton({ zoom, name, onCycle }: { zoom: number; name: string; onCycle: () => void }) {
  const { t } = useTranslation();
  const label = zoomLabel(t, zoom, name);
  return (
    <button
      type="button"
      className="face-zoom"
      data-zoomed={zoom > 1 || undefined}
      aria-label={label}
      title={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onCycle();
      }}
    >
      {nextZoom(zoom) === 1 ? <ZoomOut size={13} /> : <ZoomIn size={13} />}
    </button>
  );
}
