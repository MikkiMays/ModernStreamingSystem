import { Gamepad2, Joystick, MicVocal, Music2, Presentation, Send, Tv, type LucideIcon } from 'lucide-react';
import { musicSourceName, type MusicSource } from '../core/services';
import type { Translate } from '../i18n';
import type { BrandId } from './brands';

/**
 * Витрина интеграций — одним списком, в том порядке, в каком её видит человек (E06-B).
 *
 * ПОРЯДОК — РЕШЕНИЕ ВЛАДЕЛЬЦА. Сверху то, что включают чаще всего и что занимает встречу: игры,
 * кинозал, музыка. Под ними — обещанное («Скоро»): любая игра (T08), сцена стендап (T12); доска
 * рисования (T13) стала готовой (R159) и встала к ним. И в самом низу, за чертой, Telegram (T30): он не «ещё одна интеграция во
 * встрече», а связь комнаты с беседой снаружи, и подключает его только создатель встречи.
 *
 * Карточка «Скоро» не нажимается: у неё нет действия, есть одна строка о том, что это будет.
 * Telegram откроет E09 — когда служба скажет `catalog.telegram.webapp` (П5); до тех пор он здесь
 * такой же «Скоро», как остальные.
 *
 * Здесь — только устройство витрины; имя и строка карточки — в каталоге (`integrations.shelf.<id>`):
 * {@link shelfName} и {@link shelfHint}.
 */
export type ShelfId = 'games' | 'cinema' | 'music' | 'any-game' | 'standup' | 'board' | 'telegram';

export interface ShelfItem {
  readonly id: ShelfId;
  readonly icon: LucideIcon;
  readonly soon: boolean;
  /** Цвет плашки значка (`brands.ts`, R33); у «Скоро» плашка серая, пока интеграции нет. */
  readonly brand?: BrandId;
  /** Отдельно, за чертой. */
  readonly apart?: boolean;
}

export const SHELF: readonly ShelfItem[] = [
  { id: 'games', icon: Gamepad2, soon: false, brand: 'games' },
  { id: 'cinema', icon: Tv, soon: false, brand: 'cinema' },
  { id: 'music', icon: Music2, soon: false, brand: 'music' },
  { id: 'any-game', icon: Joystick, soon: true },
  { id: 'standup', icon: MicVocal, soon: true },
  // Доска (R159) — готова: открывается на сцене, как кинозал и игры.
  { id: 'board', icon: Presentation, soon: false, brand: 'board' },
  { id: 'telegram', icon: Send, soon: true, apart: true, brand: 'telegram' },
];

/** Имя карточки. «Telegram» пишется латиницей на любом языке и в каталог не идёт. */
export function shelfName(t: Translate, id: ShelfId): string {
  if (id === 'telegram') return 'Telegram';
  return t(($) => $.integrations.shelf[id].name);
}

/** Что внутри — для готовой группы; что это будет — для «Скоро». Одна строка. */
export function shelfHint(t: Translate, id: ShelfId): string {
  return t(($) => $.integrations.shelf[id].hint);
}

/**
 * Вторая строка карточки Telegram. Видят её все, кроме того, кто может привязать беседу, — а это
 * только создатель встречи (`telegram.link` в матрице ядра, T30). Своего правила здесь нет: решение
 * приносит `allowed(...)`.
 */
export function telegramNote(t: Translate, canLink: boolean): string | null {
  return canLink ? null : t(($) => $.integrations.telegramNote);
}

/** Источники, которые подсказка называет по имени, — в этом порядке. */
const NAMED: readonly MusicSource[] = ['youtube', 'soundcloud', 'yandex'];

/** Подсказка группы «Музыка»: какие источники включены на этом сервере (`catalog.sources`). */
export function musicHint(t: Translate, sources: readonly MusicSource[]): string {
  const names = NAMED.filter((source) => sources.includes(source)).map((source) =>
    musicSourceName(t, source),
  );
  const files = sources.includes('upload');
  if (!names.length)
    return files ? t(($) => $.integrations.music.files) : t(($) => $.integrations.music.queue);
  const list = names.join(', ');
  return files ? t(($) => $.integrations.music.withFiles, { list }) : list;
}
