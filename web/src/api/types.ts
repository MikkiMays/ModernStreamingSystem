import type { components } from './generated';

export type Participant = components['schemas']['Participant'];
export type Status = Participant['status'];
export type Message = components['schemas']['Message'];
export type Snapshot = Omit<components['schemas']['Snapshot'], 'watch' | 'poker'> & {
  watch: Watch | null;
  poker: PokerTable | null;
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
  provider: 'youtube' | 'twitch';
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
export type PokerTable = Omit<components['schemas']['TableView'], 'phase' | 'mode' | 'you'> & {
  phase: PokerPhase;
  mode: PokerMode;
  you: PokerYou | null;
};
export type PokerSeat = components['schemas']['SeatView'];
export type PokerYou = Omit<components['schemas']['YouView'], 'actions'> & { actions: PokerAction[] };
export type PokerResult = components['schemas']['ResultView'];
export type PokerAward = components['schemas']['AwardView'];
export type PokerNote = components['schemas']['NoteView'];
export type PokerPot = components['schemas']['PotView'];

export type RoomEvent = Omit<components['schemas']['Event'], 'version' | 'type'> & {
  version: 1;
  type: 'room.changed' | 'message.created' | 'files.changed' | 'screen.started' | 'screen.first_viewer';
};
