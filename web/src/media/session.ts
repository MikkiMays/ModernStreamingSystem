import {
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  type RemoteTrack,
  type RemoteTrackPublication,
  LocalVideoTrack,
  LocalAudioTrack,
  RemoteVideoTrack,
  ConnectionQuality,
  DisconnectReason,
  type Participant,
  type LocalTrack,
  type VideoCodec,
} from 'livekit-client';
import { ApiError, type RoomApi } from '../api/client';
import { Store } from '../core/store';
import { RecoveryWindow } from '../core/recovery';
import {
  chooseCodec,
  chooseCameraCodec,
  cameraHint,
  fitSource,
  screenOptions,
  cameraCapture,
  cameraOptions,
  forcedCameraConstraints,
  companionCamera,
  companionCameraCapture,
  companionCameraOptions,
  type ScreenProfile,
} from './profiles';
import { rememberLayout, retune } from './retune';
import { UpstreamBudget, type CameraRole, type UpstreamChange } from './upstream';
import {
  readPreferences,
  savePreferences,
  type AudioPreferences,
  type Preferences,
  type Reception,
} from '../core/preferences';
import { signal } from '../core/sounds';
import { recallVolume, rememberVolume } from '../core/volumes';
import { audioCapture, CordAudioProcessor, microphoneOptions, needsAudioProcessor } from './audio';
import { browserCapture, ownAudioLeaks, type CaptureAdapter } from './capture';
import { EncoderHealth } from './encoder-health';
import { LiveHealth } from './live-health';
import { linkChanged, unknownLink, type LinkState } from './link-quality';
import type { PlayoutClass } from './playout';
import { PlayoutController, type PlayoutTrack } from './playout-control';
import { waitForPublishPermissions } from './publish-permissions';
import { PreviewImages, ScreenPreviewSource, PREVIEW_TOPIC } from './screen-preview';

export interface MediaTile {
  id: string;
  participantId: string;
  name: string;
  source: Track.Source;
  track: Track;
  local: boolean;
  muted: boolean;
}
export interface MediaState {
  status: 'idle' | 'connecting' | 'connected' | 'recovering' | 'ended';
  remaining: number;
  microphone: boolean;
  camera: boolean;
  screen: boolean;
  error: string | null;
  quality: ConnectionQuality;
  liveStatus: string | null;
}
export interface DeviceChoice {
  microphone?: string;
  camera?: string;
  speaker?: string;
}
/**
 * Что уходит в сеть на самом деле.
 *
 * Профиль — это просьба, а не факт. Камера, которая не умеет 2560×1440, молча отдаёт
 * 1920×1080; кодировщик, которому тесно, молча роняет частоту. Пока эти числа нигде не
 * показывались, «заявлено 60, идёт 40» невозможно было ни увидеть, ни опровергнуть.
 */
export interface OutboundVideo {
  source: 'camera' | 'screen';
  width: number;
  height: number;
  fps: number;
  /** Мегабиты в секунду по разнице счётчиков за интервал. */
  mbps: number;
  /** `qualityLimitationReason`: почему кодировщик отдаёт меньше, чем его просили. */
  limitation: string;
  /**
   * Какую частоту у этой дорожки просили. Нужна, чтобы отличить «кодировщику тесно» от
   * «источник столько и не даёт»: кодировщик о втором не сообщает ничего — с его точки
   * зрения он успевает за всем, что ему приносят.
   */
  targetFps: number;
  /**
   * Есть ли слой, который опубликован, но сейчас не отправляется.
   *
   * Так выглядит dynacast: пока никто не смотрит крупно, верхний слой спит, и в сеть уходит
   * тот, что помельче. Это не понижение качества — стоит кому-нибудь развернуть плитку, и
   * слой проснётся, — но без этого признака плашка показывала бы 720p при выбранном 1080p
   * и читалась бы как «настройка не применилась».
   */
  dormant: boolean;
}

/**
 * Наблюдатель, который всегда просит у комнаты лучший слой.
 *
 * ЗАЧЕМ ИМЕННО ТАК. Режим «Всегда максимум» — это отключённая адаптация приёма, а она
 * задаётся при создании комнаты, то есть при входе. Переподписка не помогает: дорожка
 * пересоздаётся, но размеры плитки кэшируются на **публикации** и после отписки остаются
 * от последнего измерения — проверено, приём после переключения падал до 360p вместо 720p.
 * Лезть в это поле руками значит держаться за внутренность SDK, которая молча переименуется.
 *
 * Адаптация берёт **наибольший** из наблюдаемых элементов (`updateDimensions`). Значит,
 * ничего выключать не надо: достаточно добавить к настоящей плитке ещё одного наблюдателя,
 * который сообщает заведомо большой размер. Это публичный `observeElementInfo`, переключение
 * мгновенное, и ни комнату, ни подписки трогать не приходится.
 *
 * Видимость остаётся честной: свёрнутая вкладка по-прежнему не тянет чужое видео.
 */
class WideOpen {
  readonly element = {};
  pictureInPicture = false;
  visibilityChangedAt: number | undefined = 0;
  handleResize?: () => void;
  handleVisibilityChanged?: () => void;
  get visible() {
    return typeof document === 'undefined' || !document.hidden;
  }
  // Заведомо больше любого слоя: сервер отдаст самый крупный, какой есть.
  width() {
    return 7680;
  }
  height() {
    return 4320;
  }
  observe() {
    document.addEventListener('visibilitychange', this.changed);
  }
  stopObserving() {
    document.removeEventListener('visibilitychange', this.changed);
  }
  private changed = () => this.handleVisibilityChanged?.();
}

/** This is the only owner of the Room and capture tracks. React only subscribes. */
export class MediaSession {
  readonly preferences = new Store(readPreferences());
  readonly state = new Store<MediaState>({
    status: 'idle',
    remaining: 20,
    microphone: false,
    camera: false,
    screen: false,
    error: null,
    quality: ConnectionQuality.Unknown,
    liveStatus: null,
  });
  readonly tracks = new Store<MediaTile[]>([]);
  readonly volumes = new Store<Record<string, number>>({});
  readonly deafened = new Store(false);
  /** Что мы отдаём прямо сейчас, по измерению, а не по настройке. */
  readonly outbound = new Store<OutboundVideo | null>(null);
  /** Кто сейчас говорит — по данным SFU, а не по громкости, посчитанной в странице. */
  readonly speaking = new Store<string[]>([]);
  /** Последний кадр чужой демонстрации: participantId → ссылка на картинку. */
  readonly screenPreviews = new Store<Record<string, string>>({});
  /** Каким путём идёт медиа и насколько ровно. Для показа и для выбора запаса буфера. */
  readonly link = new Store<LinkState>(unknownLink);
  private previousVolumes = new Map<string, number>();
  /** Номер участника → устойчивый ключ в памяти громкостей. См. `core/volumes.ts`. */
  private volumeKeys = new Map<string, string>();
  private volumeRoom = '';
  private watchedParticipant: string | null = null;
  watchScreen(participantId: string | null) {
    this.watchedParticipant = participantId;
    this.syncSubscriptions();
  }
  private shouldSubscribe(identity: string, source: Track.Source) {
    return (
      ![Track.Source.ScreenShare, Track.Source.ScreenShareAudio].includes(source) ||
      identity === this.watchedParticipant
    );
  }
  private syncSubscriptions = () => {
    for (const participant of this.room.remoteParticipants.values())
      for (const publication of participant.trackPublications.values()) {
        const wanted = this.shouldSubscribe(participant.identity, publication.source);
        if (publication.isDesired !== wanted) publication.setSubscribed(wanted);
      }
  };
  /** Каждая подписанная видеодорожка. */
  private *remoteVideo() {
    for (const participant of this.room.remoteParticipants.values())
      for (const publication of participant.videoTrackPublications.values())
        if (publication.isSubscribed) yield publication;
  }
  /** Держит режим приёма на каждой подписанной дорожке. Вызывается и при смене, и при подписке. */
  private applyReception = () => {
    const wanted = this.preferences.get().reception === 'best';
    for (const publication of this.remoteVideo()) {
      const track = publication.track;
      if (!(track instanceof RemoteVideoTrack)) continue;
      const watcher = this.wideOpen.get(publication.trackSid);
      if (wanted && !watcher) {
        const opened = new WideOpen();
        this.wideOpen.set(publication.trackSid, opened);
        track.observeElementInfo(opened);
      } else if (!wanted && watcher) {
        this.wideOpen.delete(publication.trackSid);
        track.stopObservingElementInfo(watcher);
      }
    }
  };
  /**
   * Сменить режим приёма посреди разговора — сразу, без перезахода во встречу.
   *
   * Раньше выбор приёма был следствием выбора отдачи и доезжал только при следующем входе;
   * в настройках про это честно висела приписка, то есть настройка, которая не работает.
   */
  setReception(reception: Reception) {
    this.preferences.set(savePreferences({ reception }));
    this.applyReception();
  }
  private receivePreview = (payload: Uint8Array, participant?: Participant, _?: unknown, topic?: string) => {
    if (topic !== PREVIEW_TOPIC || !participant || this.disposed || !payload.byteLength) return;
    const url = this.previewImages.accept(participant.identity, payload);
    this.screenPreviews.update((previews) => ({ ...previews, [participant.identity]: url }));
  };
  private dropPreview(participantId: string) {
    if (!this.screenPreviews.get()[participantId]) return;
    this.previewImages.forget(participantId);
    this.screenPreviews.update(({ [participantId]: _, ...rest }) => rest);
  }
  /**
   * Показывать ли комнате, что у нас на экране.
   *
   * Начинается вместе с показом и заканчивается вместе с ним. Настройка выключает именно
   * отправку: смотреть чужие превью можно и не отдавая своего — это разные решения, и
   * запрещать первое из-за второго не за что.
   */
  private syncPreview() {
    const track = this.screenTracks.find((item) => item instanceof LocalVideoTrack);
    if (!(track instanceof LocalVideoTrack)) {
      this.previewSource.stop();
      return;
    }
    this.previewSource.start(track.mediaStreamTrack, (bytes) => {
      if (this.disposed || this.room.state !== 'connected') return;
      void this.room.localParticipant
        .publishData(bytes, { reliable: true, topic: PREVIEW_TOPIC })
        .catch(() => {});
    });
  }
  toggleParticipantMute(id: string) {
    const volume = this.volumes.get()[id] ?? 1;
    if (volume > 0) {
      this.previousVolumes.set(id, volume);
      this.setVolume(id, 0);
    } else this.setVolume(id, this.previousVolumes.get(id) ?? 1);
  }
  private audioChange: Promise<void> = Promise.resolve();
  private wideOpen = new Map<string, WideOpen>();
  readonly recovery: RecoveryWindow;
  readonly room: Room;
  private disposed = false;
  private generation = 0;
  private deadlineTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connecting = false;
  private screenTracks: LocalTrack[] = [];
  private deviceTracks = new Map<Track.Source, LocalTrack>();
  private captureSize = { width: 1920, height: 1080 };
  private profile = this.preferences.get().screen;
  /** Что человек выбрал для камеры. Меняется только им, и только это попадает в настройки. */
  private cameraProfile = this.preferences.get().camera;
  /**
   * Чем камера идёт в сеть прямо сейчас.
   *
   * ЗАЧЕМ ОТДЕЛЬНО ОТ ВЫБОРА. Выбранный уровень — это потолок и обещание, а не гарантия:
   * бывают машины, которым 1080p60 не по силам, и каналы, в которые он не проходит. Пока
   * эти два числа были одним, у такой пары был единственный исход — замерший кадр у всех,
   * кто смотрит, до самого конца разговора. Теперь лестница может временно спуститься ниже
   * выбора и вернуться обратно, а сам выбор остаётся записанным и показанным как выбранный.
   */
  private cameraSending = this.preferences.get().camera;
  private cameraChange: Promise<void> = Promise.resolve();
  private cameraProfilePending = false;
  /**
   * Каким кадром сейчас идёт камера. Рядом с демонстрацией экрана — маленьким: причина и
   * счёт мегабитам в `upstream.ts`. Это не настройка человека, а следствие того, что
   * включено, поэтому и живёт рядом с медиа, а не в предпочтениях.
   */
  private cameraRole: CameraRole = 'full';
  private budget = new UpstreamBudget();
  private codec: VideoCodec = 'vp8';
  /**
   * Кодек камеры. Здесь годами стоял жёсткий VP8, который почти нигде не кодируется железом —
   * отсюда и «заявлено 60 fps, идёт 40». Выбирается один раз на сессию: смена кодека требует
   * переговоров, и делать это по ходу разговора ради одного и того же ответа незачем.
   */
  private cameraCodec: VideoCodec = 'vp8';
  private cameraCodecChosen?: Promise<VideoCodec>;
  private screenBusy = false;
  private screenPublishAbort?: AbortController;
  private deviceBusy = new Set<string>();
  private wanted = { microphone: false, camera: false };
  private connectionCycle = 0;
  private profileChange: Promise<void> = Promise.resolve();
  private mediaReport: Promise<void> = Promise.resolve();
  private refreshQueued = false;
  private fullRetry = 0;
  private qualityTimer?: ReturnType<typeof setInterval>;
  private upstreamSampling = false;
  private upstreamCounters?: { at: number; bytes: number };
  private encoderHealth = new EncoderHealth();
  private screenGeneration = 0;
  private liveTimer?: ReturnType<typeof setInterval>;
  private liveNoticeTimer?: ReturnType<typeof setTimeout>;
  private liveSampling = false;
  private liveHealth = new Map<string, LiveHealth>();
  private lastLiveReset = new Map<string, number>();
  private resetting = new Set<string>();
  private liveAbort = new AbortController();
  private playout = new PlayoutController();
  private previewSource = new ScreenPreviewSource();
  private previewImages = new PreviewImages();
  private playoutTimer?: ReturnType<typeof setInterval>;
  private playoutSampling = false;
  /**
   * Кто в этой комнате не человек. Музыкальный бот публикует дорожку как обычный микрофон —
   * иначе комната не услышала бы стерео, — поэтому отличить его по источнику нельзя, и
   * состав служебных участников приходит снаружи, из снимка комнаты.
   */
  private serviceParticipants = new Set<string>();
  constructor(
    private api: RoomApi,
    private onEnd: (reason: string) => void,
    private capture: CaptureAdapter = browserCapture,
  ) {
    this.recovery = new RecoveryWindow((api.admission.recoverySeconds || 20) * 1000);
    this.room = new Room({
      // ПРИЁМ — РЕШЕНИЕ СМОТРЯЩЕГО. Адаптация выключалась, когда человек выбирал уровень
      // **отдачи** руками: «выбранный уровень относится к обеим сторонам». Это связывало два
      // разных решения. То, каким я отдаю свою картинку, ничего не говорит о том, каким мне
      // нужен чужой экран в плитке размером с визитку. Теперь решений два, и это — второе.
      //
      // `pixelDensity: 'screen'` — потому что плитка в 740 CSS-пикселей на мониторе с
      // масштабом 150 % занимает 1110 настоящих, и без этого выбор всегда на слой ниже.
      adaptiveStream: { pixelDensity: 'screen' },
      dynacast: true,
      webAudioMix: true,
      stopLocalTrackOnUnpublish: false,
      videoCaptureDefaults: {
        ...cameraCapture(this.cameraProfile),
        deviceId: this.preferences.get().devices.camera || undefined,
      },
      audioCaptureDefaults: {
        ...audioCapture(this.preferences.get().audio),
        deviceId: this.preferences.get().devices.microphone || undefined,
      },
      audioOutput: { deviceId: this.preferences.get().devices.speaker || undefined },
      publishDefaults: cameraOptions(this.cameraProfile),
      reconnectPolicy: { nextRetryDelayInMs: ({ retryCount }) => this.recovery.delay(retryCount) },
    });
    this.room
      .on(RoomEvent.Reconnecting, this.lost)
      .on(RoomEvent.SignalReconnecting, this.lost)
      .on(RoomEvent.Reconnected, this.connected)
      .on(RoomEvent.Connected, this.connected)
      .on(RoomEvent.Disconnected, (reason) => {
        if (this.disposed) return;
        if (
          reason === DisconnectReason.PARTICIPANT_REMOVED ||
          reason === DisconnectReason.ROOM_DELETED ||
          reason === DisconnectReason.DUPLICATE_IDENTITY
        ) {
          this.dispose();
          this.onEnd(
            reason === DisconnectReason.DUPLICATE_IDENTITY
              ? 'Встреча открыта в другом окне'
              : // Исключение — это конец встречи, а не запрет: войти снова можно тем же путём,
                // что и в первый раз. Прежний вход при этом мёртв, и это разные вещи.
                reason === DisconnectReason.PARTICIPANT_REMOVED
                ? 'Ведущий завершил встречу для вас. Войти снова можно по ссылке, коду или из избранного'
                : 'Доступ к встрече завершён',
          );
          return;
        }
        this.lost();
        this.scheduleConnect();
      })
      .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (participant.isLocal) this.patch({ quality });
      });
    this.room
      .on(RoomEvent.TrackPublished, this.syncSubscriptions)
      .on(RoomEvent.ParticipantConnected, this.syncSubscriptions)
      .on(RoomEvent.TrackSubscribed, this.configurePlayout)
      .on(RoomEvent.TrackSubscribed, this.applyReception)
      .on(RoomEvent.TrackSubscribed, this.refreshTracks)
      .on(RoomEvent.TrackUnsubscribed, (_track, publication?: RemoteTrackPublication) => {
        if (publication) {
          this.playout.forget(publication.trackSid);
          this.wideOpen.delete(publication.trackSid);
        }
      })
      .on(RoomEvent.TrackUnsubscribed, this.refreshTracks)
      .on(RoomEvent.TrackUnpublished, this.refreshTracks)
      .on(RoomEvent.LocalTrackPublished, this.refreshTracks)
      .on(RoomEvent.LocalTrackUnpublished, this.refreshTracks)
      .on(RoomEvent.ParticipantConnected, this.refreshTracks)
      .on(RoomEvent.ParticipantDisconnected, this.refreshTracks)
      // Кто говорит, решает SFU: он слышит всех и сравнивает уровни между собой, а страница
      // видит только тех, на кого подписана, и не слышит саму себя иначе как через эхо.
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) =>
        this.speaking.set(speakers.map((participant) => participant.identity)),
      )
      .on(RoomEvent.DataReceived, this.receivePreview)
      .on(RoomEvent.ParticipantDisconnected, (participant) => this.dropPreview(participant.identity))
      .on(RoomEvent.TrackUnpublished, (publication, participant) => {
        if (publication.source === Track.Source.ScreenShare) this.dropPreview(participant.identity);
      })
      .on(RoomEvent.TrackMuted, (publication, participant) => {
        if (participant.isLocal && publication.source === Track.Source.Microphone) {
          // Микрофон выключили не отсюда: это сделал ведущий. Тем более нужен звук — иначе
          // человек узнаёт об этом, договорив фразу в тишину.
          if (this.wanted.microphone) signal('mic-off');
          this.wanted.microphone = false;
        }
        this.refreshTracks();
      })
      .on(RoomEvent.TrackUnmuted, this.refreshTracks);
    window.addEventListener('online', this.network);
    // Экран погас или снова зажёгся: окно восстановления встаёт и идёт дальше (`screenAwake`).
    document.addEventListener('visibilitychange', this.screenAwake);
    window.addEventListener('cord:preferences', this.settingsChanged);
    this.playout.setMode(this.preferences.get().network);
    this.liveTimer = setInterval(() => void this.checkLive(), 2000);
    // Буфер подстраивается и когда вкладка скрыта: звук там продолжает играть, и именно
    // свёрнутое окно с музыкой чаще всего и слушают.
    this.playoutTimer = setInterval(() => void this.tunePlayout(), 2000);
  }
  /**
   * Что за дорожка с точки зрения допустимой задержки.
   *
   * Разговор обязан оставаться быстрым. Музыка и звук демонстрации могут отстать на
   * секунду — их никто не перебивает, а непрерывность для них важнее отзывчивости.
   */
  private playoutKind(identity: string, source: Track.Source, kind: Track.Kind): PlayoutClass {
    if (kind === Track.Kind.Video) return 'video';
    if (source === Track.Source.ScreenShareAudio) return 'media';
    return this.serviceParticipants.has(identity) ? 'media' : 'conversation';
  }
  /**
   * Что показывается вместе и обязано совпадать по губам: камера с микрофоном, экран со
   * звуком экрана. Пара — это участник и источник, а не один участник: он может показывать
   * фильм и говорить одновременно, и у этих двух пар разные права на задержку.
   */
  private playoutGroup(identity: string, source: Track.Source) {
    const screen = source === Track.Source.ScreenShare || source === Track.Source.ScreenShareAudio;
    return `${identity}:${screen ? 'screen' : 'camera'}`;
  }
  /** Служебные участники комнаты по данным ядра: их звук считается музыкой, а не речью. */
  setServiceParticipants(ids: Iterable<string>) {
    const next = new Set(ids);
    if (
      next.size === this.serviceParticipants.size &&
      [...next].every((id) => this.serviceParticipants.has(id))
    )
      return;
    this.serviceParticipants = next;
    void this.tunePlayout();
  }
  private playoutTracks(): PlayoutTrack[] {
    const tracks: PlayoutTrack[] = [];
    for (const participant of this.room.remoteParticipants.values())
      for (const publication of participant.trackPublications.values()) {
        const track = publication.track;
        // Заглушённая дорожка из списка не выбрасывается: иначе каждое выключение микрофона
        // стирало бы накопленное о ней знание, и после включения человек снова начинал бы
        // с минимального запаса — на том же самом канале.
        if (!publication.isSubscribed || !track) continue;
        tracks.push({
          id: publication.trackSid,
          kind: this.playoutKind(participant.identity, publication.source, track.kind),
          group: this.playoutGroup(participant.identity, publication.source),
          receiver: track.receiver,
          stats: () => track.getRTCStatsReport(),
        });
      }
    return tracks;
  }
  private async tunePlayout() {
    if (this.disposed || this.playoutSampling || this.state.get().status !== 'connected') return;
    this.playoutSampling = true;
    const cycle = this.connectionCycle;
    try {
      await this.playout.tick(this.playoutTracks());
      if (this.disposed || cycle !== this.connectionCycle) return;
      // Каждый опрос возвращает новый объект, поэтому сравнивать надо по значению: иначе
      // открытые настройки и диагностика перерисовывались бы каждые две секунды впустую.
      if (linkChanged(this.link.get(), this.playout.link)) this.link.set(this.playout.link);
    } catch {
      // Статистика — не право на воспроизведение: её отсутствие ничего не должно остановить.
    } finally {
      this.playoutSampling = false;
    }
  }
  private configurePlayout = (
    track?: RemoteTrack,
    publication?: RemoteTrackPublication,
    participant?: Participant,
  ) => {
    if (!track || !publication || !participant) return;
    // Запас выдаётся сразу при подписке. Ждать первой статистики нельзя: эти две секунды
    // дорожка прожила бы с нулевым буфером, а первые секунды слышны лучше всех прочих.
    this.playout.prime({
      id: publication.trackSid,
      kind: this.playoutKind(participant.identity, publication.source, track.kind),
      group: this.playoutGroup(participant.identity, publication.source),
      receiver: track.receiver,
      stats: () => track.getRTCStatsReport(),
    });
  };
  private async checkLive() {
    if (this.disposed || this.liveSampling || this.state.get().status !== 'connected' || document.hidden)
      return;
    this.liveSampling = true;
    const cycle = this.connectionCycle;
    const active = new Set<string>();
    try {
      const jobs: Promise<void>[] = [];
      for (const participant of this.room.remoteParticipants.values())
        for (const publication of participant.videoTrackPublications.values()) {
          if (
            !publication.isSubscribed ||
            !publication.isEnabled ||
            publication.isMuted ||
            !publication.track
          )
            continue;
          active.add(publication.trackSid);
          jobs.push(
            (async () => {
              const report = await publication.track!.getRTCStatsReport();
              if (this.disposed || cycle !== this.connectionCycle) return;
              const health = this.liveHealth.get(publication.trackSid) ?? new LiveHealth();
              this.liveHealth.set(publication.trackSid, health);
              let reset = false;
              const requested = this.playout.targetFor(publication.trackSid);
              report?.forEach((stat) => {
                if (stat.type === 'inbound-rtp' && (stat.kind ?? stat.mediaType) === 'video')
                  reset ||= health.observe(stat, requested);
              });
              if (reset) await this.resetLivePair(participant.identity, publication.source, true);
            })().catch(() => {}),
          );
        }
      await Promise.all(jobs);
      for (const key of this.liveHealth.keys()) if (!active.has(key)) this.liveHealth.delete(key);
      for (const key of this.lastLiveReset.keys())
        if (!this.room.remoteParticipants.has(key.split(':')[0]!)) this.lastLiveReset.delete(key);
    } finally {
      this.liveSampling = false;
    }
  }
  /** Какой запас буфера мы сейчас просим по каждой дорожке. Для диагностики. */
  playoutTargets() {
    return this.playout.targets();
  }
  /**
   * Какой кодек камере по силам на этой машине.
   *
   * Спрашивается один раз и переиспользуется: `mediaCapabilities.encodingInfo` — это опрос
   * платформы, а не устройства, и от кадра к кадру ответ не меняется. Отказ ответа означает
   * прежний VP8, то есть худшее, что могло случиться, и есть нынешнее поведение.
   */
  private ensureCameraCodec() {
    this.cameraCodecChosen ??= chooseCameraCodec(this.cameraProfile)
      .then((codec) => {
        this.cameraCodec = codec;
        return codec;
      })
      .catch(() => this.cameraCodec);
    return this.cameraCodecChosen;
  }
  /** Что камера умеет на самом деле — чтобы не просить у неё невозможного молча. */
  private cameraCapabilities() {
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    return track instanceof LocalVideoTrack
      ? track.mediaStreamTrack.getCapabilities?.()
      : this.deviceTracks.get(Track.Source.Camera)?.mediaStreamTrack.getCapabilities?.();
  }
  /** Чем захватывать камеру и как её публиковать при нынешнем составе отдачи. */
  private cameraCaptureNow() {
    return this.cameraRole === 'companion'
      ? companionCameraCapture()
      : cameraCapture(this.cameraProfile, this.cameraCapabilities());
  }
  private cameraOptionsNow() {
    return this.cameraRole === 'companion'
      ? companionCameraOptions(this.cameraCodec)
      : cameraOptions(this.cameraSending, this.cameraCodec);
  }
  /** Подсказать кодировщику, что в этом кадре важнее — движение или резкость. */
  private applyCameraHint() {
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (track instanceof LocalVideoTrack)
      track.mediaStreamTrack.contentHint =
        this.cameraRole === 'companion' ? 'motion' : cameraHint(this.cameraProfile);
    void this.enforceCameraRate();
  }
  /**
   * Потребовать у камеры выбранную частоту, а не попросить.
   *
   * Отказ здесь ничего не ломает: дорожка остаётся той же, какой была, а насколько камера
   * не дотянула — видно в плашке. Поэтому `min` ставится после захвата, а не в нём.
   */
  private async enforceCameraRate() {
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (!(track instanceof LocalVideoTrack) || this.cameraRole === 'companion') return;
    // Просьбы идут от самой строгой к самой мягкой; первая исполненная и остаётся. Отказ
    // ничего не ломает: дорожка такая же, какой была, а недобор виден в плашке.
    for (const wanted of forcedCameraConstraints(this.cameraProfile, this.cameraCapabilities())) {
      try {
        await track.mediaStreamTrack.applyConstraints(wanted);
        return;
      } catch {
        /* Камера не умеет столько при этом кадре — пробуем следующую просьбу. */
      }
    }
  }
  /** Что мы сейчас отдаём — для решения, кому уступать. */
  private upstreamInputs(limitation = 'none', available: number | null = null) {
    return {
      sharing: this.screenTracks.some((track) => track instanceof LocalVideoTrack),
      camera: !!this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track,
      limitation,
      available,
      screenAutomatic: this.profile.automatic,
      cameraAutomatic: this.cameraProfile.automatic,
      // Потолок — то, что человек выбрал. В автоматическом режиме выбора нет, и лестница
      // свободна до самого верха: именно этого и не хватало, когда «Авто» означало 720p.
      screenCeiling: this.profile.automatic ? undefined : this.profile,
      cameraCeiling: this.cameraProfile.automatic ? undefined : this.cameraProfile,
    };
  }
  /**
   * Пересчитать бюджет отдачи после изменения состава дорожек.
   *
   * Вызывается там, где состав меняется по воле человека — включил камеру, начал или
   * закончил показ, — а не только по таймеру: ждать следующего опроса значит несколько
   * секунд отдавать лишние три мегабита ровно в тот момент, когда их меньше всего.
   */
  private syncUpstream() {
    try {
      this.applyUpstream(this.budget.observe(this.upstreamInputs()));
    } catch (error) {
      // Бюджет — это экономия, а не право говорить. Его отказ не должен отменять показ
      // экрана, к которому он прицеплен: лишние мегабиты лучше сорванной демонстрации.
      this.report(error);
    }
  }
  private applyUpstream(change: UpstreamChange) {
    if (change.camera) void this.applyCameraRole(change.camera);
    if (change.screen) void this.stepScreen({ ...this.profile, ...change.screen });
    if (change.cameraLevel) {
      const level = { ...this.cameraProfile, ...change.cameraLevel };
      // В «Авто» ступень лестницы — это и есть текущий выбор, и она запоминается: следующий
      // разговор начнётся с неё, а не с настроек по умолчанию. Выбранный руками уровень
      // менять нельзя: человек его назвал, и подмена записи была бы подменой самого выбора.
      //
      // Но запоминается она тихо. Раньше ступень «Авто» шла через `setCameraProfile`, то есть
      // через перезапуск камеры и переопубликацию — как если бы человек сам сменил настройку.
      // Это и моргало у всех, кто смотрит, при каждом шаге лестницы. Теперь шаг один для обоих
      // режимов: `setCameraSending`, на месте.
      if (this.cameraProfile.automatic) {
        this.cameraProfile = level;
        this.preferences.set(savePreferences({ camera: level }));
      }
      void this.setCameraSending(level);
    }
  }
  /**
   * Сменить то, чем камера идёт в сеть, не трогая выбор человека.
   *
   * НА МЕСТЕ, А НЕ ПЕРЕОПУБЛИКАЦИЕЙ. Здесь стояло «переопубликовать всё же приходится: слои
   * simulcast считаются при публикации и на месте не меняются». Число слоёв — да; их кадр,
   * битрейт и частота — меняются, и браузер делает это в работающем кодировщике. А
   * переопубликация стоила каждого шага лестницы: у зрителей дорожка пропадала и появлялась
   * заново с нижнего слоя — «моргнула, полсекунды мыло, потом нормально». Замерено на стенде:
   * после шага SSRC у зрителя менялся и 0,3 с не было кадра вовсе; после `setParameters` тот же
   * SSRC и новый размер кадра внутри потока (`retune.ts`).
   *
   * Захват остаётся прежним — тем, что выбрано, — пока ступень в него помещается. «Авто»
   * снимает под свою ступень, и если лестница поднялась выше, захват растёт той же дорожкой
   * (`applyConstraints`): камера не перезапускается и не переопубликовывается. Переопубликация
   * осталась только запасным путём — если браузер не дал подстроить слои на месте.
   */
  private setCameraSending(level: ScreenProfile) {
    if (level.resolution === this.cameraSending.resolution && level.fps === this.cameraSending.fps)
      return this.cameraChange;
    this.cameraSending = level;
    this.cameraChange = this.cameraChange.then(async () => {
      if (this.disposed || !this.wanted.camera || this.cameraRole === 'companion') return;
      const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      if (!(track instanceof LocalVideoTrack)) return;
      const applied = this.cameraSending;
      // Пока очередь ждала, лестница шагнула ещё раз: этот шаг уже никому не нужен.
      if (applied !== level) return;
      if (await this.retuneCamera(track, applied).catch(() => false)) return;
      this.deviceBusy.add('camera');
      try {
        await this.room.localParticipant.unpublishTrack(track, false);
        if (this.disposed || applied !== this.cameraSending) return;
        await this.room.localParticipant.publishTrack(track, {
          ...this.cameraOptionsNow(),
          source: Track.Source.Camera,
        });
        this.applyCameraHint();
        if (this.disposed) track.stop();
        this.refreshTracks();
      } catch (error) {
        this.report(error);
      } finally {
        this.deviceBusy.delete('camera');
      }
    });
    return this.cameraChange;
  }
  /**
   * Ступень камеры на работающей дорожке. Захват растёт только в «Авто» и только если ступень
   * выше того, что камера сейчас снимает и умеет: выбранный вручную уровень и так снимается
   * целиком, а просить у камеры больше её возможностей значит перезапускать захват впустую.
   */
  private async retuneCamera(track: LocalVideoTrack, level: ScreenProfile): Promise<boolean> {
    if (!rememberLayout(track)) return false;
    const media = track.mediaStreamTrack;
    const settings = media.getSettings();
    const short = Math.min(settings.width ?? 0, settings.height ?? 0);
    const capabilities = this.cameraCapabilities();
    const wanted = cameraCapture(level, capabilities).resolution;
    const canGrow =
      Math.min(wanted.width, wanted.height) > short * 1.05 ||
      (settings.frameRate !== undefined && wanted.frameRate > settings.frameRate + 1);
    if (this.cameraProfile.automatic && short && canGrow)
      await media
        .applyConstraints({
          width: { ideal: wanted.width },
          height: { ideal: wanted.height },
          frameRate: { ideal: wanted.frameRate },
        })
        .catch(() => {});
    if (!(await retune(track, level))) return false;
    media.contentHint = cameraHint(level);
    return true;
  }
  /**
   * Вернуть камере текущую ступень после смены устройства. LiveKit после `restartTrack`
   * пересчитывает слои от параметров публикации — то есть от уровня, с которым камеру
   * включили, а не от того, на котором лестница стоит сейчас.
   */
  private async reapplyCameraLevel() {
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (!(track instanceof LocalVideoTrack) || this.cameraRole === 'companion') return;
    await this.retuneCamera(track, this.cameraSending).catch(() => false);
  }
  /**
   * Переопубликовать камеру другим кадром.
   *
   * Дорожка пересобирается целиком — так же, как при смене профиля камеры: `restartTrack`
   * меняет источник, а повторная публикация даёт кодировщику новые параметры. Сменить
   * только битрейт на месте нельзя: слои simulcast считаются при публикации.
   */
  private applyCameraRole(role: CameraRole) {
    if (this.cameraRole === role) return this.cameraChange;
    this.cameraRole = role;
    this.cameraChange = this.cameraChange.then(async () => {
      if (this.disposed || !this.wanted.camera) return;
      const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      if (!(track instanceof LocalVideoTrack)) return;
      // Роль могла смениться обратно, пока очередь ждала: применяем только последнюю.
      const applied = this.cameraRole;
      this.deviceBusy.add('camera');
      try {
        await track.restartTrack({
          ...this.cameraCaptureNow(),
          deviceId: this.preferences.get().devices.camera || undefined,
        });
        if (this.disposed || applied !== this.cameraRole) return;
        await this.room.localParticipant.unpublishTrack(track, false);
        if (this.disposed) return;
        await this.room.localParticipant.publishTrack(track, {
          ...this.cameraOptionsNow(),
          source: Track.Source.Camera,
        });
        this.applyCameraHint();
        if (this.disposed) track.stop();
        this.refreshTracks();
      } catch (error) {
        this.report(error);
      } finally {
        this.deviceBusy.delete('camera');
      }
    });
    return this.cameraChange;
  }
  async returnToLive() {
    if (this.disposed || this.state.get().status !== 'connected') return;
    await Promise.all(
      [...this.room.remoteParticipants.values()].flatMap((p) => [
        this.resetLivePair(p.identity, Track.Source.Camera, false),
        this.resetLivePair(p.identity, Track.Source.ScreenShare, false),
      ]),
    );
  }
  private async resetLivePair(identity: string, source: Track.Source, automatic: boolean) {
    const screen = source === Track.Source.ScreenShare;
    const key = `${identity}:${screen ? 'screen' : 'camera'}`;
    if (this.resetting.has(key) || (automatic && Date.now() - (this.lastLiveReset.get(key) ?? 0) < 30000))
      return;
    const participant = this.room.remoteParticipants.get(identity);
    if (!participant) return;
    const sources = screen
      ? [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]
      : [Track.Source.Camera, Track.Source.Microphone];
    const publications = [...participant.trackPublications.values()].filter(
      (p) => sources.includes(p.source) && p.isSubscribed && p.isEnabled && !p.isMuted,
    );
    if (!publications.length) return;
    this.resetting.add(key);
    this.lastLiveReset.set(key, Date.now());
    this.patch({ liveStatus: 'Обновляем прямой эфир…' });
    try {
      await Promise.all(publications.map((p) => this.unsubscribeForRefresh(p)));
    } finally {
      // Restore the same publication even if an ICE restart began while waiting. Never touch a replacement session.
      if (!this.disposed)
        for (const publication of publications) {
          if (
            this.room.remoteParticipants.get(identity)?.trackPublications.get(publication.trackSid) ===
              publication &&
            this.shouldSubscribe(identity, publication.source)
          )
            publication.setSubscribed(true);
        }
      this.resetting.delete(key);
      clearTimeout(this.liveNoticeTimer);
      if (!this.disposed)
        this.liveNoticeTimer = setTimeout(() => {
          if (!this.disposed) this.patch({ liveStatus: null });
        }, 2500);
    }
  }
  private unsubscribeForRefresh(publication: RemoteTrackPublication) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.liveAbort.signal.removeEventListener('abort', done);
        publication.off(TrackEvent.Unsubscribed, done);
        resolve();
      };
      const timer = setTimeout(done, 2000);
      this.liveAbort.signal.addEventListener('abort', done, { once: true });
      publication.once(TrackEvent.Unsubscribed, done);
      publication.setSubscribed(false);
    });
  }
  private patch(value: Partial<MediaState>) {
    this.state.update((s) => ({ ...s, ...value }));
  }
  report(error: unknown) {
    this.patch({ error: error instanceof Error ? error.message : 'Не удалось выполнить действие' });
  }
  clearError() {
    this.patch({ error: null });
  }
  async start() {
    if (this.connecting || this.disposed || this.state.get().status === 'connected') return;
    this.connecting = true;
    const generation = this.generation;
    if (!this.recovery.active) this.patch({ status: 'connecting' });
    try {
      if (this.recovery.active) await this.api.resume();
      const { url, token } = await this.api.token();
      if (this.disposed || generation !== this.generation) return;
      await this.room.connect(url, token, {
        autoSubscribe: false,
        peerConnectionTimeout: 10000,
        websocketTimeout: 5000,
      });
      if (this.disposed || generation !== this.generation) await this.room.disconnect();
    } catch (error) {
      if (!this.disposed) {
        if (error instanceof ApiError && [403, 404, 410].includes(error.status)) {
          this.dispose();
          this.onEnd(error.message);
          return;
        }
        this.report(error);
        this.lost();
        this.scheduleConnect();
      }
    } finally {
      this.connecting = false;
    }
  }
  private scheduleConnect() {
    clearTimeout(this.reconnectTimer);
    if (this.recovery.remaining() <= 0 || this.disposed) return;
    const delay = this.recovery.delay(this.fullRetry++);
    if (delay === null) return;
    this.reconnectTimer = setTimeout(() => {
      if (!this.connecting) void this.start();
      else this.scheduleConnect();
    }, delay);
  }
  private network = () => {
    // The SDK owns retries while signaling is reconnecting. Only restart after it has disconnected.
    if (this.recovery.active && this.room.state === 'disconnected' && !this.connecting) {
      clearTimeout(this.reconnectTimer);
      void this.start();
    }
  };
  /*
    ЗВОНОК В КАРМАНЕ.

    Пока на экран не смотрят, окно восстановления стоит: браузер в это время душит таймеры, а
    то и замораживает страницу целиком, и «не восстановилось за двадцать секунд» означало бы
    «человек убрал телефон в карман». Само переподключение при этом продолжается — его ведёт
    SDK, и мешать ему незачем.

    Вернулись к экрану — окно идёт дальше с того же остатка, а если связь так и не вернулась,
    человек увидит честный отсчёт и сможет что-то сделать. Заодно возвращение — хороший повод
    попробовать подключиться прямо сейчас, не дожидаясь очередной попытки по расписанию.
  */
  private screenAwake = () => {
    const hidden = typeof document !== 'undefined' && document.hidden;
    this.recovery.hold(hidden);
    if (!hidden) this.network();
  };
  private lost = () => {
    if (this.disposed) return;
    this.liveHealth.clear();
    const fresh = this.deadlineTimer === undefined;
    const epoch = this.recovery.begin();
    this.patch({ status: 'recovering', remaining: Math.ceil(this.recovery.remaining() / 1000) });
    if (!fresh) return;
    this.connectionCycle++;
    this.reportConnection('media.lost', () => this.recovery.current(epoch));
    clearInterval(this.deadlineTimer);
    this.deadlineTimer = setInterval(() => {
      if (!this.recovery.current(epoch)) return;
      // Придержанное окно не заканчивается: см. `screenAwake`.
      if (this.recovery.holding) return;
      const remaining = this.recovery.remaining();
      this.patch({ remaining: Math.ceil(remaining / 1000) });
      if (remaining <= 0) {
        this.dispose();
        this.onEnd(`Соединение не восстановилось за ${this.recovery.durationMs / 1000} секунд`);
      }
    }, 100);
  };
  private connected = () => {
    if (this.disposed) return;
    if (this.recovery.active && this.recovery.remaining() <= 0) {
      this.dispose();
      this.onEnd('Время восстановления истекло');
      return;
    }
    this.syncSubscriptions();
    this.recovery.recovered();
    clearInterval(this.deadlineTimer);
    this.deadlineTimer = undefined;
    clearTimeout(this.reconnectTimer);
    this.fullRetry = 0;
    const cycle = ++this.connectionCycle;
    this.reportConnection(
      'media.restored',
      () => cycle === this.connectionCycle && this.room.state === 'connected',
    );
    void this.restoreTracks(cycle);
    this.patch({ status: 'connected', remaining: this.recovery.durationMs / 1000, error: null });
    this.startUpstreamMonitor();
    this.refreshTracks();
  };
  private refreshTracks = () => {
    if (this.disposed || this.refreshQueued) return;
    this.refreshQueued = true;
    // LiveKit emits TrackUnsubscribed before clearing the publication's track.
    // Read after that synchronous mutation, and coalesce related SDK events.
    queueMicrotask(() => {
      this.refreshQueued = false;
      this.collectTracks();
    });
  };
  private reportConnection(type: 'media.lost' | 'media.restored', current: () => boolean) {
    this.mediaReport = this.mediaReport
      .then(async () => {
        if (this.disposed || !current()) return;
        const snapshot = await this.api.snapshot();
        const member = snapshot.participants.find((p) => p.id === this.api.admission.participantId);
        if (member && !this.disposed && current())
          await this.api.command({ type, commandId: crypto.randomUUID(), generation: member.generation });
      })
      .catch(() => {});
  }
  private collectTracks() {
    if (this.disposed) return;
    const tiles: MediaTile[] = [];
    const collect = (participant: Participant) => {
      for (const publication of participant.trackPublications.values())
        if (publication.track)
          tiles.push({
            id: publication.trackSid,
            participantId: participant.identity,
            name: participant.name || 'Участник',
            source: publication.source,
            track: publication.track,
            local: participant.isLocal,
            muted: publication.isMuted,
          });
    };
    collect(this.room.localParticipant);
    for (const publication of this.room.localParticipant.trackPublications.values()) {
      if (publication.track && [Track.Source.Camera, Track.Source.Microphone].includes(publication.source))
        this.deviceTracks.set(publication.source, publication.track);
    }
    for (const [source, track] of this.deviceTracks)
      if (track.mediaStreamTrack.readyState === 'ended') this.deviceTracks.delete(source);
    this.room.remoteParticipants.forEach(collect);
    this.tracks.set(tiles);
    const local = this.room.localParticipant;
    this.patch({
      microphone: local.isMicrophoneEnabled,
      camera: local.isCameraEnabled,
      screen: local.isScreenShareEnabled,
    });
  }
  private async restoreTracks(cycle: number) {
    try {
      for (const [source, wanted] of [
        [Track.Source.Camera, this.wanted.camera],
        [Track.Source.Microphone, this.wanted.microphone],
      ] as const) {
        if (this.disposed || cycle !== this.connectionCycle) return;
        if (!wanted || this.room.localParticipant.getTrackPublication(source)?.track) continue;
        const track = this.deviceTracks.get(source);
        if (source === Track.Source.Camera) await this.ensureCameraCodec();
        if (track && track.mediaStreamTrack.readyState === 'live')
          await this.room.localParticipant.publishTrack(track, {
            ...(source === Track.Source.Camera ? this.cameraOptionsNow() : microphoneOptions()),
            source,
          });
        else if (source === Track.Source.Camera)
          await this.room.localParticipant.setCameraEnabled(
            true,
            this.cameraCaptureNow(),
            this.cameraOptionsNow(),
          );
        else {
          await this.room.localParticipant.setMicrophoneEnabled(
            true,
            audioCapture(this.preferences.get().audio, this.preferences.get().devices.microphone),
            microphoneOptions(),
          );
          await this.applyAudioProcessor();
        }
      }
      for (const track of this.screenTracks) {
        if (this.disposed || cycle !== this.connectionCycle) return;
        if (
          track.mediaStreamTrack.readyState !== 'live' ||
          this.room.localParticipant.getTrackPublication(track.source)?.track
        )
          continue;
        await this.room.localParticipant.publishTrack(track, {
          ...screenOptions(this.profile, this.codec),
          source: track.source,
          ...(track.kind === Track.Kind.Audio
            ? { audioPreset: { maxBitrate: 128000 }, forceStereo: true, dtx: false }
            : {}),
        });
      }
      this.refreshTracks();
      this.syncUpstream();
    } catch (error) {
      if (!this.disposed) this.report(error);
    }
  }
  /**
   * Включает или выключает устройство.
   *
   * `announce` — звучать ли сигналом. По умолчанию да: нажатие на микрофон слышно своим ухом
   * раньше, чем глаз найдёт значок, и это единственное подтверждение, которое успевает прийти
   * до первого произнесённого слова. Первичная выдача устройств при входе просит тишины: там
   * человек ничего не переключал, а уже слышал, что вошёл.
   */
  async toggle(kind: 'microphone' | 'camera', deviceId?: string, announce = true) {
    if (this.deviceBusy.has(kind) || this.disposed) return;
    this.deviceBusy.add(kind);
    try {
      const reusedCamera =
        kind === 'camera' && !!this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      deviceId ||= this.preferences.get().devices[kind] || undefined;
      if (kind === 'microphone') {
        await this.room.localParticipant.setMicrophoneEnabled(
          !this.state.get().microphone,
          audioCapture(this.preferences.get().audio, deviceId),
          microphoneOptions(),
        );
        if (this.room.localParticipant.isMicrophoneEnabled) await this.applyAudioProcessor();
      } else {
        // Кодек выбирается до публикации: поменять его потом — это переговоры и перерыв в
        // картинке, а ответ платформы от момента вопроса не зависит.
        if (!this.state.get().camera) {
          await this.ensureCameraCodec();
          // Каждое включение начинается с выбранного уровня: прежняя уступка не наследуется.
          this.cameraSending = this.cameraProfile;
          this.budget.resetCamera();
        }
        await this.room.localParticipant.setCameraEnabled(
          !this.state.get().camera,
          { deviceId, ...this.cameraCaptureNow() },
          this.cameraOptionsNow(),
        );
        this.applyCameraHint();
      }
      this.wanted[kind] =
        kind === 'microphone'
          ? this.room.localParticipant.isMicrophoneEnabled
          : this.room.localParticipant.isCameraEnabled;
      if (kind === 'microphone' && announce)
        signal(this.room.localParticipant.isMicrophoneEnabled ? 'mic-on' : 'mic-off');
      if (kind === 'camera' && !reusedCamera) this.cameraProfilePending = false;
      if (kind === 'camera' && this.wanted.camera && this.cameraProfilePending)
        await this.setCameraProfile(this.cameraProfile);
      // Камеру включили посреди показа — она сразу идёт маленьким кадром; выключили —
      // бюджет узнаёт об этом и вернёт полный кадр, когда камера появится снова.
      if (kind === 'camera') this.syncUpstream();
      this.refreshTracks();
    } catch (error) {
      this.report(error);
    } finally {
      this.deviceBusy.delete(kind);
    }
  }
  /**
   * Настройки поменяли где-то ещё в приложении.
   *
   * ЗАЧЕМ. Это хранилище — то, на что подписан весь интерфейс встречи, но записывает в
   * `localStorage` кто угодно (`savePreferences`), и о чужой записи хранилище не узнавало
   * никак. Выглядело это не как «значение не обновилось», а как сломанная ручка: ползунок
   * громкости кинозала стоял на месте, потому что показывал заморожённое значение из
   * хранилища, а не то, что человек только что передвинул.
   */
  private settingsChanged = () => {
    if (!this.disposed) this.preferences.set(readPreferences());
  };
  saveSettings(patch: Partial<Preferences>) {
    const next = savePreferences(patch);
    this.preferences.set(next);
    // Режим сети меняет только запас буфера, поэтому применяется на месте: ни переподписка,
    // ни тем более переподключение для этого не нужны.
    this.playout.setMode(next.network);
    if (patch.network !== undefined) void this.tunePlayout();
  }
  setVolume(participantId: string, volume: number) {
    if (!Number.isFinite(volume)) return;
    const value = Math.max(0, Math.min(2, volume));
    this.volumes.update((values) => ({ ...values, [participantId]: value }));
    const person = this.volumeKeys.get(participantId);
    if (this.volumeRoom && person) rememberVolume(this.volumeRoom, person, value);
  }
  /**
   * Кого в этой встрече как зовут — и насколько громко его уже просили звучать.
   *
   * Зовётся на каждый снимок комнаты: пришедшему или вернувшемуся сразу ставится громкость,
   * которую для него выбрали раньше. Номер участника меняется от входа к входу, поэтому
   * память ведётся по устойчивому ключу, а связывает одно с другим этот список.
   *
   * Уже выставленную в этой сессии громкость память не трогает: последнее слово всегда за
   * ползунком, а не за тем, что записано на диске.
   */
  rememberPeople(roomId: string, people: { id: string; key: string | null }[]) {
    this.volumeRoom = roomId;
    const restored: Record<string, number> = {};
    for (const person of people) {
      if (!person.key) continue;
      this.volumeKeys.set(person.id, person.key);
      if (this.volumes.get()[person.id] !== undefined) continue;
      const remembered = recallVolume(roomId, person.key);
      if (remembered !== undefined) restored[person.id] = remembered;
    }
    if (Object.keys(restored).length) this.volumes.update((values) => ({ ...values, ...restored }));
  }
  async setAudioSettings(audio: AudioPreferences) {
    this.audioChange = this.audioChange.then(async () => {
      if (this.disposed) return;
      const track = this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      try {
        if (track instanceof LocalAudioTrack) {
          await track.applyConstraints(audioCapture(audio));
          await this.applyAudioProcessor(audio);
        }
        this.preferences.set(savePreferences({ audio }));
      } catch (error) {
        this.report(error);
      }
    });
    return this.audioChange;
  }
  private async applyAudioProcessor(audio = this.preferences.get().audio) {
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (!(track instanceof LocalAudioTrack)) return;
    if (needsAudioProcessor(audio)) await track.setProcessor(new CordAudioProcessor(audio));
    else if (track.getProcessor()) await track.stopProcessor();
  }
  async switchDevice(kind: MediaDeviceKind, id: string) {
    const activeCamera = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    const previous =
      this.preferences.get().devices[
        kind === 'audioinput' ? 'microphone' : kind === 'videoinput' ? 'camera' : 'speaker'
      ] ||
      (kind === 'videoinput' && activeCamera instanceof LocalVideoTrack
        ? activeCamera.mediaStreamTrack.getSettings().deviceId
        : undefined);
    try {
      await this.room.switchActiveDevice(kind, id);
      if (kind === 'videoinput') await this.reapplyCameraLevel();
      const devices = {
        ...this.preferences.get().devices,
        [kind === 'audioinput' ? 'microphone' : kind === 'videoinput' ? 'camera' : 'speaker']: id,
      };
      this.preferences.set(savePreferences({ devices }));
    } catch (error) {
      if (kind === 'videoinput' && previous)
        await this.room.switchActiveDevice(kind, previous).catch(() => {});
      this.report(error);
    }
  }
  async flipCamera() {
    if (this.deviceBusy.has('camera') || this.disposed) return;
    this.deviceBusy.add('camera');
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    const previous =
      this.preferences.get().devices.camera ||
      (track instanceof LocalVideoTrack ? track.mediaStreamTrack.getSettings().deviceId : undefined);
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === 'videoinput',
      );
      if (!this.state.get().camera) {
        const index = devices.findIndex((d) => d.deviceId === previous);
        const next = devices[(index + 1) % devices.length];
        if (next) await this.switchDevice('videoinput', next.deviceId);
        return;
      }
      if (!(track instanceof LocalVideoTrack)) return;
      const currentFacing = track.mediaStreamTrack.getSettings().facingMode;
      const next = devices[(devices.findIndex((d) => d.deviceId === previous) + 1) % devices.length];
      await track.restartTrack({
        ...this.cameraCaptureNow(),
        deviceId: currentFacing ? undefined : next?.deviceId,
        facingMode: currentFacing ? (currentFacing === 'environment' ? 'user' : 'environment') : undefined,
      });
      await this.reapplyCameraLevel();
      const id = track.mediaStreamTrack.getSettings().deviceId;
      if (id) this.saveSettings({ devices: { ...this.preferences.get().devices, camera: id } });
      this.refreshTracks();
    } catch (error) {
      if (track instanceof LocalVideoTrack)
        await track.restartTrack({ ...this.cameraCaptureNow(), deviceId: previous }).catch(() => {});
      this.report(error);
    } finally {
      this.deviceBusy.delete('camera');
    }
  }
  /**
   * Camera zoom, where the platform exposes it. It is an optional constraint: Android Chrome
   * implements it, iOS Safari does not, and a desktop webcam usually has no zoom at all. The
   * caller gets null in those cases and should not offer the gesture.
   */
  cameraZoom(): { min: number; max: number; step: number; value: number } | null {
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (!(track instanceof LocalVideoTrack)) return null;
    const media = track.mediaStreamTrack;
    const zoom = (media.getCapabilities?.() as { zoom?: { min: number; max: number; step?: number } })?.zoom;
    if (!zoom || !(zoom.max > zoom.min)) return null;
    const current = (media.getSettings() as { zoom?: number }).zoom;
    return {
      min: zoom.min,
      max: zoom.max,
      step: zoom.step && zoom.step > 0 ? zoom.step : (zoom.max - zoom.min) / 100,
      value: typeof current === 'number' ? current : zoom.min,
    };
  }

  async applyCameraZoom(value: number) {
    const range = this.cameraZoom();
    if (!range) return;
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (!(track instanceof LocalVideoTrack)) return;
    const clamped = Math.min(range.max, Math.max(range.min, value));
    try {
      // Zoom is an "advanced" constraint: browsers that do not know it ignore this silently
      // rather than failing the whole call, which is why it is applied on its own.
      await track.mediaStreamTrack.applyConstraints({
        advanced: [{ zoom: clamped } as MediaTrackConstraintSet],
      });
    } catch {
      /* A camera may refuse a zoom it advertised; keep the call alive regardless. */
    }
  }

  /** Must be called directly from the click handler, before any await. */
  share(profile: ScreenProfile): void {
    if (this.screenBusy || this.disposed) return;
    if (this.state.get().screen) {
      void this.stopScreen();
      return;
    }
    if (!this.capture.supported()) {
      this.report(new Error('Этот браузер не поддерживает демонстрацию экрана'));
      return;
    }
    this.screenBusy = true;
    const capture = this.capture.capture(profile);
    void this.publishScreen(capture, profile).finally(() => {
      this.screenBusy = false;
    });
  }
  private async publishScreen(capture: Promise<MediaStream>, profile: ScreenProfile) {
    let stream: MediaStream | undefined;
    let reserved = false;
    const operation = new AbortController();
    this.screenPublishAbort = operation;
    const captureEnded = () => operation.abort();
    try {
      stream = await capture;
      if (this.disposed || operation.signal.aborted) return;
      const video = stream.getVideoTracks()[0];
      if (!video) throw new Error('Не удалось получить экран');
      video.addEventListener('ended', captureEnded, { once: true });
      const settings = video.getSettings();
      // Звук всего экрана — это и звук самого Cord. Если браузер не умеет его вычесть, лучше
      // сказать об этом сразу, чем оставить зрителя гадать, почему он слышит сам себя.
      if (ownAudioLeaks(video, stream.getAudioTracks()[0]))
        this.report(
          new Error(
            'Этот браузер не умеет убирать звук самого Cord из звука системы: зрители услышат и разговор, и собственный голос. Поделитесь окном или вкладкой — либо обновите браузер.',
          ),
        );
      this.captureSize = { width: settings.width ?? 1920, height: settings.height ?? 1080 };
      const size = fitSource(this.captureSize.width, this.captureSize.height, profile.resolution);
      await video.applyConstraints({
        width: { max: size.width },
        height: { max: size.height },
        frameRate: { max: profile.fps },
      });
      // The hint follows the same rule as the degradation preference: a chosen level holds its
      // frame rate, so the encoder is told to favour motion; automatic favours legibility.
      video.contentHint = profile.automatic ? 'detail' : 'motion';
      this.codec = await chooseCodec(profile);
      this.profile = profile;
      if (this.disposed || operation.signal.aborted || video.readyState !== 'live') return;
      const reservation = await this.api.screen(true);
      reserved = true;
      await waitForPublishPermissions(
        this.room,
        stream
          .getTracks()
          .map((track) =>
            track.kind === 'video' ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio,
          ),
        operation.signal,
      );
      if (this.disposed || operation.signal.aborted || video.readyState !== 'live') return;
      for (const track of stream.getTracks()) {
        const publication = await this.room.localParticipant.publishTrack(track, {
          ...screenOptions(profile, this.codec),
          source: track.kind === 'video' ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio,
          ...(track.kind === 'audio'
            ? { audioPreset: { maxBitrate: 128000 }, forceStereo: true, dtx: false }
            : {}),
        });
        if (publication.track) this.screenTracks.push(publication.track);
        if (this.disposed || operation.signal.aborted) {
          await this.stopScreen();
          return;
        }
      }
      if (reservation.value)
        await this.api.command({
          type: 'screen.started',
          commandId: crypto.randomUUID(),
          targetId: reservation.value,
        });
      video.removeEventListener('ended', captureEnded);
      video.addEventListener(
        'ended',
        () => {
          if (this.screenTracks.some((track) => track.mediaStreamTrack === video)) void this.stopScreen();
        },
        { once: true },
      );
      this.refreshTracks();
      // Камера уступает место здесь же, а не после первой жалобы кодировщика: жалоба
      // означала бы, что экран уже успел испортиться.
      this.syncUpstream();
      this.syncPreview();
      this.upstreamCounters = undefined;
      stream = undefined;
    } catch (error) {
      if (!(error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name)))
        this.report(error);
      await this.stopScreen();
    } finally {
      if (this.screenPublishAbort === operation) this.screenPublishAbort = undefined;
      if (stream) {
        stream.getVideoTracks()[0]?.removeEventListener('ended', captureEnded);
        stream.getTracks().forEach((t) => t.stop());
        if (reserved) await this.api.screen(false).catch(() => {});
      }
    }
  }
  async stopScreen() {
    this.screenPublishAbort?.abort();
    this.screenGeneration++;
    // Счётчики байтов принадлежали экрану; следующий интервал должен считаться заново,
    // иначе первый замер камеры вычтет из своих байтов чужие.
    this.upstreamCounters = undefined;
    this.previewSource.stop();
    const tracks = this.screenTracks;
    this.screenTracks = [];
    for (const track of tracks) {
      try {
        await this.room.localParticipant.unpublishTrack(track, true);
      } catch {
        track.stop();
      }
    }
    await this.api.screen(false).catch(() => {});
    this.refreshTracks();
    // Показа больше нет — камера возвращается к своему профилю, а лестница экрана
    // начинается с начала: следующий показ может идти по другому каналу.
    this.budget.reset();
    this.syncUpstream();
  }
  setProfile(profile: ScreenProfile) {
    this.profile = profile;
    this.preferences.set(savePreferences({ screen: profile }));
    this.profileChange = this.profileChange.then(() => this.applyProfile(this.profile));
    return this.profileChange;
  }
  setCameraProfile(profile: ScreenProfile) {
    this.cameraProfile = profile;
    // Новый выбор отменяет прежнюю уступку: отдаём то, что назвали, и только если не выйдет —
    // лестница спустится снова, уже от нового потолка.
    this.cameraSending = profile;
    this.cameraProfilePending = true;
    this.preferences.set(savePreferences({ camera: profile }));
    this.cameraChange = this.cameraChange.then(async () => {
      if (this.disposed || !this.wanted.camera) return;
      const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      if (!(track instanceof LocalVideoTrack)) return;
      this.deviceBusy.add('camera');
      try {
        await track.restartTrack({
          ...this.cameraCaptureNow(),
          deviceId: this.preferences.get().devices.camera || undefined,
        });
        if (this.disposed) return;
        await this.room.localParticipant.unpublishTrack(track, false);
        if (this.disposed) return;
        await this.room.localParticipant.publishTrack(track, {
          ...this.cameraOptionsNow(),
          source: Track.Source.Camera,
        });
        this.applyCameraHint();
        this.cameraProfilePending = false;
        if (this.disposed) track.stop();
        this.refreshTracks();
      } catch (error) {
        this.report(error);
      } finally {
        this.deviceBusy.delete('camera');
      }
    });
    return this.cameraChange;
  }
  /**
   * Шаг лестницы «Авто» для показа — тем же способом, что у камеры: на месте.
   *
   * Отличие от `setProfile` одно, и оно главное. `setProfile` зовут, когда человек выбрал
   * уровень или когда сменился кодек: там новая публикация честная — другой кодек иначе не
   * отдать. Шаг лестницы не выбор и не кодек, и переопубликация на каждом шаге означала, что
   * зрители теряли показ на время подписки заново — ровно тогда, когда канал и так тесный.
   */
  private stepScreen(profile: ScreenProfile) {
    this.profile = profile;
    this.preferences.set(savePreferences({ screen: profile }));
    this.profileChange = this.profileChange.then(() => this.applyProfile(this.profile, true));
    return this.profileChange;
  }
  private async applyProfile(profile: ScreenProfile, inPlace = false) {
    const track = this.screenTracks.find((t) => t instanceof LocalVideoTrack);
    if (!(track instanceof LocalVideoTrack)) return;
    const generation = this.screenGeneration;
    try {
      // Слои запоминаются до смены захвата: подпорки записаны в пикселях того кадра.
      if (inPlace) rememberLayout(track);
      const size = fitSource(this.captureSize.width, this.captureSize.height, profile.resolution);
      await track.mediaStreamTrack.applyConstraints({
        width: { max: size.width },
        height: { max: size.height },
        frameRate: { max: profile.fps },
      });
      track.mediaStreamTrack.contentHint = profile.automatic ? 'detail' : 'motion';
      if (this.disposed || generation !== this.screenGeneration) return;
      if (inPlace && (await retune(track, profile).catch(() => false))) return;
      await this.room.localParticipant.unpublishTrack(track, false);
      if (this.disposed || generation !== this.screenGeneration) return;
      await this.room.localParticipant.publishTrack(track, {
        ...screenOptions(profile, this.codec),
        source: Track.Source.ScreenShare,
      });
      if (this.disposed || generation !== this.screenGeneration) {
        await this.room.localParticipant.unpublishTrack(track, true);
        return;
      }
      this.refreshTracks();
    } catch (error) {
      this.report(error);
    }
  }
  get requestedProfile() {
    return this.profile;
  }
  /**
   * Наблюдение за отдачей — всё время, пока идёт разговор.
   *
   * Раньше этот опрос заводился внутри публикации экрана и вместе с ней умирал. Значит,
   * обычный звонок с одной камерой не спрашивал кодировщик ни разу: «Авто» для камеры не
   * поднималось и не опускалось, оно просто равнялось одному числу из настроек по умолчанию.
   * Отсюда и жалоба, что вручную выставленное качество лучше автоматического.
   */
  private startUpstreamMonitor() {
    clearInterval(this.qualityTimer);
    this.encoderHealth = new EncoderHealth();
    this.upstreamCounters = undefined;
    this.qualityTimer = setInterval(() => void this.sampleUpstream(), 3000);
  }
  /** Дорожка, по которой судим об отдаче: показываемый экран важнее камеры. */
  private leadingVideo(): { track: LocalVideoTrack; source: 'camera' | 'screen' } | null {
    const screen = this.screenTracks.find((t) => t instanceof LocalVideoTrack);
    if (screen instanceof LocalVideoTrack) return { track: screen, source: 'screen' };
    const camera = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    return camera instanceof LocalVideoTrack ? { track: camera, source: 'camera' } : null;
  }
  private async sampleUpstream() {
    if (this.disposed || this.upstreamSampling || this.state.get().status !== 'connected') return;
    const leading = this.leadingVideo();
    if (!leading) {
      this.upstreamCounters = undefined;
      if (this.outbound.get()) this.outbound.set(null);
      return;
    }
    this.upstreamSampling = true;
    const cycle = this.connectionCycle;
    try {
      const report = await leading.track.getRTCStatsReport();
      if (this.disposed || cycle !== this.connectionCycle) return;
      let limitation = 'none';
      let available: number | null = null;
      let width = 0;
      let height = 0;
      let fps = 0;
      let bytes = 0;
      let at = 0;
      let dormant = false;
      report?.forEach((stat) => {
        if (stat.type === 'candidate-pair' && typeof stat.availableOutgoingBitrate === 'number')
          available = stat.availableOutgoingBitrate;
        if (stat.type !== 'outbound-rtp' || (stat.kind ?? stat.mediaType) !== 'video') return;
        if (typeof stat.qualityLimitationReason === 'string' && stat.qualityLimitationReason !== 'none')
          limitation = stat.qualityLimitationReason;
        bytes += Number(stat.bytesSent ?? 0);
        at = Math.max(at, Number(stat.timestamp ?? 0));
        if (stat.active === false) dormant = true;
        // Слоёв может быть несколько; «что мы отдаём» — это самый крупный из них.
        const frame = Number(stat.frameWidth ?? 0);
        if (frame >= width) {
          width = frame;
          height = Number(stat.frameHeight ?? 0);
          fps = Number(stat.framesPerSecond ?? 0);
        }
      });
      const previous = this.upstreamCounters;
      const seconds = previous && at > previous.at ? (at - previous.at) / 1000 : 0;
      this.upstreamCounters = { at, bytes };
      if (width)
        this.outbound.set({
          source: leading.source,
          width,
          height,
          fps: Math.round(fps),
          mbps: seconds > 0 ? Math.max(0, ((bytes - previous!.bytes) * 8) / seconds / 1000000) : 0,
          limitation,
          targetFps:
            leading.source === 'screen'
              ? this.profile.fps
              : this.cameraRole === 'companion'
                ? companionCamera.fps
                : // Сравнивать надо с тем, что просили у кодировщика сейчас, а не с выбором:
                  // иначе временная уступка читалась бы как «камера не даёт столько кадров».
                  this.cameraSending.fps,
          dormant,
        });
      // Новые кодеки красивее, но стоят дороже. Три жалобы подряд на процессор означают, что
      // этот обмен не удался, и совместимый кодек лучше испорченной картинки.
      const advanced =
        leading.source === 'screen'
          ? this.codec === 'av1' || this.codec === 'vp9'
          : this.cameraCodec === 'av1' || this.cameraCodec === 'vp9';
      if (this.encoderHealth.observe(limitation, advanced)) {
        if (leading.source === 'screen') {
          this.codec = 'vp8';
          void this.setProfile(this.profile);
          this.report(new Error('Кодировщик перегружен. Переключаем экран на совместимый кодек.'));
        } else {
          this.cameraCodec = 'vp8';
          this.cameraCodecChosen = Promise.resolve('vp8' as VideoCodec);
          void this.setCameraProfile(this.cameraProfile);
          this.report(new Error('Кодировщик перегружен. Переключаем камеру на совместимый кодек.'));
        }
        return;
      }
      // Кодировщику тесно — уступают по очереди, и первой уступает камера. Выбранный
      // вручную уровень при этом не двигается: это указание, а не совет.
      this.applyUpstream(this.budget.observe(this.upstreamInputs(limitation, available)));
    } catch {
      // Статистика — не право говорить: её отсутствие ничего не должно остановить.
    } finally {
      this.upstreamSampling = false;
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.screenPublishAbort?.abort();
    this.liveAbort.abort();
    this.generation++;
    this.screenGeneration++;
    this.recovery.stop();
    this.liveHealth.clear();
    this.lastLiveReset.clear();
    clearInterval(this.liveTimer);
    clearInterval(this.playoutTimer);
    clearTimeout(this.liveNoticeTimer);
    clearInterval(this.deadlineTimer);
    clearTimeout(this.reconnectTimer);
    clearInterval(this.qualityTimer);
    window.removeEventListener('online', this.network);
    document.removeEventListener('visibilitychange', this.screenAwake);
    window.removeEventListener('cord:preferences', this.settingsChanged);
    this.previewSource.stop();
    this.previewImages.clear();
    this.screenPreviews.set({});
    this.speaking.set([]);
    this.screenTracks.forEach((t) => t.stop());
    this.deviceTracks.forEach((t) => t.stop());
    this.deviceTracks.clear();
    this.screenTracks = [];
    void this.room.disconnect(true);
    this.tracks.set([]);
    this.patch({ status: 'ended', screen: false, camera: false, microphone: false });
  }
}
