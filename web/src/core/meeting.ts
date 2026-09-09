import { ConnectionQuality } from 'livekit-client';
import type { Admission, Command, RoomEvent, Snapshot } from '../api/types';
import { RoomApi } from '../api/client';
import { MediaSession, type DeviceChoice } from '../media/session';
import { ControlChannel } from './control';
import { Store } from './store';
import { Uploader } from './uploader';
import { rememberMeeting } from './recent';

export class Meeting {
  readonly api: RoomApi;
  readonly snapshot: Store<Snapshot>;
  readonly ended = new Store<string | null>(null);
  readonly invite: Store<string | null>;
  readonly fileRevision = new Store(0);
  readonly media: MediaSession;
  readonly control: ControlChannel;
  readonly uploader: Uploader;
  private refreshing = false;
  private refreshAgain = false;
  private started = false;
  private disposed = false;
  private initialDevicesApplied = false;
  private subscriptions: (() => void)[] = [];
  constructor(
    readonly admission: Admission,
    private choices: DeviceChoice & { micOn?: boolean; cameraOn?: boolean } = {},
  ) {
    this.api = new RoomApi(admission);
    this.snapshot = new Store(admission.snapshot);
    this.invite = new Store(admission.inviteUrl);
    this.media = new MediaSession(this.api, (reason) => {
      this.end(reason);
      void this.api.command({ commandId: crypto.randomUUID(), type: 'leave' }).catch(() => {});
    });
    this.control = new ControlChannel(this.api, this.accept, this.event, () =>
      this.end('Доступ к встрече завершён'),
    );
    this.uploader = new Uploader(this.api, () => this.fileRevision.update((n) => n + 1));
    if (sessionStorage.getItem(`cord:ended:${admission.roomId}`) === admission.participantId)
      this.ended.set('Эта сессия завершена. Для нового входа используйте приглашение.');
  }
  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    this.control.start();
    this.accept(this.snapshot.get());
    this.subscriptions.push(
      this.media.state.subscribe(() => {
        const state = this.media.state.get();
        void this.uploader.congestion(
          state.quality === ConnectionQuality.Poor ||
            state.quality === ConnectionQuality.Lost ||
            state.status === 'recovering',
        );
        if (state.status === 'connected' && !this.initialDevicesApplied) {
          this.initialDevicesApplied = true;
          if (this.choices.micOn) void this.media.toggle('microphone', this.choices.microphone);
          if (this.choices.cameraOn) void this.media.toggle('camera', this.choices.camera);
        }
      }),
    );
  }
  private accept = (snapshot: Snapshot) => {
    if (this.disposed) return;
    if (snapshot.sequence < this.snapshot.get().sequence) return;
    this.snapshot.set(snapshot);
    if (snapshot.closedAt) {
      this.end('Встреча завершена');
      return;
    }
    if (this.ended.get()) return;
    const self = snapshot.participants.find((p) => p.id === this.admission.participantId);
    if (!self) {
      this.end('Вы вышли из встречи');
      return;
    }
    if (self.status !== 'WAITING' && this.media.state.get().status === 'idle') void this.media.start();
  };
  private event = (event: RoomEvent) => {
    if (event.type === 'files.changed') this.fileRevision.update((n) => n + 1);
    void this.refresh();
  };
  async refresh() {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      this.accept(await this.api.snapshot());
    } catch {
      /* The control channel will request replay after reconnect. */
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    }
  }
  async command(type: Command['type'], text?: string, targetId?: string) {
    const ack = await this.control.command({ commandId: crypto.randomUUID(), type, text, targetId });
    if (type === 'invite.create' && ack.value) this.invite.set(ack.value);
    if (type === 'invite.revoke') this.invite.set(null);
    await this.refresh();
    if (!this.disposed)
      rememberMeeting({ ...this.admission, snapshot: this.snapshot.get(), inviteUrl: this.invite.get() });
    return ack;
  }
  async leave() {
    rememberMeeting({ ...this.admission, snapshot: this.snapshot.get(), inviteUrl: this.invite.get() });
    this.end('Вы вышли из встречи');
    await this.api.command({ commandId: crypto.randomUUID(), type: 'leave' }).catch(() => {});
  }
  private end(reason: string) {
    if (this.disposed) return;
    sessionStorage.setItem(`cord:ended:${this.admission.roomId}`, this.admission.participantId);
    this.media.dispose();
    this.ended.set(reason);
    void this.uploader.pause();
  }
  dispose() {
    this.disposed = true;
    this.control.dispose();
    this.media.dispose();
    this.subscriptions.forEach((fn) => fn());
    void this.uploader.pause();
  }
}
