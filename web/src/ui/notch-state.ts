import type { Snapshot } from '../api/types';
import { clock } from '../core/cinema';
import { stageOccupant, type StageKind } from '../core/stage-view';
import type { Translate } from '../i18n';

/** Имя интеграции на сцене — то же, что у её чипа и в панели «Интеграции». */
export function integrationName(t: Translate, kind: StageKind): string {
  if (kind === 'cinema') return t(($) => $.services.roster.cinema);
  if (kind === 'gartic') return 'Gartic';
  return t(($) => $.services.games[kind]);
}

/** Что сказать в чёлке (R121): имя и одна строка живого состояния интеграции на сцене. */
export interface NotchState {
  kind: StageKind;
  /** Имя интеграции, у фильма — его название. */
  name: string;
  /** Живое состояние: «3 за столом», «Ваш ход», «Рисует Аня», «1:12:40», «LIVE», «Каталог». */
  status: string;
  /** Ход за этим зрителем — заметно, но без мигания. */
  turn: boolean;
  /** Кольцо хода — по меткам ядра, как у мест за столом (`TurnRing`). */
  ring?: { actionAt: number; deadline: number };
  /** Кинозал с фильмом комнаты (а не только свой каталог): у чёлки живой кадр. */
  film: boolean;
  paused: boolean;
  live: boolean;
}

const seatedCount = (seats: readonly { memberId?: string | null }[] | undefined) =>
  (seats ?? []).filter((seat) => !!seat.memberId).length;

/** Кольцо — только когда у хода есть срок: у ядра 0 значит «часов нет». */
const ringOf = (actionAt: number, deadline: number) => (deadline > 0 ? { actionAt, deadline } : undefined);

/**
 * Состояние чёлки по снимку комнаты. `me` — этот зритель (чей ход), `positionMs` — где фильм сейчас
 * (свой `<video>`, иначе якорь комнаты), `catalog` — открыт свой каталог кинозала. Сцена свободна — `null`.
 */
export function notchState(
  t: Translate,
  room: Snapshot,
  me: string,
  positionMs: number,
  catalog = false,
): NotchState | null {
  const occupant = stageOccupant(room, catalog);
  if (!occupant) return null;
  const base = { kind: occupant.kind, turn: false, film: false, paused: false, live: false };
  const seated = (count: number) => t(($) => $.stage.notch.seated, { n: count });
  const yours = t(($) => $.stage.notch.turn);
  if (occupant.kind === 'poker' && room.poker) {
    const table = room.poker;
    const turn = !!table.you?.turn && !table.paused;
    return {
      ...base,
      name: integrationName(t, 'poker'),
      status: turn ? yours : seated(seatedCount(table.seats)),
      turn,
      ...(turn ? { ring: ringOf(table.actionAt, table.deadline) } : {}),
    };
  }
  if (occupant.kind === 'durak' && room.durak) {
    const table = room.durak;
    const turn = !!table.you?.turn && !table.paused && table.phase === 'bout';
    return {
      ...base,
      name: integrationName(t, 'durak'),
      status: turn ? yours : seated(seatedCount(table.seats)),
      turn,
      ...(turn ? { ring: ringOf(table.actionAt, table.deadline) } : {}),
    };
  }
  if (occupant.kind === 'chess' && room.chess) {
    const table = room.chess;
    const color = table.white?.memberId === me ? 'white' : table.black?.memberId === me ? 'black' : null;
    const turn = table.phase === 'playing' && !!color && table.turn === color;
    return {
      ...base,
      name: integrationName(t, 'chess'),
      status: turn ? yours : seated([table.white, table.black].filter(Boolean).length),
      turn,
    };
  }
  if (occupant.kind === 'gartic' && room.gartic) {
    const game = room.gartic;
    const name = integrationName(t, 'gartic');
    const drawing = game.phase === 'drawing' || game.phase === 'choosing';
    if (drawing && game.drawerId) {
      const turn = game.drawerId === me;
      const drawer = game.players.find((player) => player.memberId === game.drawerId)?.name ?? '';
      return {
        ...base,
        name,
        status: turn ? t(($) => $.stage.notch.youDraw) : t(($) => $.stage.notch.drawing, { name: drawer }),
        turn,
        ...(turn ? { ring: ringOf(game.phaseStartedAt, game.deadline) } : {}),
      };
    }
    // «Испорченный телефон»: все пишут и рисуют разом — ход за зрителем, пока он не сдал своё.
    const telephone = ['prompt', 'describing', 'drawing'].includes(game.phase);
    const turn = telephone && !!game.you?.playing && !game.you.submitted;
    return {
      ...base,
      name,
      status: turn ? yours : seated(game.players.length),
      turn,
      ...(turn ? { ring: ringOf(game.phaseStartedAt, game.deadline) } : {}),
    };
  }
  const watch = room.watch;
  if (!watch)
    return { ...base, name: integrationName(t, 'cinema'), status: t(($) => $.cinema.theater.catalog) };
  const live = watch.kind === 'channel';
  return {
    ...base,
    name: watch.title?.trim() || integrationName(t, 'cinema'),
    status: live ? 'LIVE' : clock(positionMs / 1000),
    film: true,
    paused: watch.paused,
    live,
  };
}
