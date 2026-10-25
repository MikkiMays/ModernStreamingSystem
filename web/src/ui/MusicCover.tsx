import { useState } from 'react';
import { Music2 } from 'lucide-react';
import { coverUrl, type MusicTrack } from '../core/services';

/**
 * Обложка трека: своя картинка службы (`covers.py`) или знак музыки на спокойной подложке.
 *
 * Картинка — украшение, а не содержание: название трека стоит рядом текстом, поэтому `alt` пустой
 * и диктор её пропускает. Не загрузилась (трек ушёл из очереди, служба перезапустилась) — на её
 * месте тот же знак, что у трека без обложки, а не значок битой картинки.
 */
export function MusicCover({
  track,
  size = 'sm',
}: {
  track?: Pick<MusicTrack, 'cover'> | null;
  size?: 'sm' | 'lg';
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const cover = track?.cover && track.cover !== broken ? track.cover : null;
  return (
    <span className={`music-cover music-cover--${size}`} aria-hidden="true">
      {cover ? (
        <img
          src={coverUrl(cover)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setBroken(cover)}
        />
      ) : (
        <Music2 size={size === 'lg' ? 32 : 16} />
      )}
    </span>
  );
}
