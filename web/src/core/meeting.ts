import { ConnectionQuality } from 'livekit-client';
import type { Admission, Command, RoomEvent, Snapshot } from '../api/types';
import { ApiError, RoomApi } from '../api/client';
import { MediaSession, type DeviceChoice } from '../media/session';
import { ControlChannel } from './control';
import { Store } from './store';
import { Uploader } from './uploader';
import { rememberMeeting } from './recent';
import { NotificationSounds } from './sounds';

export class Meeting {
  readonly api: RoomApi;
  readonly snapshot: Store<Snapshot>;
  readonly viewing = new Store<{ screenId: string; participantId: string } | null>(null);
  readonly pinnedCamera = new Store<string | null>(null);
  private viewChange: Promise<unknown> = Promise.resolve();
  private viewRevision = 0;
  private played = new Set<string>();
  private sounds = new NotificationSounds();
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
  private syncTimer?: ReturnType<typeof setInterval>;
  private subscriptions: (() => void)[] = [];
  constructor(
    readonly admission: Admission,
    private choices: DeviceChoice & { micOn?: boolean; cameraOn?: boolean } = {},
  ) {
    this.api = new RoomApi(admission);
    this.snapshot = new Store(admission.snapshot);
    this.invite = new Store(admission.inviteUrl);
    this.media = new MediaSession(this.api, (reason) => {
      void this.resolveEnd(reason, true);
    });
    this.control = new ControlChannel(this.api, this.accept, this.event, this.resolveRevocation);
    this.uploader = new Uploader(this.api, () => this.fileRevision.update((n) => n + 1));
    if (sessionStorage.getItem(`cord:ended:${admission.roomId}`) === admission.participantId)
      this.ended.set('Эта сессия завершена. Для нового входа используйте приглашение.');
  }
  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    this.sounds.start();
    this.control.start();
    this.accept(this.snapshot.get());
    // Admission must also work when an intermediary stalls the events socket.
    this.syncTimer = setInterval(() => {
      if (this.media.state.get().status !== 'connected' || this.control.state.get() !== 'connected')
        void this.refresh();
    }, 2000);
    window.addEventListener('online', this.refreshOnReturn);
    document.addEventListener('visibilitychange', this.refreshOnReturn);
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
  private refreshOnReturn = () => {
    if (!document.hidden) void this.refresh();
  };
  private accept = (snapshot: Snapshot) => {
    if (this.disposed) return;
    if (snapshot.sequence < this.snapshot.get().sequence) return;
    this.snapshot.set(snapshot);
    const viewing = this.viewing.get();
    if (viewing && !snapshot.participants.some((p) => p.screenId === viewing.screenId && p.screen)) {
      this.viewRevision++;
      this.viewing.set(null);
      this.media.watchScreen(null);
    }
    if (!snapshot.participants.some((p) => p.id === this.pinnedCamera.get())) this.pinnedCamera.set(null);
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
    if (
      ['JOINING', 'CONNECTED', 'RECOVERING'].includes(self.status) &&
      this.media.state.get().status === 'idle'
    )
      void this.media.start();
  };
  private resolveRevocation = () => {
    void this.resolveEnd('Доступ к встрече завершён');
  };
  private async resolveEnd(reason: string, leave = false) {
    if (this.disposed || this.ended.get()) return;
    // The SFU disconnect can arrive before the control channel's final room event.
    // Read the authoritative room once even though media has already stopped.
    try {
      const snapshot = await this.api.snapshot();
      if (this.disposed) return;
      if (snapshot.sequence >= this.snapshot.get().sequence) this.snapshot.set(snapshot);
    } catch {
      /* A revoked credential cannot read history; keep the supplied reason. */
    }
    this.end(reason);
    if (leave && !this.disposed)
      void this.api.command({ commandId: crypto.randomUUID(), type: 'leave' }).catch(() => {});
  }
  private event = (event: RoomEvent, live: boolean) => {
    if (live && this.media.preferences.get().notificationSounds && !this.ended.get()) {
      if (event.type === 'screen.started') this.sounds.play('start', event.eventId);
      if (event.type === 'screen.first_viewer') this.sounds.play('viewer', event.eventId);
    }
    if (event.type === 'files.changed') this.fileRevision.update((n) => n + 1);
    void this.refresh();
  };
  async refresh() {
    if (this.disposed || this.ended.get()) return;
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      this.accept(await this.api.snapshot());
    } catch (error) {
      if (error instanceof ApiError && [403, 404, 410].includes(error.status)) this.end(error.message);
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
  openStream(participantId: string) {
    const person = this.snapshot.get().participants.find((p) => p.id === participantId);
    if (!person?.screen || !person.screenId) return;
    const screenId = person.screenId;
    const revision = ++this.viewRevision;
    this.viewing.set({ screenId, participantId });
    this.pinnedCamera.set(null);
    this.media.watchScreen(participantId);
    this.viewChange = this.viewChange
      .catch(() => {})
      .then(async () => {
        if (revision !== this.viewRevision || this.disposed) return;
        await this.command('view.open', undefined, screenId);
      })
      .catch((error) => {
        if (revision === this.viewRevision) {
          this.returnToConversation();
          this.media.report(error);
        }
      });
  }
  returnToConversation() {
    const old = this.viewing.get();
    this.viewRevision++;
    this.viewing.set(null);
    this.pinnedCamera.set(null);
    this.media.watchScreen(null);
    if (old)
      this.viewChange = this.viewChange
        .catch(() => {})
        .then(() => (this.disposed ? undefined : this.command('view.close', undefined, old.screenId)))
        .catch(() => {});
  }
  screenPlaying(screenId: string) {
    if (this.played.has(screenId) || this.viewing.get()?.screenId !== screenId) return;
    this.played.add(screenId);
    this.viewChange = this.viewChange
      .catch(() => {})
      .then(async () => {
        if (this.disposed || this.viewing.get()?.screenId !== screenId) return;
        await this.command('view.playing', undefined, screenId);
      })
      .catch(() => this.played.delete(screenId));
  }
  pinCamera(participantId: string) {
    this.returnToConversation();
    this.pinnedCamera.set(participantId);
  }
  async leave() {
    rememberMeeting({ ...this.admission, snapshot: this.snapshot.get(), inviteUrl: this.invite.get() });
    this.end('Вы вышли из встречи');
    await this.api.command({ commandId: crypto.randomUUID(), type: 'leave' }).catch(() => {});
  }
  private end(reason: string) {
    if (this.disposed || (this.ended.get() && !this.snapshot.get().closedAt)) return;
    if (this.snapshot.get().closedAt) reason = 'Встреча завершена';
    sessionStorage.setItem(`cord:ended:${this.admission.roomId}`, this.admission.participantId);
    this.sounds.dispose();
    this.media.dispose();
    this.ended.set(reason);
    clearInterval(this.syncTimer);
    void this.uploader.pause();
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.syncTimer);
    window.removeEventListener('online', this.refreshOnReturn);
    document.removeEventListener('visibilitychange', this.refreshOnReturn);
    this.control.dispose();
    this.sounds.dispose();
    this.media.dispose();
    this.subscriptions.forEach((fn) => fn());
    void this.uploader.pause();
  }
}
