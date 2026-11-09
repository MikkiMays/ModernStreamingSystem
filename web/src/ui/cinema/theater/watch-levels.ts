import type { Translate } from '../../../i18n';

/**
 * Ступень качества так, как её видит меню: высота, битрейт и кодек — из плейлиста.
 *
 * Человеку не предлагаем ступень чужого кодека (`foreign`: переключать декодер посреди фильма ради выбора
 * высоты — значит рвать картинку) и ступень, которую устройство не декодирует плавно (`fit: false`,
 * `MediaCapabilities`, `engines/hls.ts`). Нет поля — не знаем, предлагаем.
 */
export interface Level {
  height?: number;
  bitrate?: number;
  videoCodec?: string;
  attrs?: Record<string, string | undefined>;
  /** Устройство декодирует ступень плавно (`MediaCapabilities`); нет поля — не знаем. */
  fit?: boolean;
  /** Кодек не тот, на котором играет просмотр: выбор высоты не должен переключать декодер. */
  foreign?: boolean;
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
 * потянет: кодек просмотра выбирает движок (`decode.ts`, `device.videoCodecs`) и помечает чужие кодеки
 * (`foreign`) и неплавные ступени (`fit: false`); из оставшихся на высоту — лучшая по битрейту.
 */
export function qualities(t: Translate, levels: Level[]): Quality[] {
  const own = levels.some((level) => !level.foreign);
  const plain = levels.some((level) => !level.foreign && level.fit !== false);
  const best = new Map<string, { level: number; bitrate: number; height: number; fast: boolean }>();
  levels.forEach((level, index) => {
    /*
      Чужой кодек не предлагаем никогда (пока есть свой); неплавное — пока есть плавное: помечено всё —
      значит, обещания `MediaCapabilities` врут, и лучше меню своего кодека, чем пустота.
    */
    if (own && level.foreign) return;
    if (plain && level.fit === false) return;
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
