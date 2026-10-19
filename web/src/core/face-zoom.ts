import type { GameKind } from './preferences';

/**
 * Размер лица за игровым столом (T11).
 *
 * «Совсем немного, но чуть больше»: три ступени — 1×, 1,25× и 1,5×, — и по кругу обратно. Выбор
 * принадлежит смотрящему, как громкость собеседника: комната о нём не знает, у соседа лица того
 * же размера, что и были. Запоминается по игре: за покером хочется крупнее одного, за шахматами —
 * другого.
 */
export const FACE_ZOOMS = [1, 1.25, 1.5] as const;
export type FaceZoom = (typeof FACE_ZOOMS)[number];

/** Следующая ступень по кругу: после самой крупной — обратно к обычной. */
export function nextZoom(zoom: number): FaceZoom {
  const index = FACE_ZOOMS.findIndex((step) => step === zoom);
  return FACE_ZOOMS[(index + 1) % FACE_ZOOMS.length]!;
}

/** Сколько лиц помнится на игру: за вечер сменится не больше, а старые выбрасываются первыми. */
const REMEMBERED = 40;

const key = (game: GameKind) => `cord:face-zoom:${game}`;

export function readZooms(game: GameKind): Record<string, FaceZoom> {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key(game)) ?? '{}');
    if (!data || typeof data !== 'object') return {};
    const zooms: Record<string, FaceZoom> = {};
    for (const [person, zoom] of Object.entries(data as Record<string, unknown>))
      if (typeof zoom === 'number' && FACE_ZOOMS.includes(zoom as FaceZoom) && zoom !== 1)
        zooms[person] = zoom as FaceZoom;
    return zooms;
  } catch {
    return {};
  }
}

/** Записать выбор; обычный размер не хранится — его и так получит любой без записи. */
export function saveZoom(game: GameKind, person: string, zoom: FaceZoom): Record<string, FaceZoom> {
  const zooms = readZooms(game);
  delete zooms[person];
  if (zoom !== 1) zooms[person] = zoom;
  const kept = Object.fromEntries(Object.entries(zooms).slice(-REMEMBERED));
  try {
    localStorage.setItem(key(game), JSON.stringify(kept));
  } catch {
    /* Выбор действует до перезагрузки и без хранилища. */
  }
  return kept;
}

/** Подпись кнопки — что она сделает, а не что сейчас. */
export function zoomLabel(zoom: number, name: string): string {
  const next = nextZoom(zoom);
  return next === 1 ? `Вернуть обычный размер: ${name}` : `Увеличить лицо до ${String(next).replace('.', ',')}×: ${name}`;
}
