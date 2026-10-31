import { ConnectionQuality } from 'livekit-client';
import type { Admission, Command, RoomEvent, Snapshot } from '../api/types';
import { ApiError, RoomApi } from '../api/client';
import { MediaSession, type DeviceChoice } from '../media/session';
import { decodableCodecs, decodesOption, parseDecodes } from '../media/decode-caps';
import { currentPlatform } from '../media/platform';
import { ControlChannel } from './control';
import { Store } from './store';
import { Uploader } from './uploader';
import { rememberMeeting } from './recent';
import { NotificationSounds, type Cue } from './sounds';
import { RoomCues } from './room-cues';
import { readPreferences } from './preferences';
import { volumeKey } from './volumes';
import type { CinemaAt } from './cinema/types';
import type { WatchProvider } from './watch';
import { allowed } from './permissions';
import { knownProvider } from './cinema/link';
import { awayAfter, newFilm, stageOccupant, type StageKind, type StageOccupant } from './stage-view';
import type { LatencyStats } from './board/latency';
import {
  DesktopNotifier,
  readWindowState,
  watchWindowState,
  type NotifyContext,
  type WindowState,
} from './desktop-notify';
import { t } from '../i18n';

/** Сколько помнится замер часов: за десять минут даже неподведённые часы уходят на десятки мс. */
const CLOCK_MEMORY = 10 * 60_000;
/** Столько замеров держится: хватает на любой разумный поток событий комнаты за это время. */
const CLOCK_SAMPLES = 32;
/** Скачок своих часов (сон, синхронизация времени), после которого прежние замеры неверны. */
const CLOCK_JUMP = 1000;

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
  /**
   * На какой странице открыть сцену площадки: ссылка, вставленная где угодно в кинозале, ведёт
   * сразу на ролик, канал, плейлист или сериал (`CinemaAt`), а не на витрину. Каждое открытие по
   * ссылке — новый объект, даже для той же страницы: сцена кладёт страницу в стопку по смене, а
   * вставить ту же ссылку ещё раз — тоже просьба её открыть.
   */
  readonly cinemaAt = new Store<CinemaAt | null>(null);
  /**
   * От какой интеграции этот человек ушёл к участникам (R121), или `null` — смотрит то, что на сцене.
   *
   * Своё у каждого, как каталог: интеграция идёт для всех, а кто-то хочет посмотреть на людей — камеры
   * блоками, чужие показы экрана. Комната об этом не знает. Уход привязан к интеграции: кончилась она или
   * её сменила другая — уход забыт (`core/stage-view.ts`), и новая открывается у всех.
   */
  readonly stageAway = new Store<StageKind | null>(null);
  /** Что занимало сцену при прошлой проверке ухода — чтобы отличить новую интеграцию от той же. */
  private stageBefore: StageOccupant | null = null;
  /**
   * Файл, который открыть на доске (R154): «Открыть на доске» у вложения `.cord-board` в чате кладёт его
   * сюда, а доска забирает, когда она на сцене, — и спрашивает, заменить доску или добавить.
   */
  readonly boardImport = new Store<File | null>(null);
  /** Задержка доски у этого участника, p50/p95 (R159), — для «Диагностики»; без доски — `null`. */
  readonly boardLatency = new Store<LatencyStats | null>(null);
  /**
   * Недописанное сообщение чата.
   *
   * Живёт у встречи, а не у панели: панель закрывается и сама — кинозал, открытый своим
   * нажатием, убирает её со сцены, — а вместе с панелью пропадала бы и разметка с набранным
   * текстом. Здесь текст ждёт, пока чат откроют снова, и уходит вместе со встречей.
   */
  readonly draft = new Store('');
  /**
   * Открыта ли панель чата (её открывает экран встречи) и видит ли человек окно. По ним считаются
   * непрочитанные (R87) и решается, слать ли уведомление Windows (R59): смотрящему в открытый чат
   * не о чем напоминать.
   */
  readonly chatOpen = new Store(false);
  readonly windowState = new Store<WindowState>(readWindowState());
  /** Чужие сообщения, пришедшие, пока чат был закрыт или окно не в фокусе: красный кружок на «Чате». */
  readonly unread = new Store(0);
  readonly notifier = new DesktopNotifier(t);
  private viewChange: Promise<unknown> = Promise.resolve();
  private viewRevision = 0;
  private played = new Set<string>();
  private sounds = new NotificationSounds();
  /** Кто приходит и уходит — по разнице снимков, только люди (`core/room-cues.ts`, T38). */
  private cues: RoomCues;
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
  /** Итог звонка уже ушёл: он один на вход, что бы ни закончило звонок первым. */
  private reported = false;
  private initialDevicesApplied = false;
  private syncTimer?: ReturnType<typeof setInterval>;
  private subscriptions: (() => void)[] = [];
  constructor(
    readonly admission: Admission,
    private choices: DeviceChoice & { micOn?: boolean; cameraOn?: boolean } = {},
  ) {
    this.api = new RoomApi(admission);
    this.snapshot = new Store(admission.snapshot);
    this.cues = new RoomCues(admission.participantId);
    this.invite = new Store(admission.inviteUrl);
    this.media = new MediaSession(this.api, (reason) => {
      void this.resolveEnd(reason, true);
    });
    // Сводка приёма раз в 10 с — в метры ядра; отказ ядра (предел, обновление) ничего не меняет.
    this.media.onRxQuality = (summary) => void this.api.quality(summary).catch(() => {});
    this.control = new ControlChannel(this.api, this.accept, this.event, this.resolveRevocation);
    this.control.onPreview = (participantId, image) => this.media.acceptPreview(participantId, image);
    this.uploader = new Uploader(this.api, () => this.fileRevision.update((n) => n + 1));
    if (sessionStorage.getItem(`cord:ended:${admission.roomId}`) === admission.participantId)
      this.ended.set(t(($) => $.meeting.end.session));
  }
  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    this.sounds.start();
    this.control.start();
    // Everyone already here is not an arrival. The roster starts as what the room looks like
    // at this moment, and the only cue for opening it is the one about you.
    this.cues.seed(this.snapshot.get().participants);
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
    window.addEventListener('pagehide', this.report);
    document.addEventListener('visibilitychange', this.refreshOnReturn);
    this.subscriptions.push(
      watchWindowState((state) => this.windowState.set(state)),
      this.windowState.subscribe(this.attend),
      this.chatOpen.subscribe(this.attend),
      // «Звук встречи» (R156): остальные видят наушники — ядро узнаёт о каждом переключении.
      this.media.deafened.subscribe(this.tellDeafened),
      // Показ, который мы смотрим, снят с публикации — просмотр закрывается сразу, не по снимку (R81).
      this.media.screenGone.subscribe(() => {
        const gone = this.media.screenGone.get();
        if (!gone || gone.seq === this.screenGoneSeen) return;
        this.screenGoneSeen = gone.seq;
        if (this.viewing.get()?.participantId === gone.identity) this.stopViewing();
      }),
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
          // Звук встречи выключен с прошлого раза (R156): микрофон ждёт, пока звук включат, а
          // остальные сразу видят наушники.
          if (this.media.deafened.get()) this.tellDeafened();
          if (this.choices.micOn && this.media.deafened.get()) this.media.holdMicrophoneUntilHeard(true);
          if (this.choices.micOn && !this.media.deafened.get())
            void this.media.toggle('microphone', this.choices.microphone, false);
          // Телефон: микрофон захватывается и выключенным — иначе разговор в фоне не держит ничто
          // (W5, E12). На ПК `holdMicrophone` ничего не делает.
          else void this.media.holdMicrophone(this.choices.microphone);
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
    const cues = this.cues.next(snapshot.participants);
    // A room that has just closed empties in one step. That is one ending, not ten departures.
    if (!this.started || this.ended.get() || snapshot.closedAt) return;
    for (const cue of cues) this.cue(cue);
    // Сторожевая запись: почему прозвучал каждый звук — чтобы «звуки сами по себе» разбирались
    // по журналу клиента, а не по памяти.
    if (!cues.length) return;
    const records = this.cues.journal.slice(-cues.length);
    console.info('[cord] звуки комнаты', records);
    // Те же события — уведомлением Windows, если человек на Cord не смотрит (R59).
    const name = (id: string) => snapshot.participants.find((p) => p.id === id)?.name ?? '';
    const joined = records
      .filter((record) => record.cue === 'join')
      .map((record) => name(record.participantId));
    if (joined.length) this.notifier.notify({ kind: 'join', names: joined }, () => this.notifyContext());
    const knock = records.filter((record) => record.cue === 'knock').at(-1);
    if (knock)
      this.notifier.notify(
        {
          kind: 'knock',
          name: name(knock.participantId),
          participantId: knock.participantId,
          waiting: snapshot.participants.filter((p) => p.status === 'WAITING').length,
        },
        this.notifyContext(snapshot),
      );
  }
  /** Что знает уведомление о встрече и о человеке — в момент отправки. */
  private notifyContext(snapshot = this.snapshot.get()): NotifyContext {
    const self = this.admission.participantId;
    return {
      ...this.windowState.get(),
      roomId: this.admission.roomId,
      title: snapshot.title,
      chatOpen: this.chatOpen.get(),
      selfName: snapshot.participants.find((p) => p.id === self)?.name ?? '',
      canApprove: allowed(snapshot, self, 'participant.approve'),
    };
  }
  /** Человек смотрит в открытый чат — всё прочитано. Значка на иконке панели задач нет (R138). */
  private attend = () => {
    const { focused, visible } = this.windowState.get();
    if (this.chatOpen.get() && focused && visible) this.unread.set(0);
  };
  /**
   * Нажатие в уведомлении Windows (`notification.action {id, tag}`): «Впустить» и «Отклонить» —
   * тому, кто просился последним; ответ — какую панель открыть. Чужая встреча (`tag` другой
   * комнаты, оставшийся в центре уведомлений) — `null`.
   */
  handleNotificationAction(id: string, tag: string): 'chat' | 'people' | null {
    const prefix = `room:${this.admission.roomId}:`;
    if (!tag.startsWith(prefix) || this.ended.get()) return null;
    const kind = tag.slice(prefix.length);
    if (kind === 'knock') {
      const target = this.notifier.lastKnock;
      if (target && (id === 'admit' || id === 'deny'))
        void this.command(
          id === 'admit' ? 'participant.approve' : 'participant.remove',
          undefined,
          target,
        ).catch((error) => this.media.report(error));
      return 'people';
    }
    return kind === 'message' ? 'chat' : null;
  }
  private screenGoneSeen = 0;
  /** Просмотр чужого показа кончился — по снимку ядра или по дорожке SFU (R81), что раньше. */
  private stopViewing() {
    if (!this.viewing.get()) return;
    this.viewRevision++;
    this.viewing.set(null);
    this.media.watchScreen(null);
  }
  private accept = (snapshot: Snapshot, roundTrip?: number) => {
    if (this.disposed) return;
    this.tellTime(snapshot.serverTime, roundTrip);
    if (snapshot.sequence < this.snapshot.get().sequence) return;
    this.listen(snapshot);
    this.snapshot.set(snapshot);
    this.settleStage();
    // Музыкальный бот публикует свой трек как обычный микрофон — иначе комната не услышала
    // бы стерео. Значит, отличить музыку от речи по самой дорожке нельзя, и единственный,
    // кто знает состав служебных участников, — ядро. Медиа узнаёт это отсюда, чтобы дать
    // музыке право отстать на секунду, а разговору — нет.
    this.media.setServiceParticipants(
      snapshot.participants.filter((person) => person.service).map((person) => person.id),
    );
    // Зрители своей камеры и показа — люди на связи, кроме себя; у кого `decodes` нет, тот ещё не
    // сообщил (его прикроет запасной кодек).
    this.media.setViewerDecodes(
      snapshot.participants
        .filter(
          (person) =>
            person.id !== this.admission.participantId &&
            !person.service &&
            ['JOINING', 'CONNECTED', 'RECOVERING'].includes(person.status),
        )
        .map((person) => parseDecodes(person.decodes)),
    );
    // Громкость принадлежит встрече, а не сессии: вернувшегося и заново добавленную музыку
    // слышно так же, как их попросили звучать в прошлый раз. См. `core/volumes.ts`.
    this.media.rememberPeople(
      this.admission.roomId,
      snapshot.participants.map((person) => ({ id: person.id, key: volumeKey(person) })),
    );
    const viewing = this.viewing.get();
    if (viewing && !snapshot.participants.some((p) => p.screenId === viewing.screenId && p.screen))
      this.stopViewing();
    if (!snapshot.participants.some((p) => p.id === this.pinnedCamera.get())) this.pinnedCamera.set(null);
    if (snapshot.closedAt) {
      this.end(t(($) => $.meeting.end.closed));
      return;
    }
    if (this.ended.get()) return;
    const self = snapshot.participants.find((p) => p.id === this.admission.participantId);
    if (!self) {
      this.end(t(($) => $.meeting.end.left));
      return;
    }
    this.reportDecodes(self);
    if (
      ['JOINING', 'CONNECTED', 'RECOVERING'].includes(self.status) &&
      this.media.state.get().status === 'idle'
    )
      void this.media.start();
  };
  /** Набор кодеков уже ушёл (или ушёл бы) в этот вход — один раз на вход. */
  private decodesReported = false;
  /**
   * Что декодирует этот браузер — чтобы издатели не брали кодек, которого он не покажет (R152). Один
   * раз, когда вход допущен к медиа (ожидающему у двери ядро команду не примет), и только если ядро
   * набора ещё не знает. Старое ядро команды не знает — отказ ничего не меняет: прикроет запасной кодек.
   */
  private reportDecodes(self: Snapshot['participants'][number]) {
    if (this.decodesReported || self.decodes || !['JOINING', 'CONNECTED', 'RECOVERING'].includes(self.status))
      return;
    this.decodesReported = true;
    void decodableCodecs(currentPlatform().mobile)
      .then((codecs) =>
        codecs.length
          ? this.command('media.decode', undefined, undefined, { option: decodesOption(codecs) })
          : null,
      )
      .catch(() => {});
  }
  private resolveRevocation = () => {
    void this.resolveEnd(t(($) => $.meeting.end.revoked));
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
      ) {
        this.cue('message', event.eventId);
        const { focused, visible } = this.windowState.get();
        if (!(this.chatOpen.get() && focused && visible)) this.unread.update((n) => n + 1);
        const { name, text } = event.payload.message;
        this.notifier.notify({ kind: 'message', name, text }, this.notifyContext());
      }
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
      // Время ответа — по монотонным часам: скачок обычных посреди запроса дал бы ответ длиной
      // в час или отрицательный.
      const asked = performance.now();
      const snapshot = await this.api.snapshot();
      this.accept(snapshot, performance.now() - asked);
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
   *
   * ПОЧЕМУ БЫСТРЕЙШИЙ ИЗ НЕДАВНИХ, А НЕ ПОСЛЕДНИЙ. Половина времени ответа верна, только если
   * дорога туда и обратно одинакова. А снимок спрашивают как раз в момент нажатия — когда плееры
   * тянут кусочки видео, и ответ стоит в очереди за ними: у застрявшего ответа почти вся задержка
   * на обратном пути, и поправка ошибается на её половину (полторы секунды в очереди — три
   * четверти секунды у этого зрителя). Ошибка замера не больше половины его же времени ответа,
   * поэтому из замеров последних {@link CLOCK_MEMORY} верен самый быстрый.
   *
   * ЧАСЫ УСТРОЙСТВА ПРЫГАЮТ. Сон ноутбука и синхронизация времени двигают `Date.now()` скачком,
   * и прежние замеры становятся неверны ровно на этот скачок. Монотонные часы (`performance.now()`)
   * его не делают — по их расхождению с обычными скачок и виден: больше {@link CLOCK_JUMP} — старые
   * замеры забываются, и верен следующий ответ, каким бы медленным он ни был.
   */
  private clockOffset = 0;
  private clockMeasured = false;
  private clockSamples: { offset: number; roundTrip: number; at: number; base: number }[] = [];
  private tellTime(serverTime: number, roundTrip?: number) {
    const now = Date.now();
    if (roundTrip === undefined) {
      if (!this.clockMeasured) this.clockOffset = serverTime - now;
      return;
    }
    const base = now - performance.now();
    const trip = Math.min(roundTrip, 2000);
    this.clockSamples = [
      ...this.clockSamples.filter(
        (sample) => Math.abs(sample.base - base) < CLOCK_JUMP && now - sample.at < CLOCK_MEMORY,
      ),
      { offset: serverTime + trip / 2 - now, roundTrip: trip, at: now, base },
    ].slice(-CLOCK_SAMPLES);
    // Равный по скорости — свежий: он ближе к тому, как часы идут сейчас.
    const best = this.clockSamples.reduce((found, sample) =>
      sample.roundTrip <= found.roundTrip ? sample : found,
    );
    this.clockMeasured = true;
    this.clockOffset = best.offset;
  }
  serverNow(): number {
    return Date.now() + this.clockOffset;
  }
  async command(
    type: Command['type'],
    text?: string,
    targetId?: string,
    /**
     * Уточнения к команде: что открыть и с какого места у просмотра, какое место и сколько
     * фишек у игры. Конверт один на все типы — заводить второй ради каждой новой интеграции
     * значило бы переписывать канал команд на каждую из них.
     */
    extra?: Pick<
      Command,
      'provider' | 'kind' | 'contentId' | 'positionMs' | 'option' | 'seat' | 'chips' | 'card' | 'under'
    >,
  ) {
    const ack = await this.control.command({
      commandId: crypto.randomUUID(),
      type,
      text,
      targetId,
      ...extra,
    });
    if (type === 'invite.create' && ack.value) this.invite.set(ack.value);
    if (type === 'invite.revoke') this.invite.set(null);
    await this.refresh();
    if (!this.disposed && type !== 'gartic.draw')
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
    // Чужой экран открыт во всю сцену — это вид участников (R121): закрыли его — сетка, а не интеграция.
    this.stageAway.set(this.stageOccupant()?.kind ?? null);
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
    this.closeViewing();
    this.pinnedCamera.set(null);
  }
  /** Закрыть чужой экран, открытый во всю сцену, — и сказать ядру, что смотреть его перестали. */
  private closeViewing() {
    const old = this.viewing.get();
    this.viewRevision++;
    this.viewing.set(null);
    this.media.watchScreen(null);
    if (old)
      this.viewChange = this.viewChange
        .catch(() => {})
        .then(() => (this.disposed ? undefined : this.command('view.close', undefined, old.screenId)))
        .catch(() => {});
  }
  /** Что сейчас занимает сцену: интеграция комнаты или свой открытый каталог кинозала. */
  stageOccupant(): StageOccupant | null {
    const catalog = this.cinema.get();
    return stageOccupant(this.snapshot.get(), !!catalog && knownProvider(catalog));
  }
  /**
   * Уйти из интеграции к участникам (R121) — у себя: интеграция идёт для всех, фильм звучит дальше.
   * Сцена свободна — уходить не от чего.
   */
  leaveStage() {
    const occupant = this.stageOccupant();
    if (occupant) this.stageAway.set(occupant.kind);
  }
  /** Вернуться в интеграцию (чёлка, «Открыть на сцене»): чужой экран закрывается, закрепление остаётся. */
  returnToStage() {
    this.stageAway.set(null);
    if (this.viewing.get()) this.closeViewing();
  }
  /** Сцена сменилась — уход помнится, только пока на ней та же интеграция (`awayAfter`). */
  private settleStage() {
    const after = this.stageOccupant();
    this.stageAway.set(awayAfter(this.stageAway.get(), this.stageBefore, after));
    // Новый фильм открывается у всех (R150, Р-42): и у того, кто смотрел чужой показ, — кроме того,
    // кто сам сейчас показывает экран (он на сцене, его показ смотрят другие). Чужой показ остаётся
    // доступен чёлкой и плиткой.
    if (newFilm(this.stageBefore, after) && this.viewing.get() && !this.media.state.get().screen)
      this.closeViewing();
    this.stageBefore = after;
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
  /**
   * Закрепить камеру — свою или чужую (R83): у себя, крупной плиткой над лентой остальных, как в
   * Discord. Комната об этом не знает. Чужой экран, открытый во всю сцену, закрывается: сцена одна.
   */
  pinCamera(participantId: string) {
    this.returnToConversation();
    this.pinnedCamera.set(participantId);
    // Закрепить при занятой сцене — значит смотреть людей: закреплённый крупно бывает только в их виде (R121).
    this.stageAway.set(this.stageOccupant()?.kind ?? null);
  }
  /** Открепить — вернуть сетку (или «Говорящего»), не трогая ничего другого. */
  unpinCamera() {
    this.pinnedCamera.set(null);
  }
  /**
   * Открыть или закрыть каталог кинотеатра. Чужую демонстрацию он закрывает: сцена одна, и
   * «я листаю каталог поверх чужого экрана» — это не два дела сразу, а потерянный экран.
   */
  openCinema(provider: WatchProvider | null, at?: CinemaAt) {
    if (provider) this.returnToConversation();
    // Страница — раньше площадки: сцена, которую откроет смена площадки, должна увидеть её сразу.
    this.cinemaAt.set(provider && at ? at : null);
    this.cinema.set(provider);
    // Каталог открывают, чтобы его видеть: ушедший к участникам возвращается в кинозал (R121).
    if (provider) this.stageAway.set(null);
    this.settleStage();
  }
  private tellDeafened = () => {
    if (this.disposed) return;
    void this.command('self.deafen', String(this.media.deafened.get())).catch(() => {
      /* Ядро без R156 команды не знает — наушники просто не видны остальным. */
    });
  };
  async leave() {
    rememberMeeting({ ...this.admission, snapshot: this.snapshot.get(), inviteUrl: this.invite.get() });
    this.end(t(($) => $.meeting.end.left));
    await this.api.command({ commandId: crypto.randomUUID(), type: 'leave' }).catch(() => {});
    // Closing the application with a meeting open should sound like leaving first and closing
    // second. The host waits for this call to return before it takes the window down.
    await this.sounds.settled();
  }
  private end(reason: string) {
    if (this.disposed || (this.ended.get() && !this.snapshot.get().closedAt)) return;
    if (this.snapshot.get().closedAt) reason = t(($) => $.meeting.end.closed);
    sessionStorage.setItem(`cord:ended:${this.admission.roomId}`, this.admission.participantId);
    this.cinemaAt.set(null);
    this.cinema.set(null);
    this.cue('self-leave');
    this.sounds.dispose();
    this.notifier.dispose();
    this.report();
    this.media.dispose();
    this.ended.set(reason);
    clearInterval(this.syncTimer);
    void this.uploader.pause();
  }
  /**
   * Итог звонка — владельцу сервера, один раз: при конце встречи, уходе со страницы или закрытии вкладки
   * (`pagehide`). Короткий заход итога не даёт (`CallQuality.summary`).
   */
  private report = () => {
    if (this.reported) return;
    const summary = this.media.callReport();
    if (!summary) return;
    this.reported = true;
    void this.api.clientReport(summary).catch(() => {});
  };
  dispose() {
    this.report();
    this.disposed = true;
    clearInterval(this.syncTimer);
    window.removeEventListener('online', this.refreshOnReturn);
    window.removeEventListener('pagehide', this.report);
    document.removeEventListener('visibilitychange', this.refreshOnReturn);
    this.control.dispose();
    this.sounds.dispose();
    this.notifier.dispose();
    this.media.dispose();
    this.subscriptions.forEach((fn) => fn());
    void this.uploader.pause();
  }
}
