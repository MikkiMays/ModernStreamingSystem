import type { components } from './generated';

export type Participant = components['schemas']['Participant'];
export type Status = Participant['status'];
export type Message = components['schemas']['Message'];
export type Snapshot = components['schemas']['Snapshot'];
export type Admission = components['schemas']['Admission'];
export type Ack = components['schemas']['Ack'];
export type Command = components['schemas']['Command'];
export type Attachment = components['schemas']['Attachment'];
export type Capabilities = components['schemas']['Capabilities'];
export type Replay = components['schemas']['Replay'];
export type RoomEvent = Omit<components['schemas']['Event'], 'version' | 'type'> & {
  version: 1;
  type: 'room.changed' | 'message.created' | 'files.changed';
};
