import { Gamepad2, Joystick, MicVocal, Music2, Presentation, Send, Tv, type LucideIcon } from 'lucide-react';
import type { MusicSource } from '../core/services';

/**
 * Витрина интеграций — одним списком, в том порядке, в каком её видит человек (E06-B).
 *
 * ПОРЯДОК — РЕШЕНИЕ ВЛАДЕЛЬЦА. Сверху то, что включают чаще всего и что занимает встречу: игры,
 * кинозал, музыка. Под ними — обещанное («Скоро»): любая игра (T08), сцена стендап (T12), доска
 * рисования (T13). И в самом низу, за чертой, Telegram (T30): он не «ещё одна интеграция во
 * встрече», а связь комнаты с беседой снаружи, и подключает его только создатель встречи.
 *
 * Карточка «Скоро» не нажимается: у неё нет действия, есть одна строка о том, что это будет.
 * Telegram откроет E09 — когда служба скажет `catalog.telegram.webapp` (П5); до тех пор он здесь
 * такой же «Скоро», как остальные.
 */
export type ShelfId = 'games' | 'cinema' | 'music' | 'any-game' | 'standup' | 'board' | 'telegram';

export interface ShelfItem {
  readonly id: ShelfId;
  readonly name: string;
  /** Что внутри — для готовой группы; что это будет — для «Скоро». Одна строка. */
  readonly hint: string;
  readonly icon: LucideIcon;
  readonly soon: boolean;
  /** Отдельно, за чертой. */
  readonly apart?: boolean;
}

export const SHELF: readonly ShelfItem[] = [
  { id: 'games', name: 'Игры', hint: 'Покер, Дурак, шахматы и Gartic', icon: Gamepad2, soon: false },
  { id: 'cinema', name: 'Кинозал', hint: 'Видео и эфиры на всю комнату', icon: Tv, soon: false },
  { id: 'music', name: 'Музыка', hint: 'Общая очередь на всю встречу', icon: Music2, soon: false },
  { id: 'any-game', name: 'Любая игра', hint: 'Браузерные игры на всю встречу', icon: Joystick, soon: true },
  {
    id: 'standup',
    name: 'Сцена стендап',
    hint: 'Один выступает — остальные смотрят и реагируют',
    icon: MicVocal,
    soon: true,
  },
  {
    id: 'board',
    name: 'Доска рисования',
    hint: 'Общий холст: рисуют все сразу',
    icon: Presentation,
    soon: true,
  },
  {
    id: 'telegram',
    name: 'Telegram',
    hint: 'Встреча и музыка из вашей беседы',
    icon: Send,
    soon: true,
    apart: true,
  },
];

/**
 * Вторая строка карточки Telegram. Видят её все, кроме того, кто может привязать беседу, — а это
 * только создатель встречи (`telegram.link` в матрице ядра, T30). Своего правила здесь нет: решение
 * приносит `allowed(...)`.
 */
export function telegramNote(canLink: boolean): string | null {
  return canLink ? null : 'Подключит создатель встречи';
}

const NAMED: [MusicSource, string][] = [
  ['youtube', 'YouTube'],
  ['soundcloud', 'SoundCloud'],
  ['yandex', 'Яндекс Музыка'],
];

/** Подсказка группы «Музыка»: какие источники включены на этом сервере (`catalog.sources`). */
export function musicHint(sources: readonly MusicSource[]): string {
  const names = NAMED.filter(([source]) => sources.includes(source)).map(([, name]) => name);
  const files = sources.includes('upload');
  if (!names.length) return files ? 'Свои аудиофайлы' : 'Общая очередь на всю встречу';
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')}, ${names.at(-1)}` : names[0]!;
  return files ? `${list} и свои файлы` : list;
}
