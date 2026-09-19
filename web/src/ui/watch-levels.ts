/**
 * Список качеств для человека из списка уровней HLS.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ ФАЙЛ. Меню качества было прямым отражением `hls.levels` — и выглядело
 * так: «1080p, 1080p, 1080p, 720p, 720p, 480p, 480p, 240p, 240p, 240p, 144p, 144p, 144p».
 * Это не ошибка отрисовки: YouTube и правда отдаёт одну и ту же высоту несколько раз — в
 * H.264, в VP9 и вторым потоком VP9 с повышенным битрейтом. Выбирать между «1080p» и «1080p»
 * человеку нечем, и никакой подписи, которая объяснила бы разницу, тут не придумать.
 *
 * Поэтому уровни группируются по тому, что человек на экране и различает, — по высоте кадра и
 * по частоте, — а внутри группы берётся **самый дешёвый** поток. Это не экономия в ущерб
 * картинке: при равной высоте меньший битрейт означает более новый кодек (VP9 против H.264), и
 * ровно этот вариант сам YouTube и отдаёт обычному зрителю. А поток у нас идёт через свой
 * сервер каждому зрителю отдельно, и лишние два мегабита на человека здесь стоят дороже, чем
 * где-либо ещё.
 */
export interface Level {
  height?: number;
  bitrate?: number;
  attrs?: Record<string, string | undefined>;
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

export function levelLabel(level: Level | undefined): string {
  if (!level) return '';
  if (level.height) return `${level.height}p${smooth(level) ? '60' : ''}`;
  return level.bitrate ? `${Math.round(level.bitrate / 1000)} кбит/с` : 'Как есть';
}

export function qualities(levels: Level[]): Quality[] {
  const best = new Map<string, { level: number; bitrate: number; height: number; fast: boolean }>();
  levels.forEach((level, index) => {
    const label = levelLabel(level);
    const bitrate = level.bitrate ?? Number.MAX_SAFE_INTEGER;
    const kept = best.get(label);
    if (!kept || bitrate < kept.bitrate)
      best.set(label, { level: index, bitrate, height: level.height ?? 0, fast: smooth(level) });
  });
  return (
    [...best.entries()]
      // Сверху лучшее: так список читается как лестница, а не как история переговоров с площадкой.
      .sort(
        (a, b) =>
          b[1].height - a[1].height || Number(b[1].fast) - Number(a[1].fast) || a[1].bitrate - b[1].bitrate,
      )
      .map(([label, kept]) => ({ level: kept.level, label }))
  );
}
