import type { CodecSwitch, PublishSource } from './codec-planner';
import type { VideoCodec } from './call-quality';
import { measuredDelayMs, type PlayoutClass, type PlayoutSample } from './playout';

/**
 * Сводка приёма раз в десять секунд для метров ядра (`POST /rooms/{id}/quality`, W1b шаг 4,
 * docs/observability.md §4).
 *
 * ЧТО УХОДИТ. По каждому классу дорожки (`conversation` | `media` | `video`) — разности счётчиков
 * inbound-rtp за окно: отсчёты заглушки без тишины DTX, отсчёты всего, начала заглушки (слышимые
 * провалы), потерянные пакеты; запас буфера, который мы просим, и его фактическая задержка. Ни номеров
 * дорожек, ни участников: ядро кладёт это только в гистограммы по классу (`RxQuality.java`).
 *
 * ОТКУДА. Из того же опроса раз в две секунды, что решает запас буфера (`PlayoutController.tick`):
 * `PlayoutController.samples` — последние отчёты по дорожкам. Своего getStats здесь нет. Итог звонка
 * (`call-quality.ts`) — один раз в конце; эта сводка — пока разговор идёт, чтобы «музыка лагает» было
 * видно графиком, а не словами.
 */
export interface RxTrack {
  kind: PlayoutClass;
  concealed: number;
  total: number;
  events: number;
  lost: number;
  targetMs: number;
  delayMs: number | null;
}

/**
 * Отдача за окно (R152): чем и как кодировалась своя камера и свой показ — для долей кодеков и HW/SW в
 * Grafana (`cord_client_publish_seconds_total`). Секунды — по разнице `qualityLimitationDurations`
 * самого крупного слоя, то есть по часам кодировщика, а не опроса.
 */
export interface TxTrack {
  source: PublishSource;
  codec: VideoCodec;
  hw: 'hw' | 'sw' | 'unknown';
  seconds: number;
  /** Сколько из них кодировщик ограничивал процессор, канал и прочее. */
  cpuSeconds: number;
  bandwidthSeconds: number;
  otherSeconds: number;
}

export interface RxSummary {
  tracks: RxTrack[];
  /** Своя отдача; нет — ничего не публиковали. Старое ядро поле пропускает. */
  tx?: TxTrack[];
  /** Смены кодека отдачи за окно (`cord_client_codec_switch_total`). */
  switches?: CodecSwitch[];
  /**
   * Байт отдано и принято с прошлой сводки (R239): ядро кладёт их в факт `quality` для аналитики встреч
   * (`contracts/insight.md` §2). Поля нет — считать было нечего.
   */
  bytesUp?: number;
  bytesDown?: number;
  /** Путь до медиаузла и свой микрофон за окно (R239); поля нет — измерить было нечем. */
  net?: RxNet;
}

/**
 * Путь до медиаузла за окно — для факта `quality` аналитики (`contracts/insight.md` §2): в разделе «Качество»
 * из этого складываются потери, оборот, доля звонков через TURN, замирания и переподключения по узлам.
 */
export interface RxNet {
  /** Доля потерянных пакетов приёма, 0…1. */
  loss?: number;
  /** Средний оборот до узла, мс. */
  rttMs?: number;
  /** Звонок шёл через TURN хотя бы в одном замере окна. */
  relay?: boolean;
  /** Замираний принятого видео. */
  freezes?: number;
  /** Сколько раз соединение пересобиралось. */
  reconnects?: number;
  /** Секунд с включённым микрофоном. */
  micSeconds?: number;
}

/** Что известно о пути и микрофоне в момент опроса. */
export interface LinkObservation {
  rttMs: number | null;
  relay: boolean | null;
  microphone: boolean;
}

/** Один замер отдачи источника: сколько секунд прошло и сколько из них чем ограничено. */
export interface TxObservation {
  source: PublishSource;
  codec: VideoCodec;
  hw: TxTrack['hw'];
  seconds: number;
  cpuSeconds: number;
  bandwidthSeconds: number;
  otherSeconds: number;
  /** Байт отдано за этот замер (разность `bytesSent` слоёв источника); нет — не считали. */
  bytes?: number;
}

/** Сколько записей отдачи в одной сводке: два источника, по смене кодека посреди окна. */
export const MAX_TX = 4;
/** Сколько смен кодека в одной сводке: при окне 30 с между сменами больше не бывает. */
export const MAX_SWITCHES = 8;

/** Как часто уходит сводка; ядро не примет чаще (`QualityController.WINDOW`). */
export const INTERVAL_MS = 10_000;

/** Потолок счётчика байт в сводке — тот же, что у ядра (`RxQuality.MAX_BYTES`): больше — не трафик, а сбой. */
export const MAX_BYTES = 100_000_000_000;

export interface RxObservation {
  id: string;
  kind: PlayoutClass;
  sample: PlayoutSample;
  targetMs: number;
}

interface Window {
  concealed: number;
  total: number;
  events: number;
  lost: number;
  targetMs: number;
  delays: number[];
}

const finite = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const delta = (current: PlayoutSample, previous: PlayoutSample, key: keyof PlayoutSample) =>
  Math.max(0, finite(current[key] as number | undefined) - finite(previous[key] as number | undefined));

/**
 * Счётчики байт отчёта inbound-rtp. В `PlayoutSample` их нет — он про самочувствие декодера, — но отчёт
 * приходит целиком (`playout-control.ts`), и байты читаются из него же, без второго getStats.
 */
type InboundBytes = { bytesReceived?: number; headerBytesReceived?: number };
const received = (sample: PlayoutSample) => {
  const stat = sample as PlayoutSample & InboundBytes;
  return finite(stat.bytesReceived) + finite(stat.headerBytesReceived);
};

export class RxQuality {
  private previous = new Map<string, PlayoutSample>();
  private window = new Map<PlayoutClass, Window>();
  private since: number | null = null;
  private tx = new Map<string, TxTrack>();
  private switches: CodecSwitch[] = [];
  private bytesUp = 0;
  private bytesDown = 0;
  private packetsLost = 0;
  private packetsReceived = 0;
  private freezes = 0;
  private rtts: number[] = [];
  private relay: boolean | null = null;
  private reconnects = 0;
  private micSeconds = 0;
  private linkAt: number | null = null;

  /** Замер своей отдачи (`MediaSession.sampleUpstream`, раз в 3 с). */
  observeTx(observation: TxObservation) {
    if (!(observation.seconds > 0)) return;
    this.bytesUp += Math.max(0, finite(observation.bytes));
    const key = `${observation.source}/${observation.codec}/${observation.hw}`;
    const entry = this.tx.get(key) ?? {
      source: observation.source,
      codec: observation.codec,
      hw: observation.hw,
      seconds: 0,
      cpuSeconds: 0,
      bandwidthSeconds: 0,
      otherSeconds: 0,
    };
    entry.seconds += observation.seconds;
    entry.cpuSeconds += Math.max(0, observation.cpuSeconds);
    entry.bandwidthSeconds += Math.max(0, observation.bandwidthSeconds);
    entry.otherSeconds += Math.max(0, observation.otherSeconds);
    this.tx.set(key, entry);
  }

  /**
   * Один опрос пути: оборот, идёт ли звонок через TURN и включён ли микрофон. Секунды микрофона считаются
   * от прошлого опроса; пауза длиннее пяти секунд (вкладка спала) не засчитывается.
   */
  observeLink(link: LinkObservation, now: number) {
    if (link.rttMs !== null && Number.isFinite(link.rttMs)) this.rtts.push(link.rttMs);
    if (link.relay !== null) this.relay = this.relay === true || link.relay;
    const passed = this.linkAt === null ? 0 : (now - this.linkAt) / 1000;
    this.linkAt = now;
    if (link.microphone && passed > 0 && passed <= 5) this.micSeconds += passed;
  }

  /** Соединение с узлом оборвалось и собирается заново. */
  noteReconnect() {
    this.reconnects += 1;
  }

  /** Смены кодека отдачи (`CodecPlanner.takeSwitches`). */
  noteSwitches(switches: readonly CodecSwitch[]) {
    this.switches.push(...switches);
  }

  /** Один опрос: отчёты всех подписанных дорожек с их запасом. */
  observe(observations: readonly RxObservation[], now: number) {
    if (this.since === null) this.since = now;
    const live = new Set<string>();
    for (const { id, kind, sample, targetMs } of observations) {
      live.add(id);
      const before = this.previous.get(id);
      this.previous.set(id, sample);
      // Первый отчёт дорожки — точка отсчёта, разности считать не с чего.
      if (!before) continue;
      // Счётчик дорожки пошёл заново (переподписка) — отрицательная разность не трафик.
      this.bytesDown += Math.max(0, received(sample) - received(before));
      // Потери — доля пакетов: отчёт без счётчика принятого (не inbound-rtp целиком) в неё не идёт.
      if (typeof sample.packetsReceived === 'number') {
        this.packetsLost += delta(sample, before, 'packetsLost');
        this.packetsReceived += delta(sample, before, 'packetsReceived');
      }
      this.freezes += delta(sample, before, 'freezeCount');
      const entry = this.window.get(kind) ?? {
        concealed: 0,
        total: 0,
        events: 0,
        lost: 0,
        targetMs,
        delays: [],
      };
      entry.concealed += Math.max(
        0,
        delta(sample, before, 'concealedSamples') - delta(sample, before, 'silentConcealedSamples'),
      );
      entry.total += delta(sample, before, 'totalSamplesReceived');
      entry.events += delta(sample, before, 'concealmentEvents');
      entry.lost += delta(sample, before, 'packetsLost');
      entry.targetMs = targetMs;
      const delay = measuredDelayMs(sample, before);
      if (delay !== null) entry.delays.push(delay);
      this.window.set(kind, entry);
    }
    for (const id of this.previous.keys()) if (!live.has(id)) this.previous.delete(id);
  }

  /** Сводка за окно, когда прошло {@link INTERVAL_MS}; иначе `null`. Окно начинается заново. */
  flush(now: number): RxSummary | null {
    if (this.since === null || now - this.since < INTERVAL_MS) return null;
    this.since = now;
    const tracks: RxTrack[] = [];
    for (const [kind, entry] of this.window) {
      const delays = entry.delays;
      tracks.push({
        kind,
        concealed: Math.round(entry.concealed),
        total: Math.round(entry.total),
        events: Math.round(entry.events),
        lost: Math.round(entry.lost),
        targetMs: Math.max(0, Math.round(entry.targetMs)),
        delayMs: delays.length
          ? Math.round(delays.reduce((sum, value) => sum + value, 0) / delays.length)
          : null,
      });
    }
    this.window.clear();
    const round = (value: number) => Math.round(Math.min(60, value) * 10) / 10;
    const tx = [...this.tx.values()]
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, MAX_TX)
      .map((entry) => ({
        ...entry,
        seconds: round(entry.seconds),
        cpuSeconds: round(Math.min(entry.cpuSeconds, entry.seconds)),
        bandwidthSeconds: round(Math.min(entry.bandwidthSeconds, entry.seconds)),
        otherSeconds: round(Math.min(entry.otherSeconds, entry.seconds)),
      }));
    const switches = this.switches.slice(-MAX_SWITCHES);
    const bytesUp = Math.min(MAX_BYTES, Math.round(this.bytesUp));
    const bytesDown = Math.min(MAX_BYTES, Math.round(this.bytesDown));
    const net = this.takeNet();
    this.tx.clear();
    this.switches = [];
    this.bytesUp = 0;
    this.bytesDown = 0;
    if (!tracks.length && !tx.length && !switches.length && !bytesUp && !bytesDown && !net) return null;
    return {
      tracks,
      ...(tx.length ? { tx } : {}),
      ...(switches.length ? { switches } : {}),
      ...(bytesUp ? { bytesUp } : {}),
      ...(bytesDown ? { bytesDown } : {}),
      ...(net ? { net } : {}),
    };
  }

  /** Путь за окно; счётчики окна начинаются заново. Ничего не измерено — `null`. */
  private takeNet(): RxNet | null {
    const packets = this.packetsLost + this.packetsReceived;
    const net: RxNet = {
      ...(packets > 0 ? { loss: Math.round((this.packetsLost / packets) * 10_000) / 10_000 } : {}),
      ...(this.rtts.length
        ? { rttMs: Math.min(60_000, Math.round(this.rtts.reduce((sum, v) => sum + v, 0) / this.rtts.length)) }
        : {}),
      ...(this.relay !== null ? { relay: this.relay } : {}),
      ...(this.freezes > 0 ? { freezes: Math.min(100_000, Math.round(this.freezes)) } : {}),
      ...(this.reconnects > 0 ? { reconnects: Math.min(1_000, this.reconnects) } : {}),
      ...(this.micSeconds > 0 ? { micSeconds: Math.round(Math.min(60, this.micSeconds) * 10) / 10 } : {}),
    };
    this.packetsLost = this.packetsReceived = this.freezes = this.reconnects = this.micSeconds = 0;
    this.rtts = [];
    this.relay = null;
    return Object.keys(net).length ? net : null;
  }

  /** Соединение пересобрано: прежние счётчики ни о чём не говорят, окно начинается заново. */
  reset() {
    this.previous.clear();
    this.window.clear();
    this.since = null;
    // Отдача, смены кодека и уже сосчитанные байты копятся по своим часам и переподключения переживают.
  }
}
