import type { ReactNode } from 'react';

/**
 * Полка витрины: заголовок, дверь «Все…» и один ряд карточек, который листают вбок.
 *
 * ПОЧЕМУ РЯД, А НЕ СЕТКА. Полок на витрине несколько, и сеткой первая закрыла бы собой вторую:
 * тридцать эфиров — это четыре экрана, и до сериалов под ними никто не долистал бы. Ряд держит
 * каждую полку в одну строку, а целиком она открывается дверью «Все…» — обычной страницей с
 * «Показать ещё». Пальцем ряд листают вбок, мышью — колесом с Shift или полосой прокрутки;
 * клавиатура доезжает до карточки за краем сама, фокусом.
 */
export function Shelf({
  title,
  kind,
  more,
  onMore,
  children,
}: {
  title: string;
  /** Форма карточек ряда: кадры 16:9 (по умолчанию), постеры 2:3 или лица сообществ и каналов. */
  kind?: 'wide' | 'tall' | 'faces';
  /** Подпись двери на полку целиком — и сама дверь; без неё полка без двери. */
  more?: string;
  onMore?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="cinema-shelf-block" aria-label={title}>
      <header className="cinema-shelf-head">
        <h4 className="cinema-heading">{title}</h4>
        {more && onMore ? (
          <button className="text-button" onClick={onMore}>
            {more}
          </button>
        ) : null}
      </header>
      <div className={kind === 'tall' || kind === 'faces' ? `cinema-row cinema-row-${kind}` : 'cinema-row'}>
        {children}
      </div>
    </section>
  );
}
