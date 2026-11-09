import type { Translate } from '../../../i18n';

/**
 * Ступень качества так, как её видит меню: высота, битрейт и кодек — из плейлиста.
 *
 * `fit: false` — эту ступень человеку не предлагаем: её кодек не тот, на котором играет просмотр
 * (переключать декодер посреди фильма ради выбора высоты — значит рвать картинку), или устройство не
 * декодирует её плавно (`MediaCapabilities`, `engines/hls.ts`). Нет поля — не знаем, предлагаем.
 */
export interface Level {
  height?: number;
  bitrate?: number;
  videoCodec?: string;
  attrs?: Record<string, string | undefined>;
  fit?: boolean;
}

export interface Quality {
  /** Какой уровень включить: индекс в том же `hls.levels`. */
  level: number;
  label: string;
}

/** Больше тридцати пяти кадров — это «60», сколько бы там ни было на самом деле. */
function smooth(level: Level): boolean {
  return Number(level.attrs?.['FRAME-RATE'] ?? 0) > 35;
}

export function levelLabel(t: Translate, level: Level | undefined): string {
  if (!level) return '';
  if (level.height) return `${level.height}p${smooth(level) ? '60' : ''}`;
  return level.bitrate
    ? t(($) => $.cinema.theater.quality.bitrate, { value: Math.round(level.bitrate / 1000) })
    : t(($) => $.cinema.theater.quality.source);
}

/**
 * Меню качества (R216, владелец: «давать выбирать только качество, а кодек система должна подбирать
 * сама»): одна строка на высоту и частоту кадров, без кодеков. За строкой — ступень, которую устройство
 * потянет: кодек просмотра выбирает движок (`decode.ts`, `device.videoCodecs`) и помечает чужие кодеки и
 * неплавные ступени `fit: false`; из оставшихся на высоту — лучшая по битрейту.
 */
export function qualities(t: Translate, levels: Level[]): Quality[] {
  const offered = levels.some((level) => level.fit !== false);
  const best = new Map<string, { level: number; bitrate: number; height: number; fast: boolean }>();
  levels.forEach((level, index) => {
    // Помечено всё — значит, пометки врут (кодек без ступеней): лучше меню, чем пустота.
    if (offered && level.fit === false) return;
    const label = levelLabel(t, level);
    const bitrate = level.bitrate ?? 0;
    const kept = best.get(label);
    if (!kept || bitrate > kept.bitrate)
      best.set(label, { level: index, bitrate, height: level.height ?? 0, fast: smooth(level) });
  });
  return [...best.entries()]
    .sort(([, a], [, b]) => b.height - a.height || Number(b.fast) - Number(a.fast) || b.bitrate - a.bitrate)
    .map(([label, kept]) => ({ level: kept.level, label }));
}
