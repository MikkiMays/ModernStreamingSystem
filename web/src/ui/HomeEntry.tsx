import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Link2 } from 'lucide-react';
import { serverInfo } from '../core/session';
import { formatCode, parseInvite, type Destination } from '../core/invitation';
import { CordMark } from './brand/Logo';
import { Button } from './kit';
import '../home-entry.css';

/**
 * Вход во встречу — общий для главной в браузере и в клиенте Windows (E02, R65).
 *
 * Две карточки рядом (DESIGN.md → Главная): слева большая синяя плита «Новая встреча» — одно
 * нажатие, и это главное, что здесь делают; справа — «Войти по коду» с полем и «Присоединиться».
 * Узко (телефон, маленькое окно клиента) — столбиком, плита сверху. Подзаголовков-наполнителей нет:
 * имя плиты для диктора — ровно «Новая встреча» (`aria-labelledby`), причина, почему она выключена,
 * — описанием (`aria-describedby`).
 */
export function HomeEntry({
  onCreate,
  onJoin,
  className = '',
}: {
  onCreate: () => void;
  onJoin: (destination: Destination) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  // `serverInfo`, а не голый запрос: заодно запоминаются правила качества с сервера.
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: serverInfo, retry: 1 });
  const creationClosed = capabilities.data?.admissionOpen === false;
  // Дренаж перед выкаткой (W1b): причина — обновление, и через две минуты можно будет снова.
  const maintenance = creationClosed && capabilities.data?.maintenance === true;
  return (
    <div className={`home-entry ${className}`}>
      <div className="home-entry__hero">
        <button
          type="button"
          className="home-entry__create"
          data-tour="create"
          aria-labelledby={`${id}-create`}
          aria-describedby={creationClosed ? `${id}-unavailable` : undefined}
          disabled={creationClosed}
          onClick={onCreate}
        >
          <CordMark size={22} className="home-entry__mark" />
          <span id={`${id}-create`} className="home-entry__title">
            {t(($) => $.home.entry.create)}
          </span>
          {creationClosed ? (
            <span id={`${id}-unavailable`} className="home-entry__closed">
              {maintenance ? t(($) => $.errors.MAINTENANCE) : t(($) => $.home.entry.creationClosed)}
            </span>
          ) : (
            <span className="home-entry__go" aria-hidden="true">
              <ArrowRight size={20} />
            </span>
          )}
          {/* «Сигнал» — четыре тонкие дуги из угла: единственное украшение страницы. */}
          <svg className="home-entry__arcs" viewBox="0 0 320 320" aria-hidden="true" focusable="false">
            <circle cx="320" cy="320" r="90" strokeOpacity="0.14" />
            <circle cx="320" cy="320" r="150" strokeOpacity="0.09" />
            <circle cx="320" cy="320" r="210" strokeOpacity="0.055" />
            <circle cx="320" cy="320" r="270" strokeOpacity="0.03" />
          </svg>
        </button>
        <form
          className="home-entry__join"
          data-tour="join"
          aria-labelledby={`${id}-join`}
          onSubmit={(event) => {
            event.preventDefault();
            try {
              setError('');
              onJoin(parseInvite(link));
            } catch (problem) {
              setError((problem as Error).message);
            }
          }}
        >
          <h2 id={`${id}-join`} className="home-entry__heading">
            {t(($) => $.home.entry.joinTitle)}
          </h2>
          <div className="home-entry__group">
            <label className="home-entry__label" htmlFor={`${id}-invite`}>
              {t(($) => $.home.entry.label)}
            </label>
            <div className="home-entry__field">
              <Link2 size={20} aria-hidden="true" />
              <input
                id={`${id}-invite`}
                className="home-entry__input"
                value={link}
                onChange={(event) => {
                  const value = event.target.value;
                  setLink(/^[\d\s-]*$/.test(value) ? formatCode(value) : value);
                  setError('');
                }}
                placeholder="123-456-789"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
              />
            </div>
            {error && (
              <p id={`${id}-error`} role="alert" className="home-entry__error">
                {error}
              </p>
            )}
          </div>
          <Button type="submit" variant="primary" size="lg" full className="home-entry__submit">
            {t(($) => $.home.entry.join)}
          </Button>
        </form>
      </div>
      {capabilities.isError && (
        <p className="home-entry__notice" role="status">
          {t(($) => $.home.entry.unavailable)}{' '}
          <button
            type="button"
            className="home-entry__retry"
            disabled={capabilities.isFetching}
            onClick={() => void capabilities.refetch()}
          >
            {t(($) => $.home.entry.retry)}
          </button>
        </p>
      )}
    </div>
  );
}
