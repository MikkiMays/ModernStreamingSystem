import {
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  LocalVideoTrack,
  LocalAudioTrack,
  ConnectionQuality,
  DisconnectReason,
  type Participant,
  type LocalTrack,
  type VideoCodec,
  createLocalAudioTrack,
  RemoteAudioTrack,
} from 'livekit-client';
import { ApiError, type RoomApi } from '../api/client';
import { Store } from '../core/store';
import { RecoveryWindow } from '../core/recovery';
import { isDesktop } from '../core/desktop';
import {
  chooseCodec,
  chooseCameraCodec,
  fallbackCodec,
  cameraHint,
  fitSource,
  screenHint,
  screenOptions,
  type ScreenMode,
  cameraCapture,
  touchFirst,
  cameraOptions,
  forcedCameraConstraints,
  type ScreenProfile,
} from './profiles';
import { rememberLayout, retune } from './retune';
import { settleMs } from './capabilities';
import { readScreenSample, ScreenReadiness } from './screen-ready';
import { reconnectAction, type ReconnectTrigger } from './reconnect-plan';
import {
  readPreferences,
  savePreferences,
  type AudioPreferences,
  type Preferences,
} from '../core/preferences';
import { signal } from '../core/sounds';
import { recallVolume, rememberVolume } from '../core/volumes';
import { SpeechDownmix } from './downmix';
import { receivedLevel, waitForPause } from './speech-pause';
import { applyVolumeNow } from './volume';
import { audioCapture, CordAudioProcessor, microphoneOptions, needsAudioProcessor } from './audio';
import { VoiceLevels } from './levels';
import {
  browserCapture,
  ownAudioLeaks,
  type CaptureAdapter,
  type ScreenAudioEvent,
  type ScreenAudioSource,
} from './capture';
import { EncoderHealth } from './encoder-health';
import { LiveHealth } from './live-health';
import { VideoPauses } from './video-pause';
import { VideoSilence } from './video-silence';
import { linkChanged, unknownLink, type LinkState } from './link-quality';
import { PathRetry, starvedUplink } from './path-retry';
import { LocalNetworks } from './local-networks';
import { udpOpen } from './udp-probe';
import type { PlayoutClass } from './playout';
import { PlayoutController, type PlayoutTrack } from './playout-control';
import { CallQuality, type CallReport } from './call-quality';
import { RxQuality, type RxSummary } from './rx-quality';
import { waitForPublishPermissions } from './publish-permissions';
import { PreviewImages, ScreenPreviewSource, encodePreview, decodePreview } from './screen-preview';
import { currentPlatform, type Platform } from './platform';
import {
  AudioWaker,
  MicInterruptions,
  PageLifecycle,
  ScreenWake,
  wantsWakeLock,
  type MicGap,
  type ReturnInfo,
} from './background';
import { choosePipSource, PictureInPicture } from './pip';
import { readZoom, type Zoom } from './cameras';
import { t } from '../i18n';

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
  /**
   * `qualityLimitationReason`: почему кодировщик отдаёт меньше, чем его просили. `unknown` — браузер
   * её не называет (Safari).
   */
  limitation: string;
  /**
   * Какую частоту у этой дорожки просили. Нужна, чтобы отличить «кодировщику тесно» от
   * «источник столько и не даёт»: кодировщик о втором не сообщает ничего — с его точки
   * зрения он успевает за всем, что ему приносят.
   */
  targetFps: number;
  /** Сколько кадров даёт сама камера или экран (`getSettings().frameRate`), если браузер говорит. */
  sourceFps?: number;
  /**
   * Есть ли слой, который опубликован, но сейчас не отправляется.
   *
   * Так выглядит dynacast: пока никто не смотрит крупно, верхний слой спит, и в сеть уходит
   * тот, что помельче. Это не понижение качества — стоит кому-нибудь развернуть плитку, и
   * слой проснётся, — но без этого признака плашка показывала бы 720p при выбранном 1080p
   * и читалась бы как «настройка не применилась».
   */
  dormant: boolean;
  /**
   * Идёт ли ещё окно разгона после публикации или смены уровня. Пока идёт, теснота канала —
   * расписание, а не поломка, и плашка называет её разгоном (`outbound-note.ts`).
   */
  settling: boolean;
}

/** Network Information API: есть в Chrome на Android, нет в Safari и Firefox. */
function connection(): EventTarget | undefined {
  return (navigator as Navigator & { connection?: EventTarget }).connection;
}
/**
 * Свой `AudioContext` для звука собеседников, а не созданный SDK.
 *
 * ЗАЧЕМ (E12). SDK создаёт контекст сам при каждом подключении и закрывает его при обрыве: после
 * полного переподключения — а на телефоне оно случается после фона — новый контекст рождается без
 * жеста человека и на iOS молчит до первого касания. Свой контекст живёт всю встречу, переживает
 * переподключения, и разбудить его после фона или обычного звонка можем мы сами (`AudioWaker`).
 * `latencyHint` — как у SDK.
 */
function createAudioContext(): AudioContext | null {
  const Context =
    typeof window !== 'undefined'
      ? (window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
  if (!Context) return null;
  try {
    return new Context({ latencyHint: 'interactive' });
  } catch {
    return null;
  }
}

/** Звук показа от оболочки (E01-B3) на время одного показа. */
interface ScreenAudioLink {
  unwatch: () => void;
  /** Дорожка от оболочки; пока видео не опубликовано — ждёт его. */
  track?: MediaStreamTrack;
  published?: LocalTrack;
  /** Видео показа опубликовано — звук можно публиковать рядом. */
  live: boolean;
  /** Показ кончился: опоздавшая дорожка останавливается. */
  closed: boolean;
  abort: AbortController;
  linger?: ReturnType<typeof setTimeout>;
}

/** This is the only owner of the Room and capture tracks. React only subscribes. */
/** Сколько ждать новой дорожки показа после снятия старой, прежде чем счесть показ оконченным. */
export const SCREEN_GONE_GRACE_MS = 400;

/** Сколько байт медиа пришло всего по отчётам опроса — растёт между опросами, значит, путь жив. */
export function inboundBytes(reports: readonly RTCStatsReport[], kind?: 'audio' | 'video') {
  let total = 0;
  for (const report of reports)
    report.forEach((stat) => {
      if (stat.type !== 'inbound-rtp' || typeof stat.bytesReceived !== 'number') return;
      if (kind && (stat.kind ?? stat.mediaType) !== kind) return;
      total += stat.bytesReceived;
    });
  return total;
}
/** Музыку переподписывать по раздутому буферу — не чаще раза в минуту (R118): каждая — провал звука. */
export const MEDIA_RESET_GAP_MS = 60000;

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
  });
  readonly tracks = new Store<MediaTile[]>([]);
  readonly volumes = new Store<Record<string, number>>({});
  readonly deafened = new Store(false);
  /** Что мы отдаём прямо сейчас, по измерению, а не по настройке. */
  readonly outbound = new Store<OutboundVideo | null>(null);
  /**
   * Кто сейчас говорит — по данным SFU: сглажено и с задержкой сервера. Им выбирается крупный план
   * в раскладке «Говорящий» (там задержка — достоинство: плитка не прыгает на каждом «угу»), а
   * обводки плиток, списка и лиц в играх читают `levels`.
   */
  readonly speaking = new Store<string[]>([]);
  /** Громкость голоса каждого — меряет сам зритель, без сети (T23, `media/levels.ts`). */
  readonly levels = new VoiceLevels(this.tracks, this.speaking);
  /** Последний кадр чужой демонстрации: participantId → ссылка на картинку. */
  readonly screenPreviews = new Store<Record<string, string>>({});
  /**
   * Чей показ, который мы смотрели, только что кончился (R81): событие со счётчиком, а не
   * значение — два подряд конца показа одного и того же человека различимы. SFU сообщает об
   * этом через `TrackUnpublished` за ~50–100 мс — раньше, чем ядро пришлёт снимок без экрана.
   *
   * Снятие дорожки — ещё не конец показа: смена качества, режима или кодека, откат кодека и
   * переподключение стримящего переопубликовывают ту же демонстрацию. Поэтому ждём
   * {@link SCREEN_GONE_GRACE_MS}: появилась новая дорожка показа — это была переопубликация.
   */
  readonly screenGone = new Store<{ identity: string; seq: number } | null>(null);
  private screenGoneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private noteScreenGone(identity: string) {
    clearTimeout(this.screenGoneTimers.get(identity));
    this.screenGoneTimers.set(
      identity,
      setTimeout(() => {
        this.screenGoneTimers.delete(identity);
        if (this.disposed) return;
        const participant = this.room.remoteParticipants.get(identity);
        const sharing =
          !!participant &&
          [...participant.trackPublications.values()].some((p) => p.source === Track.Source.ScreenShare);
        if (sharing) return;
        this.screenGone.update((previous) => ({ identity, seq: (previous?.seq ?? 0) + 1 }));
      }, SCREEN_GONE_GRACE_MS),
    );
  }
  private screenCameBack = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (publication.source !== Track.Source.ScreenShare) return;
    clearTimeout(this.screenGoneTimers.get(participant.identity));
    this.screenGoneTimers.delete(participant.identity);
  };
  private pauses = new VideoPauses();
  /**
   * Чьё видео SFU сейчас приостановил нам из-за слабого канала (R117, `video-pause.ts`): trackSid →
   * true, уже после задержки против мигания и без надписей, пока сами переподключаемся. Читают
   * плитки и показ; камера и экран — одинаково.
   */
  readonly videoPaused = this.pauses.shown;
  /** Сколько пауз видео за встречу дошло до надписи — для «Диагностики». */
  readonly videoPauseCount = this.pauses.total;
  /** Каким путём идёт медиа и насколько ровно. Для показа и для выбора запаса буфера. */
  readonly link = new Store<LinkState>(unknownLink);
  /** На какой платформе идёт встреча — для правил фона (E12, `media/background.ts`). */
  readonly platform: Platform = currentPlatform();
  /**
   * Микрофон захвачен: включён или удержан выключенным ({@link holdMicrophone}). Именно захват держит
   * разговор в фоне на телефоне — Android поднимает на него свой foreground service, Safari оставляет
   * аудиосессию (`docs/mobile.md` §1).
   */
  readonly captured = new Store(false);
  /** Телефон глушил включённый микрофон, пока страница была не на экране (W4). Плашка гасит сама. */
  readonly micGap = new Store<MicGap | null>(null);
  /** «Свернуть в окно» (W2). */
  readonly pip = new PictureInPicture();
  private audioContext = createAudioContext();
  /** Звук собеседников стоит и ждёт касания — после фона, обычного звонка, перезагрузки. */
  readonly audio = new AudioWaker(this.audioContext);
  /** Голос — в оба уха, как бы его ни прислали (R113, `downmix.ts`). */
  private downmix = new SpeechDownmix(this.audioContext);
  private wake = new ScreenWake();
  private micGaps = new MicInterruptions();
  private watchedMic: MediaStreamTrack | null = null;
  private micGapTimer?: ReturnType<typeof setTimeout>;
  private lifecycle: PageLifecycle;
  private previousVolumes = new Map<string, number>();
  /** Номер участника → устойчивый ключ в памяти громкостей. См. `core/volumes.ts`. */
  private volumeKeys = new Map<string, string>();
  private volumeRoom = '';
  private watchedParticipant: string | null = null;
  watchScreen(participantId: string | null) {
    this.watchedParticipant = participantId;
    this.syncSubscriptions();
    this.syncBackground();
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
  /**
   * Кадр превью чужого показа — от ядра (`preview` в сокете комнаты), не из канала данных SFU:
   * права на данные LiveKit участникам не выдаются (`CanPublishData(false)`), и `publishData`
   * молча терялся — это и был «только зелёный фон» (R07).
   */
  acceptPreview(participantId: string, image: string) {
    if (this.disposed || !image) return;
    const bytes = decodePreview(image);
    if (!bytes.byteLength) return;
    const url = this.previewImages.accept(participantId, bytes);
    this.screenPreviews.update((previews) => ({ ...previews, [participantId]: url }));
  }
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
    // Превью выключено в окне выбора экрана (R80): кадры не снимаются и не уходят.
    if (!(track instanceof LocalVideoTrack) || this.profile.preview === false) {
      this.previewSource.stop();
      return;
    }
    this.previewSource.start(track.mediaStreamTrack, (bytes) => {
      if (this.disposed || this.room.state !== 'connected') return;
      // Через ядро (`screen.preview`): оно проверяет, что кадр шлёт показывающий, и раздаёт
      // его сокетам комнаты мимо журнала событий. Ответ не нужен — следующий кадр через 5 с.
      void this.api
        .command({ type: 'screen.preview', commandId: crypto.randomUUID(), image: encodePreview(bytes) })
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
  private cameraChange: Promise<void> = Promise.resolve();
  private cameraProfilePending = false;
  /** Окно разгона — с сервера (`capabilities.quality.settleMs`): готовность показа ждёт не дольше него. */
  private readonly settleMs = settleMs();
  /** Когда дорожку в последний раз опубликовали или сменили ей уровень — для окна разгона. */
  private videoChangedAt = { camera: 0, screen: 0 };
  /** Когда в последний раз просили SDK пройти resume по знаку сети (`reconnect-plan.ts`). */
  private lastNudge = -Infinity;
  /** Медиа застряло на TCP или в узком канале — когда пробовать путь лучше (`path-retry.ts`). */
  private pathRetry = new PathRetry();
  private localNetworks = new LocalNetworks();
  /** Включали ли камеру в этой встрече: первое включение на телефоне — всегда фронтальная. */
  private cameraStarted = false;
  private codec: VideoCodec = 'vp8';
  /**
   * Кодек камеры. Здесь годами стоял жёсткий VP8, который почти нигде не кодируется железом —
   * отсюда и «заявлено 60 fps, идёт 40». Выбирается один раз на сессию: смена кодека требует
   * переговоров, и делать это по ходу разговора ради одного и того же ответа незачем.
   */
  private cameraCodec: VideoCodec = 'vp8';
  private cameraCodecChosen?: Promise<VideoCodec>;
  /** Основной кодек камеры, выбранный по силам машины (`chooseCameraCodec`): на него сторож возвращает. */
  private cameraPreferredCodec?: VideoCodec;
  /** Камера сейчас на запасном H.264 после отступа сторожа, а не по изначальному выбору. */
  private cameraFellBack = false;
  /** То же для показа: выбранный кодек и флаг отступа (общий сторож — `EncoderHealth`). */
  private screenPreferredCodec?: VideoCodec;
  private screenFellBack = false;
  /** Десктоп публикует камеру и показ пространственными слоями (Р-36); телефон и веб — одним (Р-32). */
  private readonly spatialDesktop = isDesktop();
  private screenBusy = false;
  private screenPublishAbort?: AbortController;
  /** Звук показа от оболочки (E01-B3) — у идущего показа и у кончившегося, что ждёт опоздавшую дорожку. */
  private screenAudio?: ScreenAudioLink;
  private lingeringAudio?: ScreenAudioLink;
  /** «Нажми и говори»: каким микрофон должен стать — побеждает последнее нажатие или отпускание. */
  private micTarget = false;
  private micSetting?: Promise<void>;
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
  private liveSampling = false;
  private liveHealth = new Map<string, LiveHealth>();
  /** Камеры, у которых кадры из сети могли остановиться без слова SFU (R119, `video-silence.ts`). */
  private videoSilence = new Map<string, VideoSilence>();
  /** Приходили ли байты звука за последний опрос буфера — свидетель того, что путь жив. */
  private audioFlowing = false;
  private lastLiveReset = new Map<string, number>();
  /** Сумма принятых байт по всем дорожкам на прошлом опросе: растёт — медиа идёт. */
  private lastInboundBytes = 0;
  private lastAudioBytes = 0;
  /** Голоса, чья переподписка ждёт паузы говорящего. */
  private pausing = new Set<string>();
  private resetting = new Set<string>();
  private liveAbort = new AbortController();
  private playout = new PlayoutController();
  /** Итог звонка для владельца сервера (`client-report`): копится из того же опроса, что и буфер. */
  private callQuality = new CallQuality();
  /** Сводка приёма раз в 10 с для метров ядра (`rooms/{id}/quality`) — из того же опроса. */
  private rxQuality = new RxQuality();
  /** Кому отдать готовую сводку приёма; задаёт `core/meeting.ts`. */
  onRxQuality?: (summary: RxSummary) => void;
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
  private subscriptions: (() => void)[] = [];
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
      webAudioMix: this.audioContext ? { audioContext: this.audioContext } : true,
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
      publishDefaults: cameraOptions(this.cameraProfile, 'vp8', this.spatialDesktop),
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
              ? t(($) => $.media.end.duplicate)
              : // Исключение — это конец встречи, а не запрет: войти снова можно тем же путём,
                // что и в первый раз. Прежний вход при этом мёртв, и это разные вещи.
                reason === DisconnectReason.PARTICIPANT_REMOVED
                ? t(($) => $.media.end.removed)
                : t(($) => $.media.end.revoked),
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
      .on(RoomEvent.TrackPublished, this.screenCameBack)
      .on(RoomEvent.ParticipantConnected, this.syncSubscriptions)
      .on(RoomEvent.TrackSubscribed, this.configurePlayout)
      .on(RoomEvent.TrackSubscribed, this.refreshTracks)
      .on(RoomEvent.TrackUnsubscribed, (_track, publication?: RemoteTrackPublication) => {
        if (publication) {
          this.playout.forget(publication.trackSid);
          this.downmix.forget(publication.trackSid);
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
      .on(RoomEvent.ParticipantDisconnected, (participant) => this.dropPreview(participant.identity))
      .on(RoomEvent.TrackUnpublished, (publication, participant) => {
        if (publication.source === Track.Source.ScreenShare) {
          this.dropPreview(participant.identity);
          if (this.watchedParticipant === participant.identity) this.noteScreenGone(participant.identity);
        }
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
      .on(RoomEvent.TrackUnmuted, this.refreshTracks)
      .on(RoomEvent.TrackStreamStateChanged, (publication, state) => {
        if (this.disposed || publication.kind !== Track.Kind.Video) return;
        if (state === Track.StreamState.Paused)
          this.pauses.pause(publication.trackSid, this.playout.targetFor(publication.trackSid));
        else this.pauses.resume(publication.trackSid);
      });
    window.addEventListener('online', this.network);
    // Сменилась сеть (Wi-Fi ↔ сотовая) — Chrome на Android говорит об этом сам, а `online` при этом
    // не приходит: браузер и до, и после «в сети». Safari такого события не знает — там путь
    // возвращает `pathRetry`.
    connection()?.addEventListener?.('change', this.network);
    // Экран погас, браузер свёрнут или заморожен — и вернулся: см. «звонок в кармане» ниже.
    this.lifecycle = new PageLifecycle({ hidden: this.wentAway, returned: this.cameBack });
    this.subscriptions.push(
      this.tracks.subscribe(this.syncBackground),
      this.state.subscribe(this.syncBackground),
      this.speaking.subscribe(this.syncBackground),
      this.captured.subscribe(this.syncBackground),
    );
    window.addEventListener('cord:preferences', this.settingsChanged);
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
    this.syncDownmix();
    void this.tunePlayout();
  }
  /**
   * Речь — моно на приёме, музыка и звук показа — как есть (R113). Зовётся при подписке и когда
   * ядро сообщило, кто в комнате служебный: бот музыки публикует «микрофон», и пока о нём не
   * знали, его звук мог получить сведение — тогда оно снимается.
   */
  private syncDownmix(only?: string) {
    for (const participant of this.room.remoteParticipants.values())
      for (const publication of participant.trackPublications.values()) {
        const track = publication.track;
        if (!(track instanceof RemoteAudioTrack) || (only && publication.trackSid !== only)) continue;
        const speech =
          this.playoutKind(participant.identity, publication.source, track.kind) === 'conversation';
        // Цепочка пересобрана — LiveKit завёл новый узел громкости на 1: выставить громкость участника
        // сразу, иначе заглушённый собеседник прозвучал бы (T49, `volume.ts`).
        if (this.downmix.sync(publication.trackSid, track, speech) && track.attachedElements.length)
          applyVolumeNow(
            track as unknown as Parameters<typeof applyVolumeNow>[0],
            this.volumes.get()[participant.identity] ?? 1,
          );
      }
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
  /** Отчёт первой своей дорожки — по нему путь виден, даже когда принимать нечего. */
  private sendingStats = async () => {
    for (const publication of this.room.localParticipant.trackPublications.values())
      if (publication.track) return publication.track.getRTCStatsReport();
    return undefined;
  };
  private async tunePlayout() {
    if (this.disposed || this.playoutSampling || this.state.get().status !== 'connected') return;
    this.playoutSampling = true;
    const cycle = this.connectionCycle;
    try {
      const reports = await this.playout.tick(this.playoutTracks(), Date.now(), this.sendingStats);
      if (this.disposed || cycle !== this.connectionCycle) return;
      // Буфер звука раздуло пачкой далеко за потолок: NetEq выбрасывал бы звук секунды подряд.
      // Переподписка той же пары дорожек ставит всё на место за доли секунды (не чаще раза в 30 с).
      for (const report of reports)
        if (report.resync && report.kind !== 'video') {
          const found = this.findPublication(report.id);
          if (!found) continue;
          if (report.kind === 'conversation')
            void this.resyncSpeechInPause(found.identity, found.publication, report.measuredMs ?? 0);
          else void this.resetLivePair(found.identity, found.publication.source, true, MEDIA_RESET_GAP_MS);
        }
      this.callQuality.observe(this.playout.link, this.playout.reports, Date.now());
      this.rxQuality.observe(this.playout.samples, Date.now());
      const summary = this.rxQuality.flush(Date.now());
      if (summary) this.onRxQuality?.(summary);
      // Каждый опрос возвращает новый объект, поэтому сравнивать надо по значению: иначе
      // открытые настройки и диагностика перерисовывались бы каждые две секунды впустую.
      if (linkChanged(this.link.get(), this.playout.link)) this.link.set(this.playout.link);
      // ICE в `disconnected` — путь умер (чаще всего сменился адрес), а SDK ждёт `failed`. Но пока
      // пакеты приходят, это не смерть пути, а очередь узкого канала (R119, `reconnect-plan.ts`).
      const inbound = inboundBytes(this.playout.reports);
      const flowing = inbound > this.lastInboundBytes;
      this.lastInboundBytes = inbound;
      const audio = inboundBytes(this.playout.reports, 'audio');
      this.audioFlowing = audio > this.lastAudioBytes;
      this.lastAudioBytes = audio;
      if (this.playout.link.ice === 'disconnected') this.nudge('ice-disconnected', flowing);
      const sending = this.outbound.get();
      const retry = this.pathRetry.observe(
        {
          connected: this.playout.link.ice === 'connected',
          ordered: this.playout.link.ordered,
          starved: starvedUplink(sending),
        },
        Date.now(),
      );
      if (retry) void this.restartIce();
      else if (this.pathRetry.troubled) void this.watchNetworks();
      else this.localNetworks.reset();
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
    // До того как Stage подключит дорожку к элементу: сведение встаёт без пересборки цепочки.
    if (track.kind === Track.Kind.Audio) this.syncDownmix(publication.trackSid);
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
              // Видео приостановил SFU (R117): кадров нет по его решению, а не от зависания. Переподписка
              // ничего не починит — пауза снимется сама, — поэтому сторож зависаний молчит, а после паузы
              // начинает с чистого листа. Счётчик принятых кадров — запасной знак, что картинка пошла.
              let received = 0;
              report?.forEach((stat) => {
                if (stat.type === 'inbound-rtp' && (stat.kind ?? stat.mediaType) === 'video')
                  received += Number(stat.framesReceived ?? 0);
              });
              if (this.pauses.holds(publication.trackSid)) {
                this.liveHealth.delete(publication.trackSid);
                this.videoSilence.delete(publication.trackSid);
                this.pauses.frames(publication.trackSid, received);
                return;
              }
              // SFU перестал слать камеру, не сказав «пауза» (R119): кадров нет, а звук идёт.
              if (publication.source === Track.Source.Camera) {
                const silence = this.videoSilence.get(publication.trackSid) ?? new VideoSilence();
                this.videoSilence.set(publication.trackSid, silence);
                if (silence.observe(received, this.audioFlowing, Date.now())) {
                  this.pauses.pause(publication.trackSid, this.playout.targetFor(publication.trackSid));
                  this.liveHealth.delete(publication.trackSid);
                  return;
                }
              }
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
      for (const key of this.videoSilence.keys()) if (!active.has(key)) this.videoSilence.delete(key);
      for (const key of this.lastLiveReset.keys())
        if (!this.room.remoteParticipants.has(key.split(':')[0]!)) this.lastLiveReset.delete(key);
    } finally {
      this.liveSampling = false;
    }
  }
  /** Итог звонка: числа и слова из перечислений, без имён и адресов; `null` — звонка не было. */
  callReport(): CallReport | null {
    return this.callQuality.summary();
  }
  /** Какой запас буфера мы сейчас просим по каждой дорожке. Для диагностики. */
  playoutTargets() {
    return this.playout.targets();
  }
  /**
   * На сколько миллисекунд музыка у нас отстаёт от издателя по нашей же просьбе (R03).
   *
   * Позиция, которую сообщает издатель, — время отправки; слышим мы её на столько позже.
   * Игла плеера вычитает это число, чтобы совпадать со звуком. Ноль — музыки не слышно.
   */
  musicPlayoutMs(): number {
    for (const participant of this.room.remoteParticipants.values()) {
      if (!this.serviceParticipants.has(participant.identity)) continue;
      for (const publication of participant.audioTrackPublications.values())
        if (publication.isSubscribed && publication.track)
          return this.playout.targetFor(publication.trackSid);
    }
    return 0;
  }
  private findPublication(trackSid: string) {
    for (const participant of this.room.remoteParticipants.values()) {
      const publication = participant.trackPublications.get(trackSid);
      if (publication) return { identity: participant.identity, publication };
    }
    return null;
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
        this.cameraPreferredCodec = codec;
        this.cameraFellBack = false;
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
    return cameraCapture(this.cameraProfile, this.cameraCapabilities());
  }
  private cameraOptionsNow() {
    return cameraOptions(this.cameraProfile, this.cameraCodec, this.spatialDesktop);
  }
  /** Подсказать кодировщику, что в этом кадре важнее — движение или резкость. */
  private applyCameraHint() {
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (track instanceof LocalVideoTrack) track.mediaStreamTrack.contentHint = cameraHint;
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
    if (!(track instanceof LocalVideoTrack)) return;
    const media = track.mediaStreamTrack;
    // `applyConstraints` заменяет набор целиком: зум (`applyCameraZoom`) едет вместе с кадром,
    // иначе смена частоты сбросила бы его.
    const zoom = (media.getConstraints?.().advanced ?? []).filter((set) => 'zoom' in set);
    // Просьбы идут от самой строгой к самой мягкой; первая исполненная и остаётся. Отказ
    // ничего не ломает: дорожка такая же, какой была, а недобор виден в плашке.
    for (const wanted of forcedCameraConstraints(this.cameraProfile, this.cameraCapabilities())) {
      try {
        await media.applyConstraints(zoom.length ? { ...wanted, advanced: zoom } : wanted);
        return;
      } catch {
        /* Камера не умеет столько при этом кадре — пробуем следующую просьбу. */
      }
    }
  }
  /** Подстроить слои работающей камеры под выбранный уровень, не трогая захват. */
  private async retuneCamera(track: LocalVideoTrack, level: ScreenProfile): Promise<boolean> {
    if (!rememberLayout(track)) return false;
    if (!(await retune(track, level))) return false;
    track.mediaStreamTrack.contentHint = cameraHint;
    this.videoChangedAt.camera = performance.now();
    return true;
  }
  /**
   * Вернуть камере текущую ступень после смены устройства. LiveKit после `restartTrack`
   * пересчитывает слои от параметров публикации — то есть от уровня, с которым камеру
   * включили, а не от того, на котором лестница стоит сейчас.
   */
  private async reapplyCameraLevel() {
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (!(track instanceof LocalVideoTrack)) return;
    await this.retuneCamera(track, this.cameraProfile).catch(() => false);
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
  /**
   * Переподписать раздутый голос, когда в буфере одна тишина (R107, `speech-pause.ts`).
   *
   * Переподписка выбрасывает всё, что лежит в буфере, а лежат там последние `bufferedMs` пришедшего
   * звука — значит, пауза нужна не «сейчас», а длиной во весь буфер: громкость пришедших пакетов
   * тише 0,01 и SFU не считает человека говорящим `bufferedMs + 300` мс подряд. Так бывает, когда
   * говорит кто-то другой. Не дождались за 20 с — не переподписываем: NetEq догонит сам, а
   * выброшенная фраза — это и есть «звук обрезается».
   */
  private async resyncSpeechInPause(
    identity: string,
    publication: RemoteTrackPublication,
    bufferedMs: number,
  ) {
    if (this.pausing.has(publication.trackSid)) return;
    this.pausing.add(publication.trackSid);
    try {
      const paused = await waitForPause(
        () =>
          this.room.remoteParticipants.get(identity)?.isSpeaking
            ? 1
            : receivedLevel(publication.track?.receiver),
        { signal: this.liveAbort.signal, quietMs: Math.min(5000, bufferedMs + 300), withinMs: 20000 },
      );
      if (paused && !this.disposed) await this.resetLivePair(identity, publication.source, true);
    } finally {
      this.pausing.delete(publication.trackSid);
    }
  }
  /**
   * @param gapMs не чаще какого срока переподписывать автоматически: `automatic` сброс по умолчанию —
   *   раз в 30 с, музыка (R118) — раз в минуту: каждая переподписка — слышимый провал, и чаще раза
   *   в минуту это уже не починка.
   */
  private async resetLivePair(identity: string, source: Track.Source, automatic: boolean, gapMs = 30000) {
    // Пара экрана — и картинка, и её звук: сброс по любой из них не должен трогать камеру и микрофон.
    // Камера сбрасывается одна (R107): раньше вместе с ней переподписывался и микрофон, и зависшая
    // на плохом канале картинка оборачивалась провалом голоса — тем самым «звук обрезается».
    const screen = source === Track.Source.ScreenShare || source === Track.Source.ScreenShareAudio;
    const key = `${identity}:${screen ? 'screen' : source}`;
    if (this.resetting.has(key) || (automatic && Date.now() - (this.lastLiveReset.get(key) ?? 0) < gapMs))
      return;
    const participant = this.room.remoteParticipants.get(identity);
    if (!participant) return;
    const sources = screen ? [Track.Source.ScreenShare, Track.Source.ScreenShareAudio] : [source];
    const publications = [...participant.trackPublications.values()].filter(
      (p) => sources.includes(p.source) && p.isSubscribed && p.isEnabled && !p.isMuted,
    );
    if (!publications.length) return;
    this.resetting.add(key);
    this.lastLiveReset.set(key, Date.now());
    // Служебная переподписка — в журнал, не на сцену (R27): плашка «Обновляем прямой эфир…»
    // мигала поверх разговора и ничего не просила сделать.
    console.debug('[cord] live resubscribe', identity, screen ? 'screen' : source);
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
    this.patch({ error: error instanceof Error ? error.message : t(($) => $.media.actionFailed) });
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
        // R119. SFU 1.13.6 берёт это поле из запроса на вход **поверх** своего
        // `rtc.congestion_control.allow_pause`, а SDK до 2.22.4 поля не знал и слал нулевое —
        // значит, «нет»: пауза видео на слабом канале (R117) не наступала никогда, SFU давил в
        // узкий канал нижние слои картинки, и вместе с ними не проходили сигнал и речь.
        subscriberAllowPause: true,
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
    this.pathRetry.wake();
    this.nudge('online');
  };
  /**
   * Новый раунд ICE на живом соединении: по тому же сигнальному сокету, дорожки не трогаются, медиа
   * идёт по старой паре, пока не выбрана новая. Зачем и когда — `path-retry.ts`.
   */
  /** Пока путь плохой: появилась другая сеть (Wi-Fi на iPhone) — пробовать сразу (`local-networks.ts`). */
  private async watchNetworks() {
    if (!(await this.localNetworks.changed(Date.now())) || this.disposed) return;
    console.info('[cord] у устройства сменились сети — ищем путь заново');
    this.pathRetry.wake();
  }
  private async restartIce() {
    if (this.disposed || this.room.state !== 'connected') return;
    const { path, ordered } = this.link.get();
    // На TCP перезапуск только при открытом UDP: на закрытом он роняет видео на минуты (`udp-probe.ts`).
    if (ordered && !(await udpOpen(this.room.engine?.latestJoinResponse?.iceServers ?? []))) {
      console.info('[cord] UDP до сервера закрыт — путь не трогаем', { path });
      return;
    }
    if (this.disposed || this.room.state !== 'connected') return;
    console.info('[cord] ищем путь лучше — перезапуск ICE', { path });
    void this.room.engine?.pcManager?.triggerIceRestart().catch(() => {});
  }
  /**
   * Сеть подала знак — не ждать, пока SDK заметит сам.
   *
   * ЗАЧЕМ (T50). После смены адреса (VPN включили или выключили) SDK сидит «подключённым» до
   * таймаута пинга, а ICE он слушает только до `failed`; окно восстановления в двадцать секунд
   * за это время почти кончается. Что делать, решает `reconnect-plan.ts`: пока SDK «подключён» —
   * попросить его пройти свой бесшовный путь (новый сигнальный WS и ICE restart на тех же
   * дорожках) прямо сейчас; когда он сдался — наш полный `connect`, как и раньше. Пока он
   * переподключается сам, не мешать: по `online` у него есть своя немедленная попытка.
   *
   * `simulateScenario('signal-reconnect')` — единственная публичная ручка SDK, ведущая на
   * resume: она закрывает сигнальный сокет и пускает ту же цепочку, что срабатывает по таймауту
   * пинга, только сразу. Помечена «для тестов», но путь под ней — боевой.
   */
  private nudge(trigger: ReconnectTrigger, mediaFlowing?: boolean) {
    if (this.disposed) return;
    const action = reconnectAction({
      trigger,
      sdk: this.room.state,
      recovering: this.recovery.active,
      connecting: this.connecting,
      sinceNudgeMs: performance.now() - this.lastNudge,
      mediaFlowing,
    });
    if (action === 'connect') {
      clearTimeout(this.reconnectTimer);
      void this.start();
    } else if (action === 'resume') {
      this.lastNudge = performance.now();
      console.info('[cord] сеть сменилась — просим SDK пройти resume', { trigger });
      void this.room.simulateScenario('signal-reconnect').catch(() => {});
    }
  }
  /*
    ЗВОНОК В КАРМАНЕ.

    Пока на экран не смотрят, окно восстановления стоит: браузер в это время душит таймеры, а
    то и замораживает страницу целиком, и «не восстановилось за двадцать секунд» означало бы
    «человек убрал телефон в карман». Само переподключение при этом продолжается — его ведёт
    SDK, и мешать ему незачем.

    Вернулись к экрану — окно идёт дальше с того же остатка, а если связь так и не вернулась,
    человек увидит честный отсчёт и сможет что-то сделать. Заодно возвращение — хороший повод
    попробовать подключиться прямо сейчас, не дожидаясь очередной попытки по расписанию.

    Дорожки при уходе не трогаются вовсе (E12): микрофон остаётся захваченным — это и держит
    разговор в фоне, — подписки остаются, камеру на телефоне гасит и поднимает сам SDK. Если
    страницу замораживали (`ReturnInfo.frozen`), сигнальный сокет SDK, скорее всего, уже мёртв, и
    вместо ожидания таймаута пинга сразу просим бесшовный resume (`reconnect-plan.ts`, `woke`).
    Звук собеседников после фона и обычного звонка спит — будим его тут же.
  */
  private wentAway = () => {
    this.recovery.hold(true);
  };
  private cameBack = (info: ReturnInfo) => {
    if (this.disposed) return;
    this.recovery.hold(false);
    // На iPhone Wi-Fi включают в «Пункте управления» или «Настройках»: возврат на страницу — повод
    // снова поискать путь лучше, если нынешний плохой (`path-retry.ts`).
    this.pathRetry.wake();
    this.nudge(info.frozen ? 'woke' : 'visible');
    if (info.frozen)
      console.info('[cord] page returned from a freeze', {
        awayMs: Math.round(info.awayMs),
        restored: info.restored,
      });
    if (this.state.get().status === 'connected') void this.audio.wake();
    this.wake.refresh();
    // SDK по возвращении перезапускает заглушённый телефоном микрофон; рассказ о перерыве — когда
    // новая дорожка уже живая.
    clearTimeout(this.micGapTimer);
    this.micGapTimer = setTimeout(this.tellMicGap, 1500);
  };
  /**
   * Правила фона на каждое изменение: держать ли экран (`wantsWakeLock`) и что лежит в окне PiP.
   * Зовётся часто — оба получателя сами ничего не делают, если ответ не изменился.
   */
  private syncBackground = () => {
    if (this.disposed) return;
    const status = this.state.get().status;
    const tiles = this.tracks.get();
    this.wake.want(
      wantsWakeLock({
        inCall: status === 'connected' || status === 'recovering',
        visible: typeof document === 'undefined' || !document.hidden,
        video: tiles.some((tile) => tile.track.kind === Track.Kind.Video && !tile.muted),
        captured: this.captured.get(),
        platform: this.platform,
      }),
    );
    this.pip.update(
      choosePipSource(tiles, { watching: this.watchedParticipant, speaking: this.speaking.get() }),
    );
  };
  /** Следить за событиями ОС у дорожки микрофона: `mute` — телефон забрал звук (W4). */
  private watchMic(track: MediaStreamTrack | null) {
    if (track === this.watchedMic) return;
    this.watchedMic?.removeEventListener('mute', this.micMuted);
    this.watchedMic?.removeEventListener('unmute', this.micUnmuted);
    this.watchedMic = track;
    if (!track) return;
    track.addEventListener('mute', this.micMuted);
    track.addEventListener('unmute', this.micUnmuted);
    if (track.readyState === 'live' && !track.muted) this.micGaps.unmuted(Date.now());
  }
  private micMuted = () => this.micGaps.muted(Date.now(), this.wanted.microphone);
  private micUnmuted = () => this.micGaps.unmuted(Date.now());
  private tellMicGap = () => {
    if (this.disposed) return;
    this.collectTracks();
    const gap = this.micGaps.take(Date.now());
    if (gap) {
      console.info('[cord] the phone muted the microphone while away', gap);
      this.micGap.set(gap);
    }
  };
  /**
   * Нажатие «Включить звук»: разбудить свой контекст и элементы SDK. Звать из обработчика нажатия —
   * Safari будит звук только жестом.
   */
  async unlockAudio() {
    await Promise.all([this.audio.wake(), this.room.startAudio().catch(() => {})]);
    return this.audio.running;
  }
  /**
   * Телефон: захватить микрофон сразу, но выключенным (W5, решение архитектора 16).
   *
   * Вошедший с выключенным микрофоном раньше не захватывал его вовсе — и его вкладку в фоне не
   * держало ничто: ни foreground service Chrome, ни аудиосессия Safari (`docs/mobile.md` §3). Теперь
   * дорожка публикуется сразу заглушённой: в комнату не уходит ни звука, а «включить микрофон» —
   * это `unmute` той же дорожки, без нового запроса доступа. Так ведут себя нативные звонилки; цена —
   * индикатор микрофона ОС горит и при выключенном звуке.
   *
   * На ПК ничего не делает. Отказ в доступе — не ошибка встречи: разговор идёт как раньше, только
   * в фоне его не держит ничто.
   */
  async holdMicrophone(deviceId?: string) {
    if (!this.platform.mobile || this.disposed || this.deviceBusy.has('microphone')) return;
    if (this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track) return;
    this.deviceBusy.add('microphone');
    try {
      const track = await createLocalAudioTrack(
        audioCapture(this.preferences.get().audio, deviceId || this.preferences.get().devices.microphone),
      );
      if (this.disposed) {
        track.stop();
        return;
      }
      // Заглушить до публикации: в запросе на публикацию уходит `muted`, и сервер ни мгновения не
      // считает микрофон включённым.
      await track.mute();
      await this.room.localParticipant.publishTrack(track, {
        ...microphoneOptions(),
        source: Track.Source.Microphone,
      });
      if (this.disposed) track.stop();
    } catch (error) {
      console.warn('[cord] microphone was not held for the background', error);
    } finally {
      this.deviceBusy.delete('microphone');
      this.refreshTracks();
    }
  }
  private lost = () => {
    if (this.disposed) return;
    this.liveHealth.clear();
    this.videoSilence.clear();
    // Застывшее у всех объясняет плашка восстановления, а не «слабая связь» на каждой плитке.
    this.pauses.suspend();
    // Счётчики приёма новой сессии начнутся с нуля: разности со старыми — не сводка.
    this.rxQuality.reset();
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
        this.onEnd(t(($) => $.media.end.notRecovered, { count: this.recovery.durationMs / 1000 }));
      }
    }, 100);
  };
  private connected = () => {
    if (this.disposed) return;
    this.pathRetry.wake();
    if (this.recovery.active && this.recovery.remaining() <= 0) {
      this.dispose();
      this.onEnd(t(($) => $.media.end.recoveryExpired));
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
    // Звук собеседников: свой контекст переживает переподключение, но мог уснуть, пока его не было.
    if (typeof document === 'undefined' || !document.hidden) void this.audio.wake();
    this.patch({ status: 'connected', remaining: this.recovery.durationMs / 1000, error: null });
    this.restorePauses();
    this.startUpstreamMonitor();
    this.refreshTracks();
  };
  /**
   * Паузы видео после возврата связи — по тому, что знает SDK: после resume дорожки те же, и пауза,
   * которую SFU не снимал, остаётся; после полного переподключения дорожки новые, и о паузе SFU
   * скажет заново. События, пришедшие во время переподключения, SDK отдаёт уже после `Reconnected`.
   */
  private restorePauses() {
    const paused = new Set<string>();
    for (const participant of this.room.remoteParticipants.values())
      for (const publication of participant.trackPublications.values())
        if (
          publication.kind === Track.Kind.Video &&
          publication.track?.streamState === Track.StreamState.Paused
        )
          paused.add(publication.trackSid);
    this.pauses.restore(paused);
  }
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
            name: participant.name || t(($) => $.media.participant),
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
    // Отписка, снятие дорожки, уход участника — конец паузы этой дорожки: надпись не переживает видео.
    this.pauses.retain(
      new Set(
        tiles.filter((tile) => !tile.local && tile.track.kind === Track.Kind.Video).map((tile) => tile.id),
      ),
    );
    const local = this.room.localParticipant;
    const mic = local.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack ?? null;
    this.watchMic(mic);
    this.captured.set(mic?.readyState === 'live');
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
      // Выключенный, но захваченный микрофон (W5 или выключенный кнопкой) после полного
      // переподключения публикуется снова — заглушённым. Иначе захват жил бы вне комнаты, а
      // «включить» захватило бы микрофон второй раз и первый остался бы гореть до конца встречи.
      const heldMic = this.deviceTracks.get(Track.Source.Microphone);
      if (
        !this.wanted.microphone &&
        heldMic instanceof LocalAudioTrack &&
        heldMic.mediaStreamTrack.readyState === 'live' &&
        !this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
      ) {
        if (this.disposed || cycle !== this.connectionCycle) return;
        if (!heldMic.isMuted) await heldMic.mute();
        await this.room.localParticipant.publishTrack(heldMic, {
          ...microphoneOptions(),
          source: Track.Source.Microphone,
        });
      }
      for (const track of this.screenTracks) {
        if (this.disposed || cycle !== this.connectionCycle) return;
        if (
          track.mediaStreamTrack.readyState !== 'live' ||
          this.room.localParticipant.getTrackPublication(track.source)?.track
        )
          continue;
        await this.room.localParticipant.publishTrack(track, {
          ...screenOptions(this.profile, this.codec, this.spatialDesktop),
          source: track.source,
          ...(track.kind === Track.Kind.Audio
            ? { audioPreset: { maxBitrate: 128000 }, forceStereo: true, dtx: false }
            : {}),
        });
      }
      this.refreshTracks();
    } catch (error) {
      if (!this.disposed) this.report(error);
    }
  }
  /**
   * «Нажми и говори» (E01-B3): привести микрофон к нужному состоянию.
   *
   * ЗАЧЕМ НЕ `toggle`. Нажатие и отпускание приходят быстрее, чем публикуется дорожка, а `toggle`
   * во время работы молча отказывает — короткое нажатие оставило бы микрофон включённым. Здесь
   * побеждает последнее желание: пока идёт одно переключение, следующее ждёт и сверяется заново.
   * Без сигналов: щелчок на каждое нажатие клавиши рации мешал бы, а удержание человек и так чувствует.
   */
  setMicrophone(on: boolean): Promise<void> {
    this.micTarget = on;
    this.micSetting ??= this.reconcileMicrophone().finally(() => {
      this.micSetting = undefined;
    });
    return this.micSetting;
  }
  private async reconcileMicrophone() {
    // Переключение руками (кнопка в пульте) ещё идёт — подождать его, но не бесконечно.
    for (let waited = 0; !this.disposed && waited < 100;) {
      if (this.micTarget === this.state.get().microphone) return;
      if (this.deviceBusy.has('microphone')) {
        waited++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      const before = this.state.get().microphone;
      await this.toggle('microphone', undefined, false);
      // Не переключился (нет доступа, нет устройства) — ошибку уже показали, не долбим.
      if (this.state.get().microphone === before) return;
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
        }
        // Первое включение на телефоне — фронтальная камера, а не та, что запомнилась (владелец,
        // 27.10.2026): после «перевернуть» в прошлой встрече следующая начиналась с задней. Дальше
        // во встрече — какую выбрали.
        const front = !this.cameraStarted && touchFirst();
        await this.room.localParticipant.setCameraEnabled(
          !this.state.get().camera,
          front
            ? { facingMode: 'user', ...this.cameraCaptureNow() }
            : { deviceId, ...this.cameraCaptureNow() },
          this.cameraOptionsNow(),
        );
        this.videoChangedAt.camera = performance.now();
        this.applyCameraHint();
        if (this.room.localParticipant.isCameraEnabled) this.cameraStarted = true;
      }
      this.wanted[kind] =
        kind === 'microphone'
          ? this.room.localParticipant.isMicrophoneEnabled
          : this.room.localParticipant.isCameraEnabled;
      if (kind === 'microphone' && !this.wanted.microphone) this.micGaps.forget();
      if (kind === 'microphone' && announce)
        signal(this.room.localParticipant.isMicrophoneEnabled ? 'mic-on' : 'mic-off');
      if (kind === 'camera' && !reusedCamera) this.cameraProfilePending = false;
      if (kind === 'camera' && this.wanted.camera && this.cameraProfilePending)
        await this.setCameraProfile(this.cameraProfile);
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
   * Зум своей камеры, если платформа его отдаёт (R36): Chrome на Android и камеры с PTZ на
   * компьютере — захват просит `zoom: true` (`cameraCapture`); Safari, Firefox и поддельная камера
   * Chromium — нет, тогда `null`, и ступеней «0.5× · 1× · 2×» нет (`zoomSteps`).
   */
  cameraZoom(): Zoom | null {
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    return track instanceof LocalVideoTrack ? readZoom(track.mediaStreamTrack) : null;
  }

  async applyCameraZoom(value: number) {
    const range = this.cameraZoom();
    if (!range) return;
    const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (!(track instanceof LocalVideoTrack)) return;
    const clamped = Math.min(range.max, Math.max(range.min, value));
    const media = track.mediaStreamTrack;
    // `applyConstraints` заменяет все ограничения разом: кадр и нижняя граница частоты
    // (`enforceCameraRate`) идут вместе с зумом, иначе зум сбросил бы их. Зум — «advanced»: браузер,
    // который его не знает, молча пропускает его, а не проваливает весь вызов.
    const current = media.getConstraints?.() ?? {};
    const advanced = (current.advanced ?? []).filter((set) => !('zoom' in set));
    try {
      await media.applyConstraints({
        ...current,
        advanced: [...advanced, { zoom: clamped } as MediaTrackConstraintSet],
      });
    } catch {
      /* Камера может отказать в зуме, который сама же объявила; звонок от этого не страдает. */
    }
  }

  /**
   * Must be called directly from the click handler, before any await.
   *
   * `audio` — звук показа, который оболочка пришлёт отдельно (E01-B3: звук приложения, «система
   * кроме Cord»). Подписка — до `getDisplayMedia`: отказ оболочка шлёт сразу, как отдаст экран, и
   * подписка после захвата могла бы его пропустить.
   *
   * `source` — свой захват вместо `getDisplayMedia`: устройство захвата из окна показа (R60,
   * `deviceCapture`). Дальше — тот же путь показа: уровень, режим, превью, остановка.
   */
  share(profile: ScreenProfile, audio?: ScreenAudioSource, source?: () => Promise<MediaStream>): void {
    if (this.disposed) return;
    // Остановить можно всегда — и пока показ ещё разгоняется до кадра целевого размера (T48): на
    // пульте уже «Остановить показ», и нажатие не должно пропадать до конца разгона (R81). Отмена
    // обрывает публикацию — `screen.started` не уйдёт.
    if (this.state.get().screen || this.screenTracks.length) {
      void this.stopScreen();
      return;
    }
    if (this.screenBusy) return;
    if (!source && !this.capture.supported()) {
      this.report(new Error(t(($) => $.media.screen.unsupported)));
      return;
    }
    this.screenBusy = true;
    const link = audio ? this.linkScreenAudio(audio) : undefined;
    const capture = source ? source() : this.capture.capture(profile);
    void this.publishScreen(capture, profile, link).finally(() => {
      this.screenBusy = false;
    });
  }

  /**
   * Звук показа от оболочки на время одного показа. Дорожка может прийти раньше видео (ждёт его),
   * после (публикуется сразу) или уже после конца показа — тогда она останавливается: захват в
   * оболочке гаснет по остановке дорожки.
   */
  private linkScreenAudio(source: ScreenAudioSource): ScreenAudioLink {
    // Прежний показ ещё ждал опоздавшую дорожку — дорожка нового показа ему не принадлежит.
    if (this.lingeringAudio) this.endScreenAudioWatch(this.lingeringAudio);
    const link: ScreenAudioLink = {
      unwatch: () => {},
      live: false,
      closed: false,
      abort: new AbortController(),
    };
    this.screenAudio = link;
    link.unwatch = source.watch((event) => this.onScreenAudio(link, event));
    return link;
  }
  private onScreenAudio(link: ScreenAudioLink, event: ScreenAudioEvent) {
    if (link.closed) {
      if (event.state === 'ready') {
        event.track.stop();
        this.endScreenAudioWatch(link);
      }
      return;
    }
    if (event.state === 'ready') {
      if (link.track === event.track) return;
      void this.dropScreenAudio(link);
      link.track = event.track;
      if (link.live) void this.publishScreenAudio(link);
      return;
    }
    // Своя дорожка оболочки, а не звук системы: заметки «зрители услышат разговор» здесь нет.
    if (event.state === 'failed') this.report(new Error(event.message));
    void this.dropScreenAudio(link);
  }
  private async publishScreenAudio(link: ScreenAudioLink) {
    const track = link.track;
    if (!track || track.readyState !== 'live' || link.published) return;
    const stale = () => this.disposed || link.closed || link.track !== track;
    try {
      await waitForPublishPermissions(this.room, [Track.Source.ScreenShareAudio], link.abort.signal);
      if (stale()) return;
      const publication = await this.room.localParticipant.publishTrack(track, {
        ...screenOptions(this.profile, this.codec, this.spatialDesktop),
        source: Track.Source.ScreenShareAudio,
        audioPreset: { maxBitrate: 128000 },
        forceStereo: true,
        dtx: false,
      });
      const published = publication.track;
      if (!published) return;
      if (stale()) {
        await this.room.localParticipant.unpublishTrack(published, true).catch(() => published.stop());
        return;
      }
      link.published = published;
      this.screenTracks.push(published);
      this.refreshTracks();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) this.report(error);
    }
  }
  /** Дорожки оболочки больше нет (отказ, конец, замена): снять с публикации и остановить. */
  private async dropScreenAudio(link: ScreenAudioLink) {
    const { track, published } = link;
    link.track = undefined;
    link.published = undefined;
    if (!published) {
      track?.stop();
      return;
    }
    this.screenTracks = this.screenTracks.filter((item) => item !== published);
    try {
      await this.room.localParticipant.unpublishTrack(published, true);
    } catch {
      published.stop();
    }
    this.refreshTracks();
  }
  /** Показ кончился: дорожка — `stop()`; не пришла ещё — подождать её 15 с, чтобы остановить. */
  private closeScreenAudio(link = this.screenAudio) {
    if (!link || link.closed) return;
    link.closed = true;
    link.abort.abort();
    if (this.screenAudio === link) this.screenAudio = undefined;
    const track = link.track;
    link.track = undefined;
    link.published = undefined;
    if (track) {
      track.stop();
      link.unwatch();
      return;
    }
    this.lingeringAudio = link;
    link.linger = setTimeout(() => this.endScreenAudioWatch(link), 15000);
  }
  private endScreenAudioWatch(link: ScreenAudioLink) {
    clearTimeout(link.linger);
    link.unwatch();
    if (this.lingeringAudio === link) this.lingeringAudio = undefined;
  }
  private async publishScreen(capture: Promise<MediaStream>, profile: ScreenProfile, link?: ScreenAudioLink) {
    let stream: MediaStream | undefined;
    let reserved = false;
    const operation = new AbortController();
    this.screenPublishAbort = operation;
    const captureEnded = () => operation.abort();
    try {
      stream = await capture;
      if (this.disposed || operation.signal.aborted) return;
      const video = stream.getVideoTracks()[0];
      if (!video) throw new Error(t(($) => $.media.screen.noTrack));
      video.addEventListener('ended', captureEnded, { once: true });
      const settings = video.getSettings();
      // Звук всего экрана — это и звук самого Cord. Если браузер не умеет его вычесть, лучше
      // сказать об этом сразу, чем оставить зрителя гадать, почему он слышит сам себя.
      // Звук приложения и «кроме Cord» идут своей дорожкой оболочки — Cord в них нет по построению.
      if (!link && ownAudioLeaks(video, stream.getAudioTracks()[0]))
        this.report(new Error(t(($) => $.media.screen.ownAudioLeaks)));
      this.captureSize = { width: settings.width ?? 1920, height: settings.height ?? 1080 };
      const size = fitSource(this.captureSize.width, this.captureSize.height, profile.resolution);
      await video.applyConstraints({
        width: { max: size.width },
        height: { max: size.height },
        frameRate: { max: profile.fps },
      });
      // Screencast-режим Chromium (R91): кодировщик не понижает разрешение и не включает
      // quality scaler — при нехватке полосы сбрасывает кадры, а не чёткость.
      video.contentHint = screenHint;
      this.codec = await chooseCodec(profile);
      this.screenPreferredCodec = this.codec;
      this.screenFellBack = false;
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
          ...screenOptions(profile, this.codec, this.spatialDesktop),
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
      video.removeEventListener('ended', captureEnded);
      video.addEventListener(
        'ended',
        () => {
          if (this.screenTracks.some((track) => track.mediaStreamTrack === video)) void this.stopScreen();
        },
        { once: true },
      );
      // Звук оболочки, пришедший раньше видео, ждал его; пришедший позже опубликуется сразу.
      if (link && !link.closed) {
        link.live = true;
        void this.publishScreenAudio(link);
      }
      this.videoChangedAt.screen = performance.now();
      this.refreshTracks();
      this.syncPreview();
      this.upstreamCounters = undefined;
      stream = undefined;
      // Зрителям показ открывается после кадра целевого качества (T48): сначала верхний слой
      // должен закодировать кадр того размера, который просили, или кончиться окно разгона, —
      // и только потом комната узнаёт, что показ начался. До этого у всех «Готовится показ…».
      await this.awaitScreenReady(
        this.screenTracks.find((t) => t.kind === Track.Kind.Video),
        size,
        operation.signal,
      );
      if (this.disposed || operation.signal.aborted) return;
      if (reservation.value)
        await this.api.command({
          type: 'screen.started',
          commandId: crypto.randomUUID(),
          targetId: reservation.value,
        });
    } catch (error) {
      if (!(error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name)))
        this.report(error);
      await this.stopScreen();
    } finally {
      if (this.screenPublishAbort === operation) this.screenPublishAbort = undefined;
      if (stream) {
        stream.getVideoTracks()[0]?.removeEventListener('ended', captureEnded);
        stream.getTracks().forEach((t) => t.stop());
        this.closeScreenAudio(link);
        if (reserved) await this.api.screen(false).catch(() => {});
      }
    }
  }
  /**
   * Дождаться кадра целевого размера от кодировщика экрана — или конца окна разгона.
   *
   * Решение — в `screen-ready.ts`; здесь только опрос статистики той же дорожки раз в 300 мс.
   * Отмена показа или выход из встречи обрывают ожидание вместе с публикацией.
   */
  private async awaitScreenReady(
    track: LocalTrack | undefined,
    target: { width: number; height: number },
    signal: AbortSignal,
  ) {
    if (!track || typeof track.getRTCStatsReport !== 'function') return;
    const startedAt = performance.now();
    const readiness = new ScreenReadiness(target, this.settleMs, startedAt);
    for (;;) {
      if (this.disposed || signal.aborted) return;
      const sample = await track
        .getRTCStatsReport()
        .then((report) => (report ? readScreenSample(report) : null))
        .catch(() => null);
      const verdict = readiness.observe(sample, performance.now());
      if (verdict !== 'waiting') {
        console.info('[cord] показ открыт зрителям', {
          verdict,
          waitedMs: Math.round(performance.now() - startedAt),
          target,
          sample,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  async stopScreen() {
    this.screenPublishAbort?.abort();
    this.closeScreenAudio();
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
  }
  /** Сменить режим показа (R95): тот же уровень, другой кодек и полоса — переопубликация. */
  setScreenMode(mode: ScreenMode) {
    return this.setProfile({ ...this.profile, mode });
  }
  setProfile(profile: ScreenProfile) {
    this.profile = { ...this.preferences.get().screen, ...profile };
    this.preferences.set(savePreferences({ screen: profile }));
    this.profileChange = this.profileChange.then(() => this.applyProfile(this.profile));
    return this.profileChange;
  }
  setCameraProfile(profile: ScreenProfile) {
    this.cameraProfile = profile;
    this.cameraProfilePending = true;
    this.videoChangedAt.camera = performance.now();
    this.preferences.set(savePreferences({ camera: profile }));
    this.cameraChange = this.cameraChange.then(async () => {
      if (this.disposed || !this.wanted.camera) return;
      const publication = this.room.localParticipant.getTrackPublication(Track.Source.Camera);
      const track = publication?.track;
      if (!(track instanceof LocalVideoTrack)) return;
      this.deviceBusy.add('camera');
      try {
        // На месте — та же дорожка и тот же отправитель: захват меняет кадр и частоту сам
        // (`applyConstraints`), кодировщик получает новую полосу (`setParameters`). У зрителя кадр
        // меняется внутри потока — плитка не гаснет, у себя камера не выключается. Переопубликация
        // (ниже) — только если на месте нельзя.
        await this.enforceCameraRate();
        if (this.disposed) return;
        if (await this.retuneCamera(track, profile)) {
          // Полное переподключение публикует дорожку заново по этим параметрам — пусть по новым.
          if (publication) publication.options = { ...publication.options, ...this.cameraOptionsNow() };
          this.cameraProfilePending = false;
          this.refreshTracks();
          return;
        }
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
   * Сменить кодек камеры на лету: переопубликовать дорожку без перезахвата.
   *
   * `setCameraProfile` для смены кодека не годится — он сначала пробует подстроить слои на месте
   * (`retuneCamera`), а на месте кодек не меняется. Здесь дорожка та же (`unpublishTrack(..., false)`
   * её не останавливает), меняются только параметры публикации: у зрителя плитка на миг моргает и
   * продолжает тем же кодеком. Очередь общая с `setCameraProfile` (`cameraChange`), чтобы смена
   * кодека и смена уровня не наложились.
   */
  private switchCameraCodec() {
    this.cameraChange = this.cameraChange.then(async () => {
      if (this.disposed || !this.wanted.camera) return;
      const track = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      if (!(track instanceof LocalVideoTrack)) return;
      this.deviceBusy.add('camera');
      try {
        await this.room.localParticipant.unpublishTrack(track, false);
        if (this.disposed) return;
        await this.room.localParticipant.publishTrack(track, {
          ...this.cameraOptionsNow(),
          source: Track.Source.Camera,
        });
        this.applyCameraHint();
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
   * Ступень удержания для показа — тем же способом, что у камеры: на месте.
   *
   * Отличие от `setProfile` одно, и оно главное. `setProfile` зовут, когда человек выбрал
   * уровень или когда сменился кодек: там новая публикация честная — другой кодек иначе не
   * отдать. Ступень удержания не выбор и не кодек: в настройки она не пишется, а
   * переопубликация на каждом шаге означала, что зрители теряли показ на время подписки
   * заново — ровно тогда, когда канал и так тесный.
   */
  private async applyProfile(profile: ScreenProfile) {
    const track = this.screenTracks.find((t) => t instanceof LocalVideoTrack);
    if (!(track instanceof LocalVideoTrack)) return;
    const generation = this.screenGeneration;
    try {
      const size = fitSource(this.captureSize.width, this.captureSize.height, profile.resolution);
      await track.mediaStreamTrack.applyConstraints({
        width: { max: size.width },
        height: { max: size.height },
        frameRate: { max: profile.fps },
      });
      track.mediaStreamTrack.contentHint = screenHint;
      if (this.disposed || generation !== this.screenGeneration) return;
      this.videoChangedAt.screen = performance.now();
      await this.room.localParticipant.unpublishTrack(track, false);
      if (this.disposed || generation !== this.screenGeneration) return;
      await this.room.localParticipant.publishTrack(track, {
        ...screenOptions(profile, this.codec, this.spatialDesktop),
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
      let named = false;
      let width = 0;
      let height = 0;
      let fps = 0;
      let bytes = 0;
      let at = 0;
      let dormant = false;
      report?.forEach((stat) => {
        if (stat.type !== 'outbound-rtp' || (stat.kind ?? stat.mediaType) !== 'video') return;
        if (typeof stat.qualityLimitationReason === 'string') named = true;
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
      if (!named) limitation = 'unknown';
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
          targetFps: leading.source === 'screen' ? this.profile.fps : this.cameraProfile.fps,
          sourceFps: leading.track.mediaStreamTrack?.getSettings?.().frameRate,
          dormant,
          settling: performance.now() - this.videoChangedAt[leading.source] < this.settleMs,
        });
      // Новые кодеки (VP9/AV1) красивее и экономят канал, но кодируются дороже. Сторож
      // (`EncoderHealth`) держит их, пока процессор тянет, отступает на H.264 после трёх жалоб
      // `cpu` подряд и возвращает обратно, когда процессор устойчиво освободился: хороший канал —
      // не повод отступать (R91/X10), а один всплеск нагрузки — не повод застрять на запасном.
      const onScreen = leading.source === 'screen';
      const current = onScreen ? this.codec : this.cameraCodec;
      const advanced = current === 'av1' || current === 'vp9';
      const fellBack = onScreen ? this.screenFellBack : this.cameraFellBack;
      const move = this.encoderHealth.observe(limitation, advanced, fellBack);
      if (move === 'fallback') {
        const safe = fallbackCodec();
        if (onScreen) {
          this.screenPreferredCodec ??= this.codec;
          this.codec = safe;
          this.screenFellBack = true;
          void this.setProfile(this.profile);
          this.report(new Error(t(($) => $.media.encoder.screen)));
        } else {
          this.cameraPreferredCodec ??= this.cameraCodec;
          this.cameraCodec = safe;
          this.cameraCodecChosen = Promise.resolve(safe);
          this.cameraFellBack = true;
          void this.switchCameraCodec();
          this.report(new Error(t(($) => $.media.encoder.camera)));
        }
      } else if (move === 'restore') {
        // Процессор отпустил — тихо возвращаем основной кодек: качество растёт, пугать нечем.
        if (onScreen) {
          this.codec = this.screenPreferredCodec ?? this.codec;
          this.screenFellBack = false;
          void this.setProfile(this.profile);
        } else {
          const back = this.cameraPreferredCodec ?? this.cameraCodec;
          this.cameraCodec = back;
          this.cameraCodecChosen = Promise.resolve(back);
          this.cameraFellBack = false;
          void this.switchCameraCodec();
        }
      }
      // Жалобы кодировщика (`bandwidth`/`cpu`) ничего не понижают (R91/X10): выбранные
      // разрешение и частота — нижняя граница, они видны в плашке отдачи и остаются.
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
    this.videoSilence.clear();
    this.lastLiveReset.clear();
    clearInterval(this.liveTimer);
    clearInterval(this.playoutTimer);
    clearInterval(this.deadlineTimer);
    clearTimeout(this.reconnectTimer);
    clearInterval(this.qualityTimer);
    window.removeEventListener('online', this.network);
    connection()?.removeEventListener?.('change', this.network);
    this.lifecycle.dispose();
    this.subscriptions.forEach((off) => off());
    clearTimeout(this.micGapTimer);
    this.watchMic(null);
    this.wake.dispose();
    this.pip.dispose();
    this.audio.dispose();
    window.removeEventListener('cord:preferences', this.settingsChanged);
    this.previewSource.stop();
    this.previewImages.clear();
    for (const timer of this.screenGoneTimers.values()) clearTimeout(timer);
    this.screenGoneTimers.clear();
    this.screenPreviews.set({});
    this.pauses.clear();
    this.speaking.set([]);
    this.levels.dispose();
    this.closeScreenAudio();
    this.screenTracks.forEach((t) => t.stop());
    this.deviceTracks.forEach((t) => t.stop());
    this.deviceTracks.clear();
    this.screenTracks = [];
    void this.room.disconnect(true);
    // Контекст свой, а не SDK: SDK закрывает только те, что создал сам.
    void this.audioContext?.close().catch(() => {});
    this.tracks.set([]);
    this.captured.set(false);
    this.patch({ status: 'ended', screen: false, camera: false, microphone: false });
  }
}
