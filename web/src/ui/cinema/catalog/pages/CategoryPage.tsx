import type { ReactNode } from 'react';
import { Gamepad2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { viewers, type CinemaItem } from '../../../../core/cinema';
import { More } from '../More';
import { Empty, Failure, Loading } from '../notes';
import { Grid } from '../tiles';
import type { Feed } from '../usePage';

/** Раздел площадки: обложка, название, сколько смотрят сейчас — и кто в нём в эфире. */
export function CategoryPage({
  category,
  title,
  note,
  feed,
  items,
  card,
}: {
  /** Шапка раздела; пусто, пока площадка её не прислала. */
  category: CinemaItem | null;
  /** Название с карточки, по которой вошли: шапка не ждёт ответа, чтобы назваться. */
  title: string;
  /** Подпись, пока площадка не сказала, сколько смотрят, — чей это раздел. */
  note: string;
  feed: Feed;
  items: CinemaItem[];
  card: (item: CinemaItem) => ReactNode;
}) {
  const { t } = useTranslation();
  const watching = viewers(t, category?.viewers);
  return (
    <>
      <header className="cinema-category-head">
        {category?.poster ? (
          <img className="cinema-box-art" src={category.poster} alt="" />
        ) : (
          <span className="cinema-box-art cinema-avatar-blank">
            <Gamepad2 size={22} />
          </span>
        )}
        <div>
          <h3>{category?.title || title}</h3>
          <small>{watching ? t(($) => $.cinema.meta.watchingNow, { value: watching }) : note}</small>
        </div>
      </header>
      {feed.isError && <Failure problem={feed.error} />}
      <Grid>{items.map(card)}</Grid>
      {feed.isFetching && !feed.isFetchingNextPage && <Loading />}
      <More
        shown={!!feed.hasNextPage}
        busy={feed.isFetchingNextPage}
        onMore={() => void feed.fetchNextPage()}
      />
      {!feed.isFetching && items.length === 0 && <Empty text={t(($) => $.cinema.category.empty)} />}
    </>
  );
}
