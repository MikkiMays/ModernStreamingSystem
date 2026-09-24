import type { ReactNode } from 'react';
import { ArrowLeft, Clapperboard, Search, X } from 'lucide-react';
import { IconButton } from '../../primitives';

/**
 * Кинотеатр: каталог площадки на сцене встречи, а не строчка в боковой панели.
 *
 * ПОЧЕМУ НЕ В ПАНЕЛИ. Там он и был: узкая колонка, список в один столбец, обложка размером с
 * ноготь. Выбирают кино глазами — по кадру, по названию, по тому, сколько людей это смотрит
 * прямо сейчас, — и триста пикселей ширины отбирают ровно это. Поэтому выбор площадки сразу
 * открывает зал: широкая сетка, поиск сверху, страница канала и страница видео. Панель
 * интеграций осталась там, где ей и место, — это выключатель, а не витрина.
 *
 * ЧТО ЗДЕСЬ ЧЬЁ. Каталог — личное дело смотрящего: пока один листает, комната продолжает
 * смотреть то, что уже открыто, и звук никуда не девается. Общим становится только нажатие
 * «Смотреть вместе», и это обычная команда комнате.
 *
 * ОТКУДА ДАННЫЕ. Всё до последней обложки — с нашего сервера: у площадок браузер спросить не
 * может (из сети человека они недоступны), да и не должен — чужие адреса на странице означают
 * дырки в CSP.
 *
 * Здесь — общая оболочка любой сцены кинозала: тёмный корень и полоса сверху с «Назад» (или
 * знаком кинозала), поиском и закрытием. Между знаком и поиском сцена ставит своё — у YouTube и
 * Twitch это переключатель площадок.
 */
export function Shell({
  onBack,
  tabs,
  query,
  placeholder,
  onSearch,
  onClear,
  watching,
  onClose,
  locked,
  error,
  children,
}: {
  /** Назад по стопке; пока идти некуда, на месте кнопки стоит знак кинозала. */
  onBack?: () => void;
  /** Что стоит в полосе между знаком и поиском. */
  tabs?: ReactNode;
  query: string;
  placeholder: string;
  /** Набор текста в поле поиска. */
  onSearch: (query: string) => void;
  /** Крестик в поле поиска. */
  onClear: () => void;
  /** Комната уже что-то смотрит: значит, закрытие каталога возвращает к плееру, а не в разговор. */
  watching: boolean;
  onClose: () => void;
  /** Включать комнате нельзя — ведущий оставил интеграции себе. */
  locked: boolean;
  /** Почему не включилось то, что нажали. */
  error: string;
  children: ReactNode;
}) {
  return (
    <section className="cinema-browser" aria-label="Кинотеатр">
      <header className="cinema-bar">
        {onBack ? (
          <IconButton label="Назад" onClick={onBack}>
            <ArrowLeft size={19} />
          </IconButton>
        ) : (
          <span className="cinema-mark" aria-hidden="true">
            <Clapperboard size={19} />
          </span>
        )}
        {tabs}
        <label className="cinema-search">
          <Search size={16} />
          <input
            value={query}
            autoFocus
            placeholder={placeholder}
            onChange={(event) => onSearch(event.target.value)}
          />
          {query && (
            <button className="icon-button" aria-label="Очистить поиск" onClick={() => onClear()}>
              <X size={15} />
            </button>
          )}
        </label>
        <IconButton label={watching ? 'Вернуться к просмотру' : 'Закрыть кинотеатр'} onClick={onClose}>
          <X size={19} />
        </IconButton>
      </header>

      <div className="cinema-body">
        {locked && (
          <p className="cinema-notice">
            Ведущий разрешил интеграции только себе — смотреть можно, включать нет.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {children}
      </div>
    </section>
  );
}
