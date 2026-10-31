import type { Snapshot } from '../api/types';

/**
 * Вид сцены у этого зрителя (R121): интеграция или все участники.
 *
 * Владелец 25.10: «внутри сцены нельзя выйти на всех участников… возможность выйти на просмотр всех
 * участников даст возможность посмотреть все камеры блоками как на встрече и также видеть окна людей, кто
 * стримит». Сцену занимает одна интеграция (`stageBusy` ядра): кинозал, покер, дурак, шахматы или
 * рисование. Зритель может уйти от неё к обычной встрече и вернуться чёлкой — это его личный выбор: комната
 * о нём не знает, интеграция идёт для всех.
 *
 * Здесь только правила, без интерфейса: что занимает сцену, какой вид показать и что остаётся от ухода,
 * когда сцена меняется. Хранит уход встреча (`Meeting.stageAway`).
 */
export type StageKind = 'chess' | 'gartic' | 'poker' | 'durak' | 'cinema';

/** Что занимает сцену. `film` — кинозал с фильмом комнаты, а не только свой открытый каталог. */
export interface StageOccupant {
  kind: StageKind;
  film: boolean;
  /** Какой фильм (`площадка:ролик`) — новый фильм открывается у всех (R150, Р-42). */
  content?: string;
}

export type StageView = 'meeting' | 'integration' | 'people';

type Room = Pick<Snapshot, 'chess' | 'gartic' | 'poker' | 'durak' | 'watch'>;

/**
 * Кто на сцене — в том же порядке, в каком её отдаёт `Stage.tsx`. Кинозал — это и фильм комнаты, и свой
 * каталог площадки (`catalog`): каталог личный, но лежит на той же сцене и так же закрывает людей.
 */
export function stageOccupant(room: Room, catalog: boolean): StageOccupant | null {
  if (room.chess) return { kind: 'chess', film: false };
  if (room.gartic) return { kind: 'gartic', film: false };
  if (room.poker) return { kind: 'poker', film: false };
  if (room.durak) return { kind: 'durak', film: false };
  if (room.watch)
    return { kind: 'cinema', film: true, content: `${room.watch.provider}:${room.watch.contentId}` };
  return catalog ? { kind: 'cinema', film: false } : null;
}

/**
 * Что показать: обычную встречу (сцена свободна), интеграцию или участников. Открытый чужой экран при
 * занятой сцене — тоже вид участников: смотреть показ и смотреть интеграцию разом сцена не может.
 */
export function stageView(
  occupant: StageOccupant | null,
  away: StageKind | null,
  viewing: boolean,
): StageView {
  if (!occupant) return 'meeting';
  return viewing || away === occupant.kind ? 'people' : 'integration';
}

/**
 * Что остаётся от ухода, когда сцена сменилась.
 *
 * Уход привязан к той интеграции, от которой ушли. Кончилась она или её сменила другая — уход забыт:
 * новая интеграция открывается у всех, как и без R121. То же, когда зритель ушёл из своего каталога, а
 * комната тем временем включила фильм: это новый фильм для всех. И другой фильм в идущем кинозале — тоже
 * новый фильм для всех (R150, Р-42, владелец 31.10: «открытие комнаты должно быть для всех и четко»).
 * Пауза, перемотка и та же запись — та же интеграция, и ушедший остаётся с людьми.
 */
export function awayAfter(
  away: StageKind | null,
  before: StageOccupant | null,
  after: StageOccupant | null,
): StageKind | null {
  if (!away || !after || after.kind !== away) return null;
  if (after.film && before && !before.film) return null;
  if (after.film && before?.film && after.content !== before.content) return null;
  return away;
}

/** Комната включила другой фильм (или фильм после каталога) — то, что все должны увидеть (R150). */
export function newFilm(before: StageOccupant | null, after: StageOccupant | null): boolean {
  return !!after?.film && (!before?.film || before.content !== after.content);
}
