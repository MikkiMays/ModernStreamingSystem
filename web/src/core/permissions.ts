import type { Snapshot } from '../api/types';

/**
 * Кто что может во встрече — готовым ответом ядра.
 *
 * РАНЬШЕ ПРАВИЛО ЖИЛО В КАЖДОМ КОМПОНЕНТЕ. «Ведущий или интеграции разрешены всем» было переписано
 * в пяти местах, «принёс стол или ведущий» — в шести, а кнопка «Убрать сервис из встречи»
 * показывалась только ведущему, хотя добавить музыку мог каждый (T14). Теперь ядро
 * (`server/.../room/Permissions.java`) кладёт в снимок участника список `you.can`, и интерфейс
 * спрашивает его по имени действия. Таблица — `docs/superpowers/specs/2026-10-19-permissions.md`.
 */
export type RoomAction =
  | 'room.close'
  | 'room.settings'
  | 'room.integrations'
  | 'invite.manage'
  | 'participant.approve'
  | 'participant.remove'
  | 'participant.mute'
  | 'telegram.link'
  | 'integrations.use'
  | 'music.view'
  | 'music.enable'
  | 'music.control'
  | 'music.upload'
  | 'music.remove'
  | 'music.search'
  | 'music.link'
  | 'yandex.connect'
  | 'yandex.search'
  | 'yandex.queue'
  | 'yandex.disconnect'
  | 'cinema.browse'
  | 'cinema.resolve'
  | 'watch.open'
  | 'watch.control'
  | 'watch.close'
  | 'poker.open'
  | 'poker.manage'
  | 'durak.open'
  | 'durak.manage'
  | 'chess.open'
  | 'chess.manage'
  | 'gartic.open'
  | 'gartic.manage'
  | 'board.open'
  | 'board.draw'
  | 'board.settings'
  | 'board.clear'
  | 'board.close';

/**
 * Класс действия — только для ядра, которое ещё не присылает `you` (откат образа ядра). Классы те
 * же, что у матрицы ядра, поэтому и тогда кнопки совпадают с тем, что ядро и служба пропустят.
 */
type Kind = 'creator' | 'integrations' | 'participant' | 'poker' | 'durak' | 'chess' | 'gartic' | 'board';
const KIND: Record<RoomAction, Kind> = {
  'room.close': 'creator',
  'room.settings': 'creator',
  'room.integrations': 'creator',
  'invite.manage': 'creator',
  'participant.approve': 'creator',
  'participant.remove': 'creator',
  'participant.mute': 'creator',
  'telegram.link': 'creator',
  'integrations.use': 'integrations',
  'music.view': 'participant',
  'music.enable': 'integrations',
  'music.control': 'integrations',
  'music.upload': 'integrations',
  'music.remove': 'integrations',
  'music.search': 'integrations',
  'music.link': 'integrations',
  'yandex.connect': 'integrations',
  'yandex.search': 'integrations',
  'yandex.queue': 'integrations',
  'yandex.disconnect': 'integrations',
  'cinema.browse': 'participant',
  'cinema.resolve': 'participant',
  'watch.open': 'integrations',
  'watch.control': 'integrations',
  'watch.close': 'integrations',
  'poker.open': 'integrations',
  'poker.manage': 'poker',
  'durak.open': 'integrations',
  'durak.manage': 'durak',
  'chess.open': 'integrations',
  'chess.manage': 'chess',
  'gartic.open': 'integrations',
  'gartic.manage': 'gartic',
  // Ядро без `you` доски не знает вовсе: ответ «нельзя» здесь только для порядка.
  'board.open': 'board',
  'board.draw': 'board',
  'board.settings': 'board',
  'board.clear': 'board',
  'board.close': 'board',
};

type View = Pick<
  Snapshot,
  'participants' | 'integrationsAllowed' | 'you' | 'poker' | 'durak' | 'chess' | 'gartic'
>;

/** Можно ли участнику `participantId` действие `action` в этом снимке. */
export function allowed(snapshot: View, participantId: string, action: RoomAction): boolean {
  const granted = snapshot.you?.can;
  if (granted) return granted.includes(action);
  return legacy(snapshot, participantId, action);
}

/** Прежнее правило интерфейса — для снимка без `you`. Одно на весь веб. */
function legacy(snapshot: View, participantId: string, action: RoomAction): boolean {
  const self = snapshot.participants.find((p) => p.id === participantId);
  // Ведущий стола — по самому столу: его `hostId` знает и тот, кого в списке людей ещё нет.
  const host = (table: { hostId: string } | null | undefined) =>
    !!table && (table.hostId === participantId || !!self?.owner);
  switch (KIND[action]) {
    case 'creator':
      return !!self?.owner;
    case 'integrations':
      return !!self && (self.owner || snapshot.integrationsAllowed !== false);
    case 'participant':
      return !!self;
    case 'poker':
      return host(snapshot.poker);
    case 'durak':
      return host(snapshot.durak);
    case 'chess':
      return host(snapshot.chess);
    case 'gartic':
      return host(snapshot.gartic);
    case 'board':
      return false;
  }
}
