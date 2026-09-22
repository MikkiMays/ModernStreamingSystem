import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Hash, Plus } from 'lucide-react';
import { publicApi } from '../api/client';
import { formatCode, parseInvite, type Destination } from '../core/invitation';
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
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: publicApi.capabilities, retry: 1 });
  const creationClosed = capabilities.data?.admissionOpen === false;
  return (
    <section className={`home-entry ${className}`} aria-labelledby={`${id}-title`}>
      <header className="home-entry-welcome">
        <h1 id={`${id}-title`}>Начнём разговор.</h1>
        <p>Одна комната. Все свои.</p>
      </header>
      <form
        className="home-entry-form"
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
        <label htmlFor={`${id}-invite`}>Код встречи или ссылка</label>
        <div className="home-entry-input-row">
          <div className="input-icon">
            <Hash size={18} aria-hidden="true" />
            <input
              id={`${id}-invite`}
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
            className="home-entry-join"
            type="submit"
            aria-label="Присоединиться"
            title="Присоединиться"
          >
            <ArrowRight size={21} aria-hidden="true" />
          </button>
        </div>
        <small id={`${id}-hint`} className="home-entry-hint">
          9 цифр от организатора или ссылка-приглашение.
        </small>
        {error && (
          <p id={`${id}-error`} role="alert" className="form-error home-entry-error">
            {error}
          </p>
        )}
      </form>
      <div className="home-entry-divider" aria-hidden="true">
        <span>или</span>
      </div>
      <button
        className="button primary home-entry-create"
        type="button"
        onClick={onCreate}
        disabled={creationClosed}
        aria-describedby={creationClosed ? `${id}-unavailable` : undefined}
      >
        <Plus size={20} aria-hidden="true" /> Новая встреча
      </button>
      {creationClosed && (
        <p id={`${id}-unavailable`} className="home-entry-notice" role="status">
          Создание встреч временно недоступно на этом сервере.
        </p>
      )}
      {capabilities.isError && (
        <p className="home-entry-notice" role="status">
          Сервер недоступен. Проверьте соединение.{' '}
          <button
            className="text-button"
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
