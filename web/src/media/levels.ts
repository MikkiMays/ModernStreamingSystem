import type { Track } from 'livekit-client';
import { hasFeature, isDesktop } from '../core/desktop';
import { Store } from '../core/store';
// `no-inline`: маленький файл Vite иначе вложил бы `data:`-адресом, а CSP сервера (`script-src 'self'`) его не пустит.
import levelWorklet from './level-meter.worklet.js?url&no-inline';

/**
 * Громкость голоса — один источник на весь веб (T23, решение 8 архитектуры).
 *
 * ЗАЧЕМ. Кто говорит, решал SFU: `ActiveSpeakersChanged` приходит раз в несколько сотен
 * миллисекунд и ещё сглажен на сервере, поэтому обводка загоралась, когда слово уже сказано, и
 * гасла посреди следующего. Своя обводка запаздывала так же — свой голос до сервера и обратно.
 * Здесь уровень считает каждый зритель сам: `AnalyserNode` на своей дорожке микрофона и на каждой
 * принятой (они и так играют в `Stage.tsx`), без сети между звуком и рамкой.
 *
 * ЧТО НАРУЖУ. На участника — `{level: 0..1, tier: 0..4}`. Ступень 0 — молчит; 1–4 — тихо, речь,
 * громко, пик: четыре оттенка зелёного (`--voice-1..4`). Атака — один кадр, спад — около
 * 150–250 мс (линейно по децибелам), чтобы обводка не мерцала между слогами. Читают плитки,
 * список людей, лица в играх, индикатор микрофона в настройках (`useMicLevel`) и оверлей
 * клиента (E01, `watchAll`).
 *
 * СКОЛЬКО СТОИТ. Один `AudioContext` на встречу; анализатор — только у тех, на кого кто-то
 * смотрит (`watch`): плитки нет — нет и анализа. Опрос — не чаще 30 раз в секунду одним
 * `requestAnimationFrame`, и только пока вкладка видна: скрытой странице рамки рисовать некому.
 * Дорожки без анализатора (нет Web Audio, не разрешили звук) получают ступень от SFU — хуже по
 * задержке, но не пусто.
 *
 * ВНЕ КАДРОВ (R63). В клиенте Windows виджет говорящих в игре и мини-окно звонка смотрят, когда окно
 * Cord спрятано, свёрнуто или накрыто игрой: кадров экрана там нет, и опрос по
 * `requestAnimationFrame` замер бы. Там измеритель — `AudioWorklet` (`level-meter.worklet.js`): уровень
 * считается в потоке звука и сам приходит каждые 21 мс (`Meter.subscribe`), опрос идёт по его приходу
 * и не зависит от видимости вкладки. В браузере — прежний анализатор по кадрам.
 */

export type VoiceTier = 0 | 1 | 2 | 3 | 4;

export interface VoiceLevel {
  /** 0 — тишина (−60 дБ и ниже), 1 — 0 дБ полной шкалы. */
  level: number;
  tier: VoiceTier;
}

/** Ниже этого — тишина: шкала уровня начинается здесь. */
export const FLOOR_DB = -60;
/**
 * Пороги ступеней 1–4 по среднеквадратичному уровню, дБ полной шкалы.
 *
 * Речь после шумоподавления браузера лежит около −35…−15, фон — ниже −55. Первая ступень
 * отрезает дыхание и шорох, четвёртая — только крик и смех у самого микрофона.
 */
export const TIER_DB = [-45, -35, -25, -15] as const;
/** Спад: дБ в секунду. От обычной речи (−25…−30 дБ) до тишины — 130–170 мс, от крика — около 250. */
export const RELEASE_DB_PER_S = 120;
/** Чаще 30 раз в секунду глаз разницы не видит, а процессор — видит. */
export const MAX_RATE_HZ = 30;
/** Ступень по SFU для того, у кого своего анализатора нет: «говорит», без оттенка громкости. */
const SFU_TIER: VoiceTier = 2;

/** Среднеквадратичный уровень отсчётов, дБ полной шкалы. Пустой или нулевой сигнал — −∞ не нужен. */
export function rmsDb(samples: ArrayLike<number>): number {
  if (!samples.length) return -100;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sum / samples.length);
  return Math.max(-100, 20 * Math.log10(Math.max(rms, 1e-5)));
}

/** Атака — сразу, спад — не быстрее `RELEASE_DB_PER_S`. */
export function smoothDb(previous: number, raw: number, elapsedMs: number): number {
  if (raw >= previous) return raw;
  return Math.max(raw, previous - (RELEASE_DB_PER_S * Math.max(0, elapsedMs)) / 1000);
}

export function tierOf(db: number): VoiceTier {
  let tier = 0;
  for (const threshold of TIER_DB) if (db >= threshold) tier += 1;
  return tier as VoiceTier;
}

export function levelOf(db: number): number {
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

/** Измеритель одной дорожки: текущий уровень в дБ полной шкалы. */
export interface Meter {
  read(): number;
  close(): void;
  /**
   * Слышит ли измеритель звук прямо сейчас. Звуковой контекст, рождённый без жеста (перезагрузка
   * посреди встречи, iOS), спит и отдаёт тишину — пока так, ступень берётся от SFU, а не «молчит».
   */
  ready?(): boolean;
  /**
   * Измеритель, который сам сообщает о новом значении (AudioWorklet): опрос идёт по его приходу, а не
   * по кадрам, и скрытая вкладка его не останавливает. Нет — измеритель опрашивается по кадрам.
   */
  subscribe?(listener: () => void): () => void;
}
export type MeterFactory = (track: MediaStreamTrack) => Meter | null;

/** Что нужно от дорожки встречи: кто, какой источник, сама дорожка и заглушена ли. */
export interface VoiceSource {
  participantId: string;
  source: Track.Source | string;
  muted: boolean;
  track: { kind?: string; mediaStreamTrack?: MediaStreamTrack };
}

/** Окружение — снаружи, чтобы правило проверялось без браузера и без звука. */
export interface LevelsEnvironment {
  meter: MeterFactory;
  now: () => number;
  frame: (callback: () => void) => () => void;
  visible: () => boolean;
  onVisibility: (callback: () => void) => () => void;
  /** Освободить то, что окружение держит (звуковой контекст). */
  close: () => void;
}

interface Measured {
  track: VoiceSource['track'];
  stream: MediaStreamTrack;
  meter: Meter | null;
  db: number;
  /** Отписка от измерителя, который сам сообщает о значениях. */
  unsubscribe?: () => void;
}

/** Что модулю нужно от хранилищ встречи: прочитать и подписаться. */
type Readable<T> = Pick<Store<T>, 'get' | 'subscribe'>;

const MICROPHONE = 'microphone';
const EMPTY: Record<string, VoiceLevel> = {};

export class VoiceLevels {
  /** Уровни тех, на кого смотрят, — одна запись на участника. Меняется не чаще 30 раз в секунду. */
  readonly state = new Store<Record<string, VoiceLevel>>(EMPTY);
  private readonly env: LevelsEnvironment;
  private sources = new Map<string, VoiceSource['track']>();
  private measured = new Map<string, Measured>();
  private watchers = new Map<string, number>();
  private everyone = 0;
  private sfu: readonly string[] = [];
  private cancelFrame: (() => void) | null = null;
  private running = false;
  private last = 0;
  private disposed = false;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(
    tracks: Readable<readonly VoiceSource[]>,
    speaking: Readable<readonly string[]>,
    env: Partial<LevelsEnvironment> = {},
  ) {
    this.env = { ...browserEnvironment(), ...env };
    const sync = () => this.syncSources(tracks.get());
    const sfu = () => {
      this.sfu = speaking.get();
      this.publish();
    };
    this.unsubscribe.push(tracks.subscribe(sync), speaking.subscribe(sfu));
    this.unsubscribe.push(this.env.onVisibility(() => this.visibilityChanged()));
    this.sfu = speaking.get();
    sync();
  }

  /** Ступень участника сейчас. */
  tier(id: string): VoiceTier {
    return this.state.get()[id]?.tier ?? 0;
  }

  /** Уровень участника сейчас, 0..1. */
  level(id: string): number {
    return this.state.get()[id]?.level ?? 0;
  }

  /**
   * Смотреть на участника: пока есть хоть один смотрящий, его голос измеряется. Слушатель
   * зовётся на каждом опросе — сравнивать, изменилось ли нужное ему, его забота
   * (`useSyncExternalStore` делает это сам).
   */
  watch(id: string, listener: () => void): () => void {
    this.watchers.set(id, (this.watchers.get(id) ?? 0) + 1);
    const stop = this.state.subscribe(listener);
    this.reconcile();
    return () => {
      stop();
      const left = (this.watchers.get(id) ?? 1) - 1;
      if (left > 0) this.watchers.set(id, left);
      else this.watchers.delete(id);
      this.reconcile();
    };
  }

  /** Смотреть на всех сразу — для оверлея клиента (E01), который показывает говорящих списком. */
  watchAll(listener: () => void): () => void {
    this.everyone += 1;
    const stop = this.state.subscribe(listener);
    this.reconcile();
    return () => {
      stop();
      this.everyone -= 1;
      this.reconcile();
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe.forEach((stop) => stop());
    this.stop();
    for (const entry of this.measured.values()) release(entry);
    this.measured.clear();
    this.env.close();
    this.state.set(EMPTY);
  }

  private watched(id: string) {
    return this.everyone > 0 || this.watchers.has(id);
  }

  private syncSources(tiles: readonly VoiceSource[]) {
    const next = new Map<string, VoiceSource['track']>();
    for (const tile of tiles)
      if (tile.source === MICROPHONE && !tile.muted && tile.track.kind !== 'video')
        next.set(tile.participantId, tile.track);
    this.sources = next;
    this.reconcile();
  }

  /** Анализаторы — ровно у тех, у кого есть дорожка и смотрящий; лишние закрываются. */
  private reconcile() {
    if (this.disposed) return;
    for (const [id, entry] of this.measured) {
      const track = this.sources.get(id);
      if (track !== entry.track || !this.watched(id) || track.mediaStreamTrack !== entry.stream) {
        release(entry);
        this.measured.delete(id);
      }
    }
    for (const [id, track] of this.sources) {
      if (this.measured.has(id) || !this.watched(id)) continue;
      const stream = track.mediaStreamTrack;
      if (!stream || stream.readyState === 'ended') continue;
      let meter: Meter | null = null;
      try {
        meter = this.env.meter(stream);
      } catch {
        meter = null;
      }
      const entry: Measured = { track, stream, meter, db: -100 };
      if (meter?.subscribe) entry.unsubscribe = meter.subscribe(this.pushed);
      this.measured.set(id, entry);
    }
    this.publish();
    // Кадры нужны только измерителям, которые опрашиваются; остальные приходят сами (`pushed`).
    if (
      [...this.measured.values()].some((entry) => entry.meter && !entry.meter.subscribe) &&
      this.env.visible()
    )
      this.start();
    else this.stop();
  }

  /** Измеритель сообщил новое значение — опрос (не чаще `MAX_RATE_HZ`), видна вкладка или нет. */
  private pushed = () => {
    if (!this.disposed) this.tick();
  };

  private start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this.last = this.env.now();
    const loop = () => {
      this.cancelFrame = null;
      if (!this.running) return;
      if (this.disposed || !this.env.visible()) {
        this.running = false;
        return;
      }
      this.tick();
      // Опрос мог сам остановить цикл: последний анализатор закрылся.
      if (this.running) this.cancelFrame = this.env.frame(loop);
    };
    this.cancelFrame = this.env.frame(loop);
  }

  private stop() {
    this.running = false;
    this.cancelFrame?.();
    this.cancelFrame = null;
  }

  private visibilityChanged() {
    if (this.env.visible()) {
      this.reconcile();
      return;
    }
    // Скрытая вкладка не рисует: уровень обнуляется, чтобы по возвращении не висела старая рамка.
    // Измерители вне кадров продолжают: их читают окна оболочки, которым вкладка не нужна.
    this.stop();
    for (const entry of this.measured.values()) if (!entry.meter?.subscribe) entry.db = -100;
    this.publish();
  }

  /** Один опрос: не чаще `MAX_RATE_HZ`. */
  tick() {
    const now = this.env.now();
    const elapsed = now - this.last;
    if (elapsed < 1000 / MAX_RATE_HZ - 1) return;
    this.last = now;
    let rebuild = false;
    for (const entry of this.measured.values()) {
      // Обработка микрофона меняет дорожку под той же публикацией — анализатор строится заново.
      if (entry.track.mediaStreamTrack !== entry.stream) rebuild = true;
      if (!entry.meter) continue;
      entry.db = smoothDb(entry.db, entry.meter.read(), elapsed);
    }
    if (rebuild) this.reconcile();
    else this.publish();
  }

  /** Собрать уровни и отдать наружу, только если что-то изменилось. */
  private publish() {
    if (this.disposed) return;
    const next: Record<string, VoiceLevel> = {};
    for (const [id, entry] of this.measured) {
      if (!hears(entry)) continue;
      const tier = tierOf(entry.db);
      const level = Math.round(levelOf(entry.db) * 100) / 100;
      if (tier || level) next[id] = { level, tier };
    }
    for (const id of this.sfu)
      if (!hears(this.measured.get(id)) && this.watched(id)) next[id] = { level: 0, tier: SFU_TIER };
    if (!same(this.state.get(), next)) this.state.set(Object.keys(next).length ? next : EMPTY);
  }
}

function release(entry: Measured) {
  entry.unsubscribe?.();
  entry.meter?.close();
}

/** Есть ли у участника свой измеритель, который сейчас слышит звук. */
function hears(entry: Measured | undefined) {
  return !!entry?.meter && (entry.meter.ready?.() ?? true);
}

function same(a: Record<string, VoiceLevel>, b: Record<string, VoiceLevel>) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((id) => b[id] && b[id].tier === a[id]!.tier && b[id].level === a[id]!.level);
}

/**
 * Настоящее окружение: Web Audio, `requestAnimationFrame`, видимость документа.
 *
 * Контекст один на все анализаторы и рождается при первой дорожке. Если браузер создал его
 * «спящим» (iOS — без жеста), он просыпается на первом нажатии где угодно.
 */
export function browserEnvironment({ push = pushMeters() }: { push?: boolean } = {}): LevelsEnvironment {
  let context: AudioContext | null = null;
  const wake = () => void context?.resume().catch(() => {});
  /** Модуль измерителя грузится один раз на контекст; не загрузился — дальше анализаторы. */
  let module: Promise<void> | null = null;
  let workletFailed = false;
  const meter: MeterFactory = (track) => {
    if (typeof AudioContext === 'undefined') return null;
    context ??= new AudioContext();
    if (context.state === 'suspended') {
      wake();
      document.addEventListener('pointerdown', wake, { once: true, capture: true });
      document.addEventListener('keydown', wake, { once: true, capture: true });
    }
    const source = context.createMediaStreamSource(new MediaStream([track]));
    if (push && !workletFailed && typeof AudioWorkletNode !== 'undefined' && context.audioWorklet) {
      const audio = context;
      module ??= audio.audioWorklet.addModule(levelWorklet);
      return workletMeter(audio, source, module, () => {
        workletFailed = true;
      });
    }
    const analyser = context.createAnalyser();
    // 1024 отсчёта — 21 мс при 48 кГц: окно короче кадра опроса, но длиннее одного периода голоса.
    analyser.fftSize = 1024;
    source.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const bytes = new Uint8Array(analyser.fftSize);
    const audio = context;
    return {
      ready: () => audio.state === 'running',
      read() {
        if (analyser.getFloatTimeDomainData) {
          analyser.getFloatTimeDomainData(data);
          return rmsDb(data);
        }
        analyser.getByteTimeDomainData(bytes);
        for (let i = 0; i < bytes.length; i += 1) data[i] = (bytes[i]! - 128) / 128;
        return rmsDb(data);
      },
      close() {
        source.disconnect();
        analyser.disconnect();
      },
    };
  };
  return {
    meter,
    now: () => performance.now(),
    frame: (callback) => {
      const id = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(id);
    },
    visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    onVisibility: (callback) => {
      if (typeof document === 'undefined') return () => {};
      document.addEventListener('visibilitychange', callback);
      return () => document.removeEventListener('visibilitychange', callback);
    },
    close: () => {
      void context?.close().catch(() => {});
      context = null;
      module = null;
    },
  };
}

/** Измерители вне кадров — в клиенте Windows с виджетом в игре и мини-окном (R63, R93). */
function pushMeters(): boolean {
  return isDesktop() && (hasFeature('overlay.widget') || hasFeature('mini'));
}

/**
 * Измеритель на `AudioWorklet`: уровень приходит из потока звука каждые 21 мс. Пока модуль грузится,
 * измеритель «не слышит» (`ready` — нет) и ступень берётся от SFU; не загрузился — так и остаётся, а
 * следующие дорожки получают анализатор (`failed`).
 */
function workletMeter(
  context: AudioContext,
  source: MediaStreamAudioSourceNode,
  module: Promise<void>,
  failed: () => void,
): Meter {
  let db = -100;
  let heard = false;
  let closed = false;
  let node: AudioWorkletNode | null = null;
  const listeners = new Set<() => void>();
  module.then(
    () => {
      if (closed) return;
      // Без выходов: узел — приёмник, Chromium опрашивает его сам, в динамики ничего не идёт.
      node = new AudioWorkletNode(context, 'cord-level-meter', { numberOfInputs: 1, numberOfOutputs: 0 });
      node.port.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (typeof data !== 'number') return;
        db = data;
        heard = true;
        listeners.forEach((listener) => listener());
      };
      source.connect(node);
    },
    () => failed(),
  );
  return {
    ready: () => heard && context.state === 'running',
    read: () => db,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      listeners.clear();
      source.disconnect();
      if (node) {
        node.port.onmessage = null;
        node.disconnect();
      }
    },
  };
}
