import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
  const id = useId();
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  // `serverInfo`, а не голый запрос: заодно запоминаются правила качества с сервера.
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: serverInfo, retry: 1 });
  const creationClosed = capabilities.data?.admissionOpen === false;
  return (
    <section className={`home-entry ${className}`} aria-labelledby={`${id}-title`}>
      <header className="home-entry__welcome">
        <h1 id={`${id}-title`}>Начнём разговор.</h1>
        <p>Одна комната. Все свои.</p>
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
          Код встречи или ссылка
        </label>
        <div className="home-entry__row">
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
            aria-label="Присоединиться"
            title="Присоединиться"
          >
            <ArrowRight size={20} aria-hidden="true" />
          </button>
        </div>
        <small id={`${id}-hint`} className="home-entry__hint">
          9 цифр от организатора или ссылка-приглашение.
        </small>
        {error && (
          <p id={`${id}-error`} role="alert" className="home-entry__error">
            {error}
          </p>
        )}
      </form>
      <div className="home-entry__divider" aria-hidden="true">
        <span>или</span>
      </div>
      <Button
        variant="primary"
        size="lg"
        full
        className="home-entry__create"
        icon={<Plus size={18} />}
        onClick={onCreate}
        disabled={creationClosed}
        aria-describedby={creationClosed ? `${id}-unavailable` : undefined}
      >
        Новая встреча
      </Button>
      {creationClosed && (
        <p id={`${id}-unavailable`} className="home-entry__notice" role="status">
          Создание встреч временно недоступно на этом сервере.
        </p>
      )}
      {capabilities.isError && (
        <p className="home-entry__notice" role="status">
          Сервер недоступен. Проверьте соединение.{' '}
          <button
            type="button"
            className="home-entry__retry"
            disabled={capabilities.isFetching}
            onClick={() => void capabilities.refetch()}
          >
            Повторить
          </button>
        </p>
      )}
    </section>
  );
}
