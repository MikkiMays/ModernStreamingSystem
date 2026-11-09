/**
 * Кодек картинки кинозала — по силам устройства, и не один раз на старте, а весь просмотр (R216, владелец
 * 09.11.2026: «давать выбирать только качество… система должна подбирать лучший вариант и решение в любой
 * момент самостоятельно»).
 *
 * ПОЧЕМУ КОДЕК — НЕ ВЫБОР ЧЕЛОВЕКА. Одна и та же высота у YouTube есть в AV1, VP9 и H.264. Человек выбирает
 * то, что видит, — высоту; какой декодер её потянет, знает устройство, а не он. Меню качества показывает
 * одну строку на высоту (`watch-levels.ts`), кодек подбирается здесь.
 *
 * НА СТАРТЕ — `MediaCapabilities` (`device.videoCodecs`): AV1, потом VP9, если устройство обещает их
 * плавно и экономно (железом); иначе H.264.
 *
 * ПО ХОДУ — {@link DecodeWatch}: раз в секунду — сколько кадров декодер потерял (`getVideoPlaybackQuality`)
 * и вставала ли картинка при данных впереди (конвейер, а не сеть). Обещание `MediaCapabilities` — это
 * обещание; ноутбук на батарее, звонок рядом в кодировщике камеры, вкладка с тяжёлой страницей — и тот же
 * VP9 1080p60 теряет треть кадров. Тогда — тот же кадр лёгким кодеком (AV1 → VP9 → H.264) переходом ступени
 * hls.js, без переоткрытия потока; H.264 и так не тянет — ступень ниже (только у автоматики: высоту,
 * выбранную руками, не трогаем). Отказ от кодека помнится на этом устройстве ({@link DEMOTION_DAYS} дней) —
 * если шаг доказал пользу (или поводом были застревания), — и следующее видео начинается с того, что потянуло.
 *
 * ЧТОБЫ НЕ ДЁРГАТЬ: судим по окну в {@link WINDOW} с, только при игре на обычной скорости и видимой
 * вкладке; в окне должно быть не меньше {@link BAD_SECONDS} плохих секунд, и так — {@link SUSTAIN} проверок
 * подряд; после шага — передышка {@link COOLDOWN_MS};
 * обратно к тяжёлому кодеку в этом просмотре не возвращаемся; шаг, после которого потерь не стало заметно
 * меньше, значит, что дело не в декодере (частота экрана, занятый процессор), — и больше не шагаем.
 */

/** Семейства кодеков картинки — от самого экономного по байтам к самому лёгкому для декодера. */
export type VideoFamily = 'av01' | 'vp09' | 'hvc1' | 'avc1';
export const FAMILIES: readonly VideoFamily[] = ['av01', 'vp09', 'hvc1', 'avc1'];

/** Семейство по строке кодека (`avc1.640028`, `video/mp4; codecs="vp09.00.41.08"`); `''` — не знаем. */
export function familyOf(codec: string | null | undefined): VideoFamily | '' {
  const value = (codec ?? '').toLowerCase();
  if (value.includes('av01')) return 'av01';
  if (value.includes('vp09') || value.includes('vp9')) return 'vp09';
  if (value.includes('hvc1') || value.includes('hev1')) return 'hvc1';
  if (value.includes('avc1') || value.includes('avc3')) return 'avc1';
  return '';
}

/** Окно, по которому судим о потерях кадров, — столько проверок (раз в секунду). */
export const WINDOW = 10;
/** Меньше кадров в окне — судить не по чему (стоп-кадр, слайд-шоу). */
export const MIN_FRAMES = 120;
/** Доля потерянных кадров в окне, с которой декодер «не тянет». */
export const DROP_RATIO = 0.2;
/**
 * Плохое окно — не только общая доля потерь, но и столько плохих секунд в нём: вспышка в три секунды
 * (переход качества, тяжёлая сцена) окно целиком плохим не делает.
 */
export const BAD_SECONDS = 6;
/** Столько проверок подряд окно должно быть плохим. */
export const SUSTAIN = 5;
/** После шага — столько не судим: новый кодек или ступень сначала должны набрать буфер. */
export const COOLDOWN_MS = 20_000;
/** Столько застреваний при данных впереди за {@link STALL_WINDOW_MS} — это декодер, а не сеть. */
export const STALLS = 2;
export const STALL_WINDOW_MS = 180_000;
/** Больше шагов за один просмотр не делаем. */
export const MAX_STEPS = 3;
/** Шаг помог, если потерь стало хотя бы на столько меньше (доля от прежних). */
const HELPED = 0.3;

/** Счётчики `getVideoPlaybackQuality()`. */
export interface Frames {
  total: number;
  dropped: number;
}

/** Пора облегчить картинку: почему и какая была доля потерь (у застреваний — `null`). */
export interface Verdict {
  reason: 'frames' | 'stalls';
  ratio: number | null;
}

export class DecodeWatch {
  private last: Frames | null = null;
  private window: Frames[] = [];
  private bad = 0;
  private quietUntil = 0;
  private stalls: number[] = [];
  private steps = 0;
  /** Доля потерь, из-за которой сделали прошлый шаг, пока не доказано, что он помог. */
  private before: number | null = null;
  /** Прошлый шаг доказал пользу: потерь стало заметно меньше ({@link takeProven}). */
  private proven = false;
  /** Шагать больше незачем (нечего облегчать, шаги не помогали или кончились). */
  done = false;

  /**
   * Очередная проверка. `frames` — `null`, когда сейчас не судим (пауза, перемотка, стоит, вкладка
   * скрыта, скорость ≠ 1): тогда и счёт начинается заново со следующей, а окно помнит, что было.
   */
  sample(now: number, frames: Frames | null): Verdict | null {
    if (!frames) {
      this.last = null;
      this.bad = 0;
      return null;
    }
    const last = this.last;
    this.last = frames;
    // Счётчики сбросились (новый источник медиа) — это начало, а не отрицательные кадры.
    if (!last || frames.total < last.total || frames.dropped < last.dropped) return null;
    this.window = [
      ...this.window.slice(1 - WINDOW),
      { total: frames.total - last.total, dropped: frames.dropped - last.dropped },
    ];
    if (this.done || now < this.quietUntil || this.window.length < WINDOW) return null;
    const total = this.window.reduce((sum, item) => sum + item.total, 0);
    const dropped = this.window.reduce((sum, item) => sum + item.dropped, 0);
    const ratio = total > 0 ? dropped / total : 0;
    const badSeconds = this.window.filter(
      (item) => item.total > 0 && item.dropped / item.total >= DROP_RATIO,
    ).length;
    if (this.before !== null && total >= MIN_FRAMES && ratio <= this.before * (1 - HELPED)) {
      this.before = null;
      this.proven = true;
    }
    if (total < MIN_FRAMES || ratio < DROP_RATIO || badSeconds < BAD_SECONDS) {
      this.bad = 0;
      return null;
    }
    if (++this.bad < SUSTAIN) return null;
    /*
      Прошлый шаг потерь заметно не убавил — дело не в декодере (экран на 30 Гц, «Экономия энергии» Chrome,
      занятый процессор): больше не шагаем.
    */
    if (this.before !== null) {
      this.done = true;
      return null;
    }
    return { reason: 'frames', ratio };
  }

  /**
   * Шаг по потерям кадров помог — один раз `true`. Отказ от кодека стоит помнить только тогда: потери от
   * экрана на 30 Гц или «Экономии энергии» новый кодек не убавит, и неделю без AV1 из-за них — зря.
   */
  takeProven(): boolean {
    const proven = this.proven;
    this.proven = false;
    return proven;
  }

  /** Картинка встала, хотя данные впереди есть (конвейер, а не сеть). */
  stall(now: number): Verdict | null {
    this.stalls = [...this.stalls.filter((at) => now - at < STALL_WINDOW_MS), now];
    if (this.done || now < this.quietUntil || this.stalls.length < STALLS) return null;
    return { reason: 'stalls', ratio: null };
  }

  /** Шаг сделан (`verdict` — по какому поводу): окно заново, передышка; кончились шаги — `done`. */
  stepped(now: number, verdict: Verdict) {
    this.steps++;
    this.window = [];
    this.bad = 0;
    this.last = null;
    this.stalls = [];
    this.quietUntil = now + COOLDOWN_MS;
    this.before = verdict.ratio;
    if (this.steps >= MAX_STEPS) this.done = true;
  }
}

/** Ключ и срок памяти об отвергнутых кодеках — как у памяти кодеков встречи (`media/codec-memory.ts`). */
export const DEMOTION_KEY = 'cord:cinema-decode:v1';
export const DEMOTION_DAYS = 7;

interface Demotion {
  scope: string;
  family: VideoFamily;
  at: number;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Область памяти — этот браузер на этом устройстве. */
function scope(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

function read(store: Store | null, now: number): Demotion[] {
  try {
    const entries = JSON.parse(store?.getItem(DEMOTION_KEY) ?? '[]') as Demotion[];
    if (!Array.isArray(entries)) return [];
    const fresh = now - DEMOTION_DAYS * 86_400_000;
    return entries.filter((entry) => typeof entry?.at === 'number' && entry.at >= fresh);
  } catch {
    return [];
  }
}

/** Кодеки, от которых это устройство недавно отказалось посреди просмотра. */
export function demotedFamilies(now = Date.now(), store: Store | null = storage()): Set<VideoFamily> {
  const here = scope();
  return new Set(read(store, now).flatMap((entry) => (entry.scope === here ? [entry.family] : [])));
}

/** Запомнить: этот кодек устройство не потянуло. */
export function demote(family: VideoFamily, now = Date.now(), store: Store | null = storage()) {
  const here = scope();
  const kept = read(store, now).filter((entry) => !(entry.scope === here && entry.family === family));
  kept.push({ scope: here, family, at: now });
  try {
    store?.setItem(DEMOTION_KEY, JSON.stringify(kept.slice(-20)));
  } catch {
    // Хранилища нет (приватное окно, запрет сайта) — помним только этот просмотр.
  }
}
