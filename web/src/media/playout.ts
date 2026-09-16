/**
 * Сколько звука держать про запас, прежде чем его услышат.
 *
 * ЗАЧЕМ ЭТО ПЕРЕПИСАНО. Раньше клиент просил у браузера **нулевой** буфер приёма — одинаково
 * для разговора, для музыки и для видео. На ровном канале это честный выигрыш в десятки
 * миллисекунд. На канале со скачками пинга это ровно тот механизм, который ломает звук:
 *
 *   - пакеты приходят пачкой после задержки, буфер раздувается;
 *   - NetEq видит цель «ноль» и начинает **выбрасывать** куски, догоняя её, — это слышно
 *     как ускорение музыки и как «подъеденные» слоги в речи;
 *   - следующая задержка застаёт буфер пустым, и наступает конец: заглушка, треск, тишина.
 *
 * Поэтому «то ускоряется, то ломается» — это не два разных сбоя, а две половины одного.
 * Цель «ноль» не убирает задержку, если сеть её уже создала: она только запрещает буферу
 * эту задержку пережить. Отсюда и хвост в несколько секунд после паузы — буфер всё это
 * время был полон, а приложение просило его опустошить.
 *
 * ЧТО ВМЕСТО. Цель буфера выбирается по трём вещам: что за дорожка, какой сейчас канал и
 * что говорит сам декодер о своём самочувствии. Разговор остаётся коротким, потому что в
 * разговоре задержка — это неудобство. Музыка и звук демонстрации получают право уехать
 * на секунду-другую назад: их никто не перебивает, и непрерывность для них важнее.
 * Так же поступают плееры, на которые это похоже со стороны, — только у них запас
 * измеряется десятками секунд, потому что им не нужно отвечать собеседнику.
 *
 * Мы не отключаем и не подменяем jitter buffer браузера. `jitterBufferTarget` — это
 * пожелание: браузер вправе удержать больше запрошенного. Мы лишь перестаём просить
 * заведомо недостижимое и убираем повод для вечной гонки.
 */

import type { LinkState } from './link-quality';

/** Что это за дорожка с точки зрения допустимой задержки. */
export type PlayoutClass = 'conversation' | 'media' | 'video';
/** Чего человек хочет от связи, когда сеть не даёт и того и другого сразу. */
export type NetworkMode = 'auto' | 'low-latency' | 'stable';

export interface PlayoutProfile {
  /** Ниже этого не опускаемся даже на идеальном канале. */
  floorMs: number;
  /** С чего начинаем, пока о канале ничего не известно. */
  startMs: number;
  /** Выше этого задержка перестаёт быть платой за непрерывность. */
  ceilingMs: number;
  /** Сколько нужно спокойных миллисекунд, прежде чем начать снижать запас. */
  calmMs: number;
  /** На сколько снижаем за один шаг. Вниз — медленно, вверх — сразу. */
  stepMs: number;
}

// Chrome ограничивает jitterBufferTarget четырьмя секундами, а NetEq и без того не хранит
// больше: просить сверх этого — значит просить то, чего не будет.
export const MAX_TARGET_MS = 4000;

const BASE: Record<PlayoutClass, PlayoutProfile> = {
  // Разговор. Полсекунды — это уже заметная пауза перед ответом, дальше начинается рация.
  conversation: { floorMs: 60, startMs: 120, ceilingMs: 500, calmMs: 12000, stepMs: 20 },
  // Музыка и звук демонстрации. Никто не ждёт от них ответа, поэтому запас щедрый.
  media: { floorMs: 400, startMs: 800, ceilingMs: 2500, calmMs: 30000, stepMs: 50 },
  // Видео всё равно подстраивается под свой звук, но собственный пол ему тоже нужен.
  video: { floorMs: 80, startMs: 150, ceilingMs: 1200, calmMs: 15000, stepMs: 25 },
};

const MODE_SCALE: Record<NetworkMode, { floor: number; start: number; ceiling: number }> = {
  auto: { floor: 1, start: 1, ceiling: 1 },
  // «Минимальная задержка» — осознанный выбор в пользу отзывчивости. Ноль сюда не входит:
  // он ничего не ускоряет, а только запрещает пережить всплеск.
  'low-latency': { floor: 0.5, start: 0.5, ceiling: 0.6 },
  // «Максимальная устойчивость» — когда важнее, чтобы не рвалось.
  stable: { floor: 2.5, start: 2.2, ceiling: 1.6 },
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * Профиль с поправкой на то, каким путём идёт медиа.
 *
 * Упорядоченный путь (TURN поверх TCP/TLS) обязан переспросить потерянный пакет и задержать
 * всё, что пришло следом. Запас меньше одного оборота там бесполезен по определению, поэтому
 * пол поднимается до полутора RTT, а не до какого-то красивого числа.
 */
export function profileFor(kind: PlayoutClass, mode: NetworkMode, link?: LinkState): PlayoutProfile {
  const base = BASE[kind];
  const scale = MODE_SCALE[mode];
  let floorMs = Math.round(base.floorMs * scale.floor);
  let startMs = Math.round(base.startMs * scale.start);
  let ceilingMs = Math.round(base.ceilingMs * scale.ceiling);
  if (link?.ordered) {
    const retransmit = Math.round((link.rttMs ?? 200) * 1.5);
    const extra = kind === 'conversation' ? 150 : 400;
    floorMs = Math.max(floorMs, Math.min(retransmit, 900) + (mode === 'low-latency' ? 0 : extra));
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
  };
}

/** Поля inbound-rtp, по которым видно самочувствие декодера. Всё необязательное. */
export interface PlayoutSample {
  timestamp: number;
  jitter?: number;
  totalSamplesReceived?: number;
  concealedSamples?: number;
  silentConcealedSamples?: number;
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

export interface PlayoutDecision {
  targetMs: number;
  /** Слышимая заглушка: доля подставленного звука, не считая тишины DTX. */
  concealRatio: number;
  /** Сколько звука NetEq выбросил, догоняя цель. Именно это слышно как ускорение. */
  accelerationRatio: number;
  /** Сколько раз картинка замерла за интервал. Для видео это и есть «сломалось». */
  freezes: number;
  measuredMs: number | null;
}

/**
 * Решение по одной дорожке. Вверх — по первому же признаку беды, вниз — маленькими шагами
 * и только после долгого спокойствия. Несимметрично намеренно: лишние сто миллисекунд
 * задержки человек не заметит, а один щелчок заметит обязательно.
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

  /**
   * Профиль меняется в двух разных случаях, и вести себя они должны по-разному.
   *
   * Канал сменил природу сам — накопленное знание о нём остаётся в силе, достаточно
   * подрезать цель под новые границы. Человек переключил режим — это новое намерение, и
   * ждать десять минут, пока цель дошагает до него по двадцать миллисекунд, незачем:
   * начинаем с начала, а подстройка вернёт своё за пару опросов.
   */
  retune(profile: PlayoutProfile, reseat = false) {
    this.profile = profile;
    this.targetMs = clamp(reseat ? profile.startMs : this.targetMs, profile.floorMs, profile.ceilingMs);
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
    const concealed = Math.max(
      0,
      (current.concealedSamples ?? 0) -
        (previous?.concealedSamples ?? 0) -
        Math.max(0, (current.silentConcealedSamples ?? 0) - (previous?.silentConcealedSamples ?? 0)),
    );
    const removed = Math.max(
      0,
      (current.removedSamplesForAcceleration ?? 0) - (previous?.removedSamplesForAcceleration ?? 0),
    );
    const concealRatio = usable && samples > 0 ? concealed / samples : 0;
    const accelerationRatio = usable && samples > 0 ? removed / samples : 0;
    const freezes = usable ? Math.max(0, (current.freezeCount ?? 0) - (previous?.freezeCount ?? 0)) : 0;

    const jitterMs = (finite(current.jitter) ?? 0) * 1000;
    this.peakJitterMs = Math.max(jitterMs, this.peakJitterMs * 0.8);

    const profile = this.profile;
    // Классическая оценка: запас в четыре джиттера покрывает почти все всплески того же
    // порядка. Это нижняя граница разумного, а не цель сама по себе.
    let want = Math.max(profile.floorMs, Math.round(this.peakJitterMs * 4));

    let troubled = false;
    if (this.kind === 'video' && freezes > 0) {
      // У картинки нет заглушки: кадр либо успел, либо изображение замерло. Замирание —
      // такой же признак нехватки запаса, как треск в звуке, и повод для тех же 150 мс.
      want = Math.max(want, this.targetMs + 150);
      troubled = true;
    } else if (concealRatio > 0.004) {
      // Буфер голодает — звук уже рвётся. Здесь не до шагов: добавляем сразу.
      want = Math.max(want, this.targetMs + 150);
      troubled = true;
    } else if (this.kind === 'media' && accelerationRatio > 0.01 && measured !== null) {
      // Декодер выбрасывает звук, догоняя цель, — для музыки это слышно как «поплыл темп».
      // Задержка уже набрана сетью; признаём её целью, и гонка прекращается.
      want = Math.max(want, Math.round(measured));
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
    return { targetMs: this.targetMs, concealRatio, accelerationRatio, freezes, measuredMs: measured };
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
