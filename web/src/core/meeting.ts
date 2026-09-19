import { ConnectionQuality } from 'livekit-client';
import type { Admission, Command, Participant, RoomEvent, Snapshot } from '../api/types';
import { ApiError, RoomApi } from '../api/client';
import { MediaSession, type DeviceChoice } from '../media/session';
import { ControlChannel } from './control';
import { Store } from './store';
import { Uploader } from './uploader';
import { rememberMeeting } from './recent';
import { NotificationSounds, type Cue } from './sounds';
import { readPreferences } from './preferences';
import type { WatchProvider } from './watch';

const PRESENT: Participant['status'][] = ['JOINING', 'CONNECTED', 'RECOVERING'];

export class Meeting {
  readonly api: RoomApi;
  readonly snapshot: Store<Snapshot>;
  readonly viewing = new Store<{ screenId: string; participantId: string } | null>(null);
  readonly pinnedCamera = new Store<string | null>(null);
  /**
   * Какую площадку этот человек сейчас разглядывает в кинотеатре, или `null`.
   *
   * Своё у каждого, а не общее для комнаты: выбирать, что поставить, ходят по каталогу — и
   * водить по чужому каталогу всех сразу значит отобрать экран у тех, кто просто смотрит кино.
   * Комната узнаёт об этом только в момент «включить», и это обычная команда.
   */
  readonly cinema = new Store<WatchProvider | null>(null);
  private viewChange: Promise<unknown> = Promise.resolve();
  private viewRevision = 0;
  private played = new Set<string>();
  private sounds = new NotificationSounds();
  /** Who was in the room the last time we looked, so arrivals and departures can be heard. */
  private roster = new Map<string, Participant['status']>();
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
    // Everyone already here is not an arrival. The roster starts as what the room looks like
    // at this moment, and the only cue for opening it is the one about you.
    this.roster = new Map(this.snapshot.get().participants.map((p) => [p.id, p.status]));
    this.cue('self-join');
    this.accept(this.snapshot.get());
    // The picture belongs to this device, so each room has to be told about it once. A room
    // that rejects it is not worth interrupting the join for: бюджет картинки здесь и в ядре
    // один и тот же, поэтому отказ означает испорченную запись, а не обычную картинку —
    // прерывать ради неё вход не стоит, а менять её всё равно идут в настройки.
    const avatar = readPreferences().avatar;
    if (avatar) void this.command('profile.avatar', avatar).catch(() => {});
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
          // Без сигнала: человек включил микрофон ещё на предпросмотре, а услышал только что
          // собственный вход — два звука подряд об одном и том же событии.
          if (this.choices.micOn) void this.media.toggle('microphone', this.choices.microphone, false);
          if (this.choices.cameraOn) void this.media.toggle('camera', this.choices.camera);
        }
      }),
    );
  }
  private refreshOnReturn = () => {
    if (!document.hidden) void this.refresh();
  };
  /** A cue is played only if the room is still ours and this device asked to hear them. */
  private cue(kind: Cue, eventId?: string) {
    if (this.disposed || !this.media.preferences.get().notificationSounds) return;
    this.sounds.play(kind, eventId);
  }
  /**
   * Turns two snapshots into the three things worth hearing: someone arrived, someone left,
   * someone is asking to be let in. The room has no event for any of them — `room.changed`
   * only says the room is different — so the difference has to be read here.
   *
   * Your own arrival and departure are announced where they happen, not from this list, so
   * that leaving is heard once even when the snapshot confirming it never comes.
   */
  private listen(snapshot: Snapshot) {
    const previous = this.roster;
    this.roster = new Map(snapshot.participants.map((p) => [p.id, p.status]));
    // A room that has just closed empties in one step. That is one ending, not ten departures.
    if (!this.started || this.ended.get() || snapshot.closedAt) return;
    const present = (status?: Participant['status']) => !!status && PRESENT.includes(status);
    for (const person of snapshot.participants) {
      if (person.id === this.admission.participantId) continue;
      const before = previous.get(person.id);
      if (person.status === 'WAITING' && before !== 'WAITING') this.cue('knock');
      else if (present(person.status) && !present(before)) this.cue('join');
    }
    for (const [id, status] of previous) {
      if (id === this.admission.participantId || !present(status)) continue;
      if (!present(this.roster.get(id))) this.cue('leave');
    }
  }
  private accept = (snapshot: Snapshot, roundTrip?: number) => {
    if (this.disposed) return;
    this.tellTime(snapshot.serverTime, roundTrip);
    if (snapshot.sequence < this.snapshot.get().sequence) return;
    this.listen(snapshot);
    this.snapshot.set(snapshot);
    // Музыкальный бот публикует свой трек как обычный микрофон — иначе комната не услышала
    // бы стерео. Значит, отличить музыку от речи по самой дорожке нельзя, и единственный,
    // кто знает состав служебных участников, — ядро. Медиа узнаёт это отсюда, чтобы дать
    // музыке право отстать на секунду, а разговору — нет.
    this.media.setServiceParticipants(
      snapshot.participants.filter((person) => person.service).map((person) => person.id),
    );
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
    if (live && !this.ended.get()) {
      if (event.type === 'screen.started') this.cue('screen', event.eventId);
      // Своё сообщение слышно как нажатие «отправить»; звучать оно должно только у других.
      // Панель чата открыта не всегда, а сообщение — это обращение к комнате: без звука его
      // замечали только те, кто в этот момент смотрел в правую колонку.
      if (
        event.type === 'message.created' &&
        event.payload.message &&
        event.payload.message.participantId !== this.admission.participantId
      )
        this.cue('message', event.eventId);
      // The room hears a screen start; only the person sharing hears that somebody came to
      // watch it. Everyone else getting that cue would be telling them about a stranger
      // arriving at a stream they are not running.
      if (
        event.type === 'screen.first_viewer' &&
        event.payload.participantId === this.admission.participantId
      )
        this.cue('viewer', event.eventId);
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
      const asked = Date.now();
      const snapshot = await this.api.snapshot();
      this.accept(snapshot, Date.now() - asked);
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
  /**
   * Который час на сервере.
   *
   * Совместный просмотр держится на общей точке отсчёта: позиция ролика верна в момент по
   * часам **сервера**, а часы участников расходятся на минуты. Поправка берётся из каждого
   * снимка — он и так приходит на любое изменение комнаты, и своей записи для этого не нужно.
   *
   * ПОЧЕМУ ПОЛОВИНА ВРЕМЕНИ ОТВЕТА. `serverTime` был верен, когда сервер отвечал, — то есть
   * примерно на середине запроса, а не в момент его получения. Без этой поправки чужие часы
   * оказываются позади своих ровно на задержку сети, и двое с разной связью расходятся на
   * разницу своих задержек: у кого-то полсекунды, и это уже слышно. Поправка меряется только
   * там, где время запроса известно; снимок, пришедший каналом событий, часы не двигает — про
   * его дорогу мы не знаем ничего.
   */
  private clockOffset = 0;
  private clockMeasured = false;
  private tellTime(serverTime: number, roundTrip?: number) {
    if (roundTrip === undefined) {
      if (!this.clockMeasured) this.clockOffset = serverTime - Date.now();
      return;
    }
    this.clockMeasured = true;
    this.clockOffset = serverTime + Math.min(roundTrip, 2000) / 2 - Date.now();
  }
  serverNow(): number {
    return Date.now() + this.clockOffset;
  }
  async command(
    type: Command['type'],
    text?: string,
    targetId?: string,
    /** Поля совместного просмотра: что открыть и с какого места. */
    watch?: Pick<Command, 'provider' | 'kind' | 'contentId' | 'positionMs'>,
  ) {
    const ack = await this.control.command({
      commandId: crypto.randomUUID(),
      type,
      text,
      targetId,
      ...watch,
    });
    if (type === 'invite.create' && ack.value) this.invite.set(ack.value);
    if (type === 'invite.revoke') this.invite.set(null);
    await this.refresh();
    if (!this.disposed)
      rememberMeeting({ ...this.admission, snapshot: this.snapshot.get(), inviteUrl: this.invite.get() });
    return ack;
  }
  openStream(participantId: string) {
    // Никто не смотрит собственную демонстрацию: `watchScreen` управляет только чужими
    // подписками, поэтому сюда попадала бы своя локальная дорожка — тот же экран, на котором
    // всё и происходит, с задержкой и без возможности выйти обратно естественным путём.
    if (participantId === this.admission.participantId) return;
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
  /**
   * Открыть или закрыть каталог кинотеатра. Чужую демонстрацию он закрывает: сцена одна, и
   * «я листаю каталог поверх чужого экрана» — это не два дела сразу, а потерянный экран.
   */
  openCinema(provider: WatchProvider | null) {
    if (provider) this.returnToConversation();
    this.cinema.set(provider);
  }
  async leave() {
    rememberMeeting({ ...this.admission, snapshot: this.snapshot.get(), inviteUrl: this.invite.get() });
    this.end('Вы вышли из встречи');
    await this.api.command({ commandId: crypto.randomUUID(), type: 'leave' }).catch(() => {});
    // Closing the application with a meeting open should sound like leaving first and closing
    // second. The host waits for this call to return before it takes the window down.
    await this.sounds.settled();
  }
  private end(reason: string) {
    if (this.disposed || (this.ended.get() && !this.snapshot.get().closedAt)) return;
    if (this.snapshot.get().closedAt) reason = 'Встреча завершена';
    sessionStorage.setItem(`cord:ended:${this.admission.roomId}`, this.admission.participantId);
    this.cinema.set(null);
    this.cue('self-leave');
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
