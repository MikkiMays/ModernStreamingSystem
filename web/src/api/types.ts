import type { components } from './generated';
import type { ProviderId } from '../core/cinema/providers';

export type Participant = components['schemas']['Participant'];
export type Status = Participant['status'];
export type Message = components['schemas']['Message'];
export type Snapshot = Omit<
  components['schemas']['Snapshot'],
  'watch' | 'poker' | 'durak' | 'chess' | 'gartic'
> & {
  watch: Watch | null;
  poker: PokerTable | null;
  durak: DurakTable | null;
  chess?: ChessTable | null;
  gartic?: GarticTable | null;
};
/** Снимок сужен (см. `Watch`), поэтому всё, что его содержит, сужается вместе с ним. */
export type Admission = Omit<components['schemas']['Admission'], 'snapshot'> & { snapshot: Snapshot };
export type Ack = components['schemas']['Ack'];
export type Command = components['schemas']['Command'];
export type Attachment = components['schemas']['Attachment'];
export type Capabilities = components['schemas']['Capabilities'];
export type Replay = Omit<components['schemas']['Replay'], 'snapshot'> & { snapshot: Snapshot | null };
/**
 * Что комната смотрит вместе. Провайдер и вид приходят строками — здесь они сужаются до того,
 * что ядро действительно принимает: иначе каждое место, где по ним ветвятся, проверяло бы
 * заново, а забытая ветка молча ничего не показывала бы.
 */
export type Watch = Omit<components['schemas']['Watch'], 'provider' | 'kind' | 'title'> & {
  provider: ProviderId;
  kind: 'video' | 'channel';
  title: string | null;
};
/**
 * Покерный стол так, как его видит этот браузер.
 *
 * Строковые поля ядра сужаются здесь до того, что оно действительно присылает: иначе каждая
 * ветка по фазе игры проверялась бы заново, а забытая молча ничего не рисовала бы. Чужих карт в
 * этих типах нет не потому, что их «не показывают», — их нет в ответе сервера ([[TableView]]).
 */
export type PokerPhase = 'lobby' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'over';
export type PokerMode = 'friendly' | 'tournament' | 'turbo';
export type PokerAction = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';
export type PokerTable = Omit<
  components['schemas']['TableView'],
  'phase' | 'mode' | 'you' | 'summary' | 'visualEvents'
> & {
  visualEvents?: GameVisualEvent[];
  phase: PokerPhase;
  mode: PokerMode;
  you: PokerYou | null;
  /** Итоги игры — только когда она кончилась; всё остальное время `null`. */
  summary: PokerGame | null;
};
export type PokerSeat = components['schemas']['SeatView'];
export type PokerYou = Omit<components['schemas']['YouView'], 'actions'> & { actions: PokerAction[] };
export type PokerResult = components['schemas']['ResultView'];
export type PokerAward = components['schemas']['AwardView'];
export type PokerNote = components['schemas']['NoteView'];
export type PokerPot = components['schemas']['PotView'];
/**
 * Игра, которая кончилась.
 *
 * Итог, а не лог: кто играл, сколько докупался, сколько поставил, кто сорвал самый крупный банк.
 * Приезжает отдельной ручкой (`/games`), а не в снимке комнаты — десять таких таблиц в каждом
 * снимке означали бы килобайты на каждое чужое повышение.
 */
export type PokerGame = Omit<components['schemas']['GameSummary'], 'ending'> & {
  ending: PokerEnding;
};
/**
 * Чем кончилась игра.
 *
 * Ядро присылает это строкой — снимок комнаты читается и той версией, которая новых концов не
 * знает. Полнота проверяется здесь, где это ничего не стоит: подписи к концам лежат в
 * `Record<PokerEnding, string>`, и забытый конец не компилируется.
 */
export type PokerEnding = 'winner' | 'closed' | 'idle' | 'meeting';
export type PokerPlayer = components['schemas']['PlayerSummary'];
export type PokerHighlight = components['schemas']['Highlight'];

/**
 * Стол дурака так, как его видит этот браузер.
 *
 * Сужение то же самое, что у покера, и по той же причине: ядро присылает фазу, режим и действия
 * строками, а забытая ветка по строке молча ничего не рисует. Чужих карт в этих типах нет не
 * потому, что их «не показывают», — их нет в ответе сервера (`DurakView`).
 */
export type DurakPhase = 'lobby' | 'bout' | 'over';
export type DurakMode = 'podkidnoy' | 'perevodnoy';
/** Чем кончился бой, который ещё лежит на столе. */
export type DurakBoutEnd = 'beaten' | 'taken';
export type DurakAction = 'attack' | 'beat' | 'take' | 'pass' | 'transfer';
export type DurakTable = Omit<
  components['schemas']['DurakView'],
  'phase' | 'mode' | 'you' | 'boutEnd' | 'visualEvents' | 'reactions'
> & {
  visualEvents?: GameVisualEvent[];
  reactions?: GameReaction[];
  phase: DurakPhase;
  mode: DurakMode;
  you: DurakYou | null;
  boutEnd: DurakBoutEnd | null;
};
export type DurakSeat = components['schemas']['DurakSeat'];
export type DurakYou = Omit<components['schemas']['DurakYou'], 'actions'> & {
  actions: DurakAction[];
};
export type DurakPair = components['schemas']['CardPair'];
export type DurakScore = components['schemas']['DurakScore'];
/** Итог одной партии вместе со счётом вечера на её момент. */
export type DurakGame = components['schemas']['DurakSummary'];
export type DurakGamePlayer = components['schemas']['DurakPlayer'];
export type DurakNote = components['schemas']['DurakNote'];
export type DurakResult = components['schemas']['DurakResult'];

export type RoomEvent = Omit<components['schemas']['Event'], 'version' | 'type'> & {
  version: 1;
  type: 'room.changed' | 'message.created' | 'files.changed' | 'screen.started' | 'screen.first_viewer';
};

export type GameVisualEvent = Omit<components['schemas']['GameVisualEvent'], 'type'> & {
  type: 'deal' | 'draw' | 'play' | 'take' | 'discard';
};
export type GameReaction = components['schemas']['DurakReaction'];
export type ChessTable = components['schemas']['ChessView'];
export type GarticTable = components['schemas']['GarticView'];
