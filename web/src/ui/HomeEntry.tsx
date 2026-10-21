import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Hash, Plus } from 'lucide-react';
import { serverInfo } from '../core/session';
import { formatCode, parseInvite, type Destination } from '../core/invitation';
import { Button } from './kit';
import '../home-entry.css';

/** The web page and native workspace share the same invitation and creation flow. */
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
  return (
    <section className={`home-entry ${className}`} aria-labelledby={`${id}-title`}>
      <header className="home-entry__welcome">
        <h1 id={`${id}-title`}>{t(($) => $.home.entry.title)}</h1>
        <p>{t(($) => $.home.entry.tagline)}</p>
      </header>
      <form
        className="home-entry__form"
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
        <label className="home-entry__label" htmlFor={`${id}-invite`}>
          {t(($) => $.home.entry.label)}
        </label>
        <div className="home-entry__row" data-tour="join">
          <div className="home-entry__field">
            <Hash size={18} aria-hidden="true" />
            <input
              id={`${id}-invite`}
              className="home-entry__input"
              value={link}
              onChange={(event) => {
                const value = event.target.value;
                setLink(/^[\d\s-]*$/.test(value) ? formatCode(value) : value);
                setError('');
              }}
              placeholder="333-333-333"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
            />
          </div>
          <button
            className="home-entry__join"
            type="submit"
            aria-label={t(($) => $.home.entry.join)}
            title={t(($) => $.home.entry.join)}
          >
            <ArrowRight size={20} aria-hidden="true" />
          </button>
        </div>
        <small id={`${id}-hint`} className="home-entry__hint">
          {t(($) => $.home.entry.hint)}
        </small>
        {error && (
          <p id={`${id}-error`} role="alert" className="home-entry__error">
            {error}
          </p>
        )}
      </form>
      <div className="home-entry__divider" aria-hidden="true">
        <span>{t(($) => $.home.entry.or)}</span>
      </div>
      <Button
        variant="primary"
        size="lg"
        full
        className="home-entry__create"
        data-tour="create"
        icon={<Plus size={18} />}
        onClick={onCreate}
        disabled={creationClosed}
        aria-describedby={creationClosed ? `${id}-unavailable` : undefined}
      >
        {t(($) => $.home.entry.create)}
      </Button>
      {creationClosed && (
        <p id={`${id}-unavailable`} className="home-entry__notice" role="status">
          {t(($) => $.home.entry.creationClosed)}
        </p>
      )}
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
    </section>
  );
}
