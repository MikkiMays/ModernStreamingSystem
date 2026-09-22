/** Preserve source codec choices; compare bitrate only within one codec and frame size. */
export interface Level {
  height?: number;
  bitrate?: number;
  videoCodec?: string;
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

function codec(level: Level): string {
  const value = level.videoCodec ?? level.attrs?.CODECS ?? '';
  if (value.includes('avc1')) return 'H.264';
  if (value.includes('av01')) return 'AV1';
  if (value.includes('vp09') || value.includes('vp9')) return 'VP9';
  if (value.includes('hvc1') || value.includes('hev1')) return 'HEVC';
  return '';
}

export function qualities(levels: Level[]): Quality[] {
  const best = new Map<
    string,
    { level: number; bitrate: number; height: number; fast: boolean; label: string; codec: string }
  >();
  levels.forEach((level, index) => {
    const label = levelLabel(level);
    const family = codec(level);
    const key = `${label}:${family}`;
    const bitrate = level.bitrate ?? 0;
    const kept = best.get(key);
    if (!kept || bitrate > kept.bitrate)
      best.set(key, {
        level: index,
        bitrate,
        height: level.height ?? 0,
        fast: smooth(level),
        label,
        codec: family,
      });
  });
  const values = [...best.values()];
  return values
    .sort((a, b) => b.height - a.height || Number(b.fast) - Number(a.fast) || b.bitrate - a.bitrate)
    .map((kept) => ({
      level: kept.level,
      label:
        values.filter((v) => v.label === kept.label).length > 1 && kept.codec
          ? `${kept.label} · ${kept.codec}`
          : kept.label,
    }));
}
