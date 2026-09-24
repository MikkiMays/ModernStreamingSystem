import type { ReactNode } from 'react';
import { Eye, Gamepad2, ListVideo, LoaderCircle, Play, Tv, Users } from 'lucide-react';
import { clock, viewers, type CinemaItem } from '../../../core/cinema';

/*
  Плитки каталога. Какую плитку взять для карточки и что значит нажатие — решает сцена: у одной
  площадки карточка канала — дверь на его страницу, у другой — идущий эфир, который включают.
  Плитка об этом не знает и площадок по имени не различает: ей говорят, можно ли смотреть
  карточку прямо отсюда (`playable`) и куда вести.
*/

/** Как лежат плитки: широкими кадрами, вертикальными обложками разделов или лицами каналов. */
export type GridKind = 'wide' | 'boxes' | 'faces';

export function Grid({ kind = 'wide', children }: { kind?: GridKind; children: ReactNode }) {
  return (
    <div className={kind === 'wide' ? 'cinema-grid' : `cinema-grid cinema-grid-${kind}`}>{children}</div>
  );
}

/** Ролик или эфир: кадр, длительность или «В эфире», и «Смотреть вместе» прямо на обложке. */
export function Tile({
  item,
  playable,
  canUse,
  busy,
  onWatch,
  onEnter,
  onChannel,
}: {
  item: CinemaItem;
  /** Смотрится ли это вместе прямо отсюда, или в это заходят. */
  playable: boolean;
  canUse: boolean;
  /** Какую карточку прямо сейчас включают комнате (её `id`), или пусто. */
  busy: string;
  onWatch: (item: CinemaItem) => void;
  onEnter: (item: CinemaItem) => void;
  onChannel: (id: string) => void;
}) {
  return (
    <article className="cinema-tile">
      <span className="cinema-poster">
        {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <Tv size={26} />}
        {item.live ? (
          <span className="cinema-live">В эфире</span>
        ) : (
          item.duration && <span className="cinema-duration">{clock(item.duration)}</span>
        )}
        {playable && (
          <button
            className="cinema-start"
            disabled={!canUse || !!busy}
            aria-label={`Смотреть вместе: ${item.title}`}
            onClick={() => void onWatch(item)}
          >
            {busy === item.id ? <LoaderCircle size={20} /> : <Play size={20} />}
          </button>
        )}
      </span>
      {/* Растянутая кнопка вместо обёртки всей плитки: внутрь плитки нужны ещё две кнопки, а
          кнопка в кнопке — это ни разметка, ни клавиатура. */}
      <button className="cinema-open" aria-label={`Подробнее: ${item.title}`} onClick={() => onEnter(item)} />
      <b className="cinema-tile-title">{item.title}</b>
      <span className="cinema-tile-meta">
        {item.channelId ? (
          <button className="cinema-author" onClick={() => onChannel(String(item.channelId))}>
            {item.author || 'Канал'}
          </button>
        ) : (
          <span>{item.author}</span>
        )}
        {viewers(item.viewers) && (
          <span>
            <Users size={11} /> {viewers(item.viewers)}
          </span>
        )}
        {!item.viewers && viewers(item.views) && (
          <span>
            <Eye size={11} /> {viewers(item.views)}
          </span>
        )}
        {item.category && <span className="cinema-chip">{item.category}</span>}
      </span>
    </article>
  );
}

/** Плейлист: та же обложка, но с корешком стопки и числом роликов. В него заходят. */
export function PlaylistTile({ item, onEnter }: { item: CinemaItem; onEnter: (item: CinemaItem) => void }) {
  return (
    <article className="cinema-tile cinema-tile-list">
      <span className="cinema-poster">
        {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <ListVideo size={26} />}
        <span className="cinema-stack">
          <ListVideo size={13} />
          {item.count ? `${item.count}` : 'Плейлист'}
        </span>
      </span>
      <button
        className="cinema-open"
        aria-label={`Открыть плейлист: ${item.title}`}
        onClick={() => onEnter(item)}
      />
      <b className="cinema-tile-title">{item.title}</b>
      <span className="cinema-tile-meta">
        <span>{item.author}</span>
      </span>
    </article>
  );
}

/** Раздел: вертикальная обложка, как на самой площадке, и сколько его смотрят. */
export function CategoryTile({ item, onEnter }: { item: CinemaItem; onEnter: (item: CinemaItem) => void }) {
  return (
    <article className="cinema-tile cinema-tile-box">
      <span className="cinema-box">
        {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <Gamepad2 size={26} />}
      </span>
      <button
        className="cinema-open"
        aria-label={`Открыть раздел: ${item.title}`}
        onClick={() => onEnter(item)}
      />
      <b className="cinema-tile-title">{item.title}</b>
      <span className="cinema-tile-meta">
        {viewers(item.viewers) && (
          <span>
            <Users size={11} /> {viewers(item.viewers)}
          </span>
        )}
      </span>
    </article>
  );
}

/** Канал в результатах поиска: лицо, имя, псевдоним и сколько подписано. */
export function ChannelTile({ item, onEnter }: { item: CinemaItem; onEnter: (item: CinemaItem) => void }) {
  return (
    <article className="cinema-tile cinema-tile-face">
      <span className="cinema-face">
        {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <Tv size={22} />}
      </span>
      <button
        className="cinema-open"
        aria-label={`Открыть канал: ${item.title}`}
        onClick={() => onEnter(item)}
      />
      <b className="cinema-tile-title">{item.title}</b>
      <span className="cinema-tile-meta">
        {item.author && <span>{item.author}</span>}
        {viewers(item.followers) && <span>{viewers(item.followers)} подписчиков</span>}
      </span>
    </article>
  );
}
