/**
 * Сколько звука держать про запас, прежде чем его услышат.
 *
 * ЗАЧЕМ ЭТО ПЕРЕПИСАНО ВТОРОЙ РАЗ (ревью 1.0.3, R02/R03). Первая версия перестала просить
 * нулевой буфер — и правильно. Но она принимала **потери пакетов** за нехватку запаса: любая
 * слышимая заглушка больше 0,4 % добавляла 150 мс каждые две секунды, а потерянный пакет
 * создаёт заглушку ровно так же, как опоздавший. На канале с 1 % потерь (VPN) цель музыки
 * уезжала до потолка 2500 мс за 24 секунды и не возвращалась никогда: спуск 50 мс за
 * 30 секунд спокойствия, а спокойствие при потерях не наступало. У владельца на скрине —
 * 6 % потерь и буфер 1723–2489 мс. Второй слушатель без потерь сидел на 400 — разброс в две
 * секунды, и «все в одной секунде» было невозможно по построению.
 *
 * ЧТО ВМЕСТО. Три правила.
 *
 * 1. **Запас лечит джиттер, а не потери и не обрывы.** Потерянный пакет не придёт позже,
 *    сколько ни жди; замирание хоста на 30 с не переждёт никакой буфер. Поднимать запас
 *    стоит только тогда, когда заглушка **частая и короткая** — это и есть опоздавшие
 *    пакеты. Считаем события заглушки (`concealmentEvents`), вычитаем те, что объясняются
 *    потерями (`packetsLost`), и смотрим на среднюю длину события.
 * 2. **Музыка — почти фиксированный запас, одинаковый у всех.** Потолок 1000 мс: тогда
 *    двое слушателей расходятся не больше чем на полсекунды плюс разница их сетей. Это и
 *    есть «одна секунда для всех».
 * 3. **Разовое событие — разовый ответ.** Пачка после задержки раздувает буфер — NetEq
 *    сам его ускорит за секунду, а если буфер раздуло на секунды, дорожку дешевле
 *    переподписать (`resync`), чем жить с этой задержкой до конца встречи.
 *
 * Режимов «минимальная задержка / устойчивость» больше нет (R06): число не настраивается,
 * потому что настраивать нечего — разговор остаётся коротким, музыка стоит на месте.
 *
 * Мы не отключаем и не подменяем jitter buffer браузера. `jitterBufferTarget` — пожелание:
 * браузер вправе удержать больше запрошенного.
 */

import type { LinkState } from './link-quality';

/** Что это за дорожка с точки зрения допустимой задержки. */
export type PlayoutClass = 'conversation' | 'media' | 'video';

export interface PlayoutProfile {
  /** Ниже этого не опускаемся даже на идеальном канале. */
  floorMs: number;
  /** С чего начинаем, пока о канале ничего не известно. */
  startMs: number;
  /** Выше этого задержка перестаёт быть платой за непрерывность. */
  ceilingMs: number;
  /** Сколько нужно спокойных миллисекунд, прежде чем начать снижать запас. */
  calmMs: number;
  /** На сколько снижаем за один шаг. */
  stepMs: number;
  /** На сколько поднимаем за один опрос, когда беда настоящая. */
  riseMs: number;
}

// Chrome ограничивает jitterBufferTarget четырьмя секундами, а NetEq и без того не хранит
// больше: просить сверх этого — значит просить то, чего не будет.
export const MAX_TARGET_MS = 4000;
/** Частота дискретизации Opus в WebRTC: все счётчики отсчётов — в ней. */
export const SAMPLE_RATE = 48000;

const BASE: Record<PlayoutClass, PlayoutProfile> = {
  // Разговор. Четыреста — уже заметная пауза перед ответом, дальше начинается рация.
  conversation: { floorMs: 60, startMs: 120, ceilingMs: 400, calmMs: 8000, stepMs: 20, riseMs: 60 },
  // Музыка и звук демонстрации. Никто не ждёт от них ответа, но и уезжать им некуда:
  // потолок — секунда, чтобы все слушали одно и то же место.
  media: { floorMs: 500, startMs: 600, ceilingMs: 1000, calmMs: 10000, stepMs: 100, riseMs: 100 },
  // Видео идёт за своим звуком (см. `group` в playout-control); собственные границы нужны
  // ему, когда звука рядом нет вовсе, и чтобы не уехать от него слишком далеко.
  video: { floorMs: 80, startMs: 150, ceilingMs: 600, calmMs: 15000, stepMs: 25, riseMs: 150 },
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * Профиль с поправкой на то, каким путём идёт медиа.
 *
 * Упорядоченный путь (TURN поверх TCP/TLS) обязан переспросить потерянный пакет и задержать
 * всё, что пришло следом. Запас меньше одного оборота там бесполезен по определению, поэтому
 * пол поднимается до полутора RTT, а не до какого-то красивого числа.
 */
export function profileFor(kind: PlayoutClass, link?: LinkState): PlayoutProfile {
  const base = BASE[kind];
  let { floorMs, startMs, ceilingMs } = base;
  if (link?.ordered) {
    const retransmit = Math.round((link.rttMs ?? 200) * 1.5);
    const extra = kind === 'conversation' ? 150 : 300;
    floorMs = Math.max(floorMs, Math.min(retransmit, 900) + extra);
    ceilingMs = Math.max(ceilingMs, floorMs + 400);
  }
  if (link?.grade === 'poor') startMs = Math.max(startMs, Math.round(startMs * 1.5));
  startMs = clamp(startMs, floorMs, ceilingMs);
  return {
    floorMs: clamp(floorMs, 0, MAX_TARGET_MS),
    startMs: clamp(startMs, 0, MAX_TARGET_MS),
    ceilingMs: clamp(Math.max(ceilingMs, floorMs), 0, MAX_TARGET_MS),
    calmMs: base.calmMs,
    stepMs: base.stepMs,
    riseMs: base.riseMs,
  };
}

/** Поля inbound-rtp, по которым видно самочувствие декодера. Всё необязательное. */
export interface PlayoutSample {
  timestamp: number;
  jitter?: number;
  totalSamplesReceived?: number;
  concealedSamples?: number;
  silentConcealedSamples?: number;
  /** Сколько раз заглушка начиналась. Частые короткие — джиттер, одна длинная — обрыв. */
  concealmentEvents?: number;
  packetsLost?: number;
  packetsReceived?: number;
  removedSamplesForAcceleration?: number;
  insertedSamplesForDeceleration?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  framesReceived?: number;
  framesDecoded?: number;
  /** У видео нет `concealedSamples`: там то же самое называется замиранием. */
  freezeCount?: number;
  totalFreezesDuration?: number;
}

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Насколько буфер и правда полон, в миллисекундах, по разнице двух отчётов. */
export function measuredDelayMs(current: PlayoutSample, previous: PlayoutSample): number | null {
  const emitted = (current.jitterBufferEmittedCount ?? 0) - (previous.jitterBufferEmittedCount ?? 0);
  const delay = (current.jitterBufferDelay ?? 0) - (previous.jitterBufferDelay ?? 0);
  return emitted > 0 && delay >= 0 ? (delay / emitted) * 1000 : null;
}

/** Чем была заглушка за интервал: опоздавшими пакетами, потерянными или обрывом. */
export type TroubleKind = 'none' | 'jitter' | 'loss' | 'outage';

/** Длиннее этого одно событие заглушки — уже не опоздание, а дыра в потоке. */
export const OUTAGE_EVENT_MS = 500;
/** Короче этого среднее событие — это опоздавшие пакеты, против которых запас и нужен. */
export const JITTER_EVENT_MS = 120;
/** Столько событий сверх объяснимых потерями нужно за опрос, чтобы признать джиттер. */
export const JITTER_EVENTS = 3;
/** Буфер раздуло настолько выше потолка, что дешевле переподписаться, чем ждать. */
export const RESYNC_EXCESS_MS = 1000;

/**
 * Разбор заглушки за интервал.
 *
 * Каждый потерянный пакет создаёт не больше одного события, поэтому события сверх потерь —
 * это опоздания. Одно событие длиннее полусекунды — обрыв (замирание хоста, смена сети):
 * против него запас бессилен, а поднимать его на каждом таком опросе — значит уехать на
 * секунды к концу первой же дыры.
 */
export function classifyTrouble(input: {
  concealedSamples: number;
  events: number;
  lost: number;
  sampleRate?: number;
}): TroubleKind {
  const rate = input.sampleRate ?? SAMPLE_RATE;
  if (input.concealedSamples <= 0) return 'none';
  // Заглушка идёт, а новых событий нет — продолжается одно длинное: обрыв ещё не кончился.
  if (input.events <= 0) return 'outage';
  const averageMs = (input.concealedSamples / input.events / rate) * 1000;
  if (averageMs >= OUTAGE_EVENT_MS) return 'outage';
  const unexplained = input.events - Math.max(0, input.lost);
  if (unexplained >= JITTER_EVENTS && averageMs < JITTER_EVENT_MS) return 'jitter';
  return input.lost > 0 ? 'loss' : 'none';
}

export interface PlayoutDecision {
  targetMs: number;
  /** Слышимая заглушка: доля подставленного звука, не считая тишины DTX. */
  concealRatio: number;
  /** Сколько звука NetEq выбросил, догоняя цель. Именно это слышно как ускорение. */
  accelerationRatio: number;
  /** Сколько раз картинка замерла за интервал. Для видео это и есть «сломалось». */
  freezes: number;
  measuredMs: number | null;
  /** Чем объясняется заглушка за интервал. */
  trouble: TroubleKind;
  /** Буфер раздуло на секунды: дорожку стоит переподписать, а не жить с этим. */
  resync: boolean;
}

/**
 * Решение по одной дорожке. Вверх — по признаку джиттера, вниз — шагами после спокойствия.
 * Потери и обрывы цель не двигают ни вверх, ни вниз: они о канале говорят, а о запасе — нет.
 */
export class PlayoutBuffer {
  private previous?: PlayoutSample;
  private targetMs: number;
  private peakJitterMs = 0;
  private calmSince: number;
  private profile: PlayoutProfile;
  constructor(
    readonly kind: PlayoutClass,
    profile: PlayoutProfile,
    now = Date.now(),
  ) {
    this.profile = profile;
    this.targetMs = profile.startMs;
    this.calmSince = now;
  }

  get target() {
    return this.targetMs;
  }

  /** Канал сменил природу (UDP ↔ TCP): накопленное остаётся, границы — новые. */
  retune(profile: PlayoutProfile) {
    this.profile = profile;
    this.targetMs = clamp(this.targetMs, profile.floorMs, profile.ceilingMs);
  }

  observe(current: PlayoutSample, now = Date.now()): PlayoutDecision {
    const previous = this.previous;
    this.previous = current;
    const dt = previous ? current.timestamp - previous.timestamp : 0;
    const samples =
      previous && current.totalSamplesReceived !== undefined && previous.totalSamplesReceived !== undefined
        ? current.totalSamplesReceived - previous.totalSamplesReceived
        : 0;
    // Перезапуск дорожки обнуляет счётчики. Сравнивать с прошлым тогда нельзя, а вот
    // накопленную цель сбрасывать незачем: канал от переподписки лучше не стал.
    const usable = !!previous && dt > 0 && dt < 10000 && samples >= 0;
    const measured = usable ? measuredDelayMs(current, previous!) : null;
    const delta = (key: keyof PlayoutSample) =>
      usable
        ? Math.max(
            0,
            ((current[key] as number | undefined) ?? 0) - ((previous![key] as number | undefined) ?? 0),
          )
        : 0;
    const concealed = Math.max(0, delta('concealedSamples') - delta('silentConcealedSamples'));
    const removed = delta('removedSamplesForAcceleration');
    const concealRatio = usable && samples > 0 ? concealed / samples : 0;
    const accelerationRatio = usable && samples > 0 ? removed / samples : 0;
    const freezes = delta('freezeCount');
    const trouble: TroubleKind =
      this.kind === 'video'
        ? 'none'
        : classifyTrouble({
            concealedSamples: concealed,
            events: delta('concealmentEvents'),
            lost: delta('packetsLost'),
          });

    const jitterMs = (finite(current.jitter) ?? 0) * 1000;
    this.peakJitterMs = Math.max(jitterMs, this.peakJitterMs * 0.8);

    const profile = this.profile;
    // Классическая оценка: запас в четыре джиттера покрывает почти все всплески того же
    // порядка. Это нижняя граница разумного, а не цель сама по себе.
    let want = Math.max(profile.floorMs, Math.round(this.peakJitterMs * 4));

    let troubled = false;
    if (this.kind === 'video' && freezes > 0) {
      // У картинки нет заглушки: кадр либо успел, либо изображение замерло.
      want = Math.max(want, this.targetMs + profile.riseMs);
      troubled = true;
    } else if (trouble === 'jitter') {
      want = Math.max(want, this.targetMs + profile.riseMs);
      troubled = true;
    }
    if (troubled) this.calmSince = now;

    if (want < this.targetMs) {
      if (now - this.calmSince < profile.calmMs) want = this.targetMs;
      else {
        want = Math.max(want, this.targetMs - profile.stepMs);
        this.calmSince = now;
      }
    }
    this.targetMs = clamp(Math.round(want), profile.floorMs, profile.ceilingMs);
    // Буфер раздуло пачкой далеко за потолок: NetEq будет выбрасывать звук, догоняя цель,
    // секунды подряд. Переподписка стоит доли секунды и ставит всё на место.
    const resync = measured !== null && measured > profile.ceilingMs + RESYNC_EXCESS_MS;
    return {
      targetMs: this.targetMs,
      concealRatio,
      accelerationRatio,
      freezes,
      measuredMs: measured,
      trouble,
      resync,
    };
  }
}

/**
 * Просит у приёмника заданный запас.
 *
 * `jitterBufferTarget` — стандартное поле и измеряется в миллисекундах; `playoutDelayHint` —
 * старое, в секундах, и в отличие от первого способно задержку не только поднять, но и
 * закрепить. Поэтому второе используется только там, где первого нет вовсе.
 *
 * Ни одна из этих настроек не обязана поддерживаться: частично реализованный API не должен
 * мешать подписке и воспроизведению, поэтому любая ошибка здесь проглатывается.
 */
export function applyPlayoutTarget(receiver: RTCRtpReceiver | undefined, targetMs: number): boolean {
  if (!receiver) return false;
  const value = clamp(Math.round(targetMs), 0, MAX_TARGET_MS);
  if ('jitterBufferTarget' in receiver) {
    try {
      (receiver as RTCRtpReceiver & { jitterBufferTarget: number | null }).jitterBufferTarget = value;
      return true;
    } catch {
      // Браузер объявил поле, но не принял значение: пробуем старый путь.
    }
  }
  if ('playoutDelayHint' in receiver) {
    try {
      (receiver as RTCRtpReceiver & { playoutDelayHint: number | null }).playoutDelayHint = value / 1000;
      return true;
    } catch {
      // Остаётся собственная адаптация движка — она всё это время и работала.
    }
  }
  return false;
}
