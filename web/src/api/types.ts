import type { components } from './generated';

export type Participant = components['schemas']['Participant'];
export type Status = Participant['status'];
export type Message = components['schemas']['Message'];
export type Snapshot = Omit<components['schemas']['Snapshot'], 'watch'> & { watch: Watch | null };
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
export type RoomEvent = Omit<components['schemas']['Event'], 'version' | 'type'> & {
  version: 1;
  type: 'room.changed' | 'message.created' | 'files.changed' | 'screen.started' | 'screen.first_viewer';
};
