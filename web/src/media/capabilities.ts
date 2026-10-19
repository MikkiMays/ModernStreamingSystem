import type { FrameRate, Resolution, ScreenProfile } from './profiles';

/**
 * Правила качества видео, которые задаёт сервер.
 *
 * ЗАЧЕМ. Списки «720/1080/1440 × 15/30/60», уровень по умолчанию и потолок жили в четырёх файлах
 * веба и ещё раз в ядре, и ни одно из этих мест не знало о других. По П2 умолчание и потолок задаёт
 * тот, кто ставит сервер (`application.yml` → `stream.media.quality` → `capabilities.quality`), а
 * клиент исполняет. Это единственный модуль, который читает `capabilities.quality`; остальные
 * спрашивают у него.
 *
 * Ответ сервера запоминается в `localStorage`: настройки читаются синхронно и до всякой сети
 * (`readPreferences`), а правила нужны уже там — чтобы сохранённое «Авто» или 1440p превратить в
 * допустимый уровень. Сервер без поля `quality` (старее этой правки) даёт встроенные умолчания —
 * те же, что стоят в `application.yml`.
 */
export interface Level {
  resolution: Resolution;
  fps: FrameRate;
}
export interface QualityRules {
  /** С чего начинает каждый, пока не выбрал иначе. */
  default: Level;
  /** Выше этого выбрать нельзя — ни по кадру, ни по частоте. */
  ceiling: Level;
  /** Окно разгона полосы после публикации, миллисекунды. */
  settleMs: number;
  /** Ужимать ли камеру до маленького слоя на время демонстрации экрана. */
  cameraYieldsToScreen: boolean;
}

export const RESOLUTIONS: Resolution[] = [720, 1080, 1440];
export const FRAME_RATES: FrameRate[] = [15, 30, 60];

export const builtinRules: QualityRules = {
  default: { resolution: 720, fps: 30 },
  ceiling: { resolution: 1080, fps: 60 },
  settleMs: 4000,
  cameraYieldsToScreen: false,
};

const KEY = 'cord:quality:v1';

const isResolution = (value: unknown): value is Resolution => RESOLUTIONS.includes(value as Resolution);
const isFrameRate = (value: unknown): value is FrameRate => FRAME_RATES.includes(value as FrameRate);

function readLevel(value: unknown): Level | null {
  const level = value as Partial<Level> | null | undefined;
  return level && isResolution(level.resolution) && isFrameRate(level.fps)
    ? { resolution: level.resolution, fps: level.fps }
    : null;
}

/** Правила из ответа сервера; `null`, если поля нет или оно не похоже на правила. */
export function readRules(raw: unknown): QualityRules | null {
  const value = raw as Partial<QualityRules> | null | undefined;
  if (!value || typeof value !== 'object') return null;
  const initial = readLevel(value.default);
  const ceiling = readLevel(value.ceiling);
  if (!initial || !ceiling || !within(initial, ceiling)) return null;
  return {
    default: initial,
    ceiling,
    settleMs:
      typeof value.settleMs === 'number' && Number.isFinite(value.settleMs)
        ? Math.max(0, Math.min(60000, value.settleMs))
        : builtinRules.settleMs,
    cameraYieldsToScreen: value.cameraYieldsToScreen === true,
  };
}

/** Не выше потолка ни по кадру, ни по частоте: 1440p30 стоит как 1080p60, но крупнее его. */
export function within(level: Level, ceiling: Level) {
  return level.resolution <= ceiling.resolution && level.fps <= ceiling.fps;
}

/**
 * Запомнить правила из ответа `capabilities`. Зовётся там, где ответ получают (`serverInfo`);
 * возвращает то, что запомнилось, — встроенные умолчания, если сервер правил не прислал.
 */
export function rememberQuality(capabilities: unknown): QualityRules {
  const rules = readRules((capabilities as { quality?: unknown } | null | undefined)?.quality);
  try {
    if (rules) localStorage.setItem(KEY, JSON.stringify(rules));
    else localStorage.removeItem(KEY);
  } catch {
    /* Без хранилища правила живут до перезагрузки страницы — у вызывающего они уже есть. */
  }
  return rules ?? builtinRules;
}

export function qualityRules(): QualityRules {
  try {
    return readRules(JSON.parse(localStorage.getItem(KEY) ?? 'null')) ?? builtinRules;
  } catch {
    return builtinRules;
  }
}

/** Что можно выбрать: допустимые разрешения и частоты не выше потолка. */
export function qualityLevels(rules = qualityRules()) {
  return {
    resolutions: RESOLUTIONS.filter((value) => value <= rules.ceiling.resolution),
    frameRates: FRAME_RATES.filter((value) => value <= rules.ceiling.fps),
  };
}

/**
 * Ближайший допустимый уровень к сохранённому.
 *
 * Сохранённое «Авто» (`automatic: true` из прежних записей) — это уровень по умолчанию: лестницы
 * больше нет. Сохранённые 1440p при потолке 1080p — потолок; частота выше потолка — потолок;
 * незнакомое число — умолчание. Запись при этом не трогается: следующий сервер может разрешать
 * больше, и выбор человека тогда вернётся сам.
 */
export function nearestLevel(
  saved: (Partial<ScreenProfile> & { automatic?: unknown }) | null | undefined,
  rules = qualityRules(),
): ScreenProfile {
  if (!saved || saved.automatic === true) return { ...rules.default };
  const resolution = isResolution(saved.resolution)
    ? Math.min(saved.resolution, rules.ceiling.resolution)
    : rules.default.resolution;
  const fps = isFrameRate(saved.fps) ? Math.min(saved.fps, rules.ceiling.fps) : rules.default.fps;
  return { resolution: resolution as Resolution, fps: fps as FrameRate };
}

export function settleMs(rules = qualityRules()) {
  return rules.settleMs;
}

export function cameraYieldsToScreen(rules = qualityRules()) {
  return rules.cameraYieldsToScreen;
}
