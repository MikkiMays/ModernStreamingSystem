import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Radio, Search, Tv, Users, X } from 'lucide-react';
import type { Meeting } from '../core/meeting';
import { CinemaApi, clock, viewers, type CinemaItem } from '../core/cinema';
import type { WatchProvider } from '../core/watch';
import { useStore } from './primitives';

/**
 * Кинозал в панели интеграций: сначала выбирают площадку, потом — что смотреть.
 *
 * Ссылку вставлять больше не нужно и негде. YouTube ищется по словам, Twitch открывается
 * витриной живых эфиров и ищется по названию канала — и то и другое спрашивает **наш** сервер,
 * а не браузер: у него единственного есть доступ к площадкам. Поэтому и обложки приходят с
 * нашего адреса, и строгий CSP остаётся нетронутым.
 */
const SERVICES: { id: WatchProvider; name: string; hint: string; accent: string }[] = [
  { id: 'youtube', name: 'YouTube', hint: 'Ролики по поиску', accent: '#ff3d3d' },
  { id: 'twitch', name: 'Twitch', hint: 'Живые эфиры и каналы', accent: '#9147ff' },
];

export function CinemaGroup({ meeting, onBack }: { meeting: Meeting; onBack: () => void }) {
  const api = useMemo(() => new CinemaApi(meeting.admission), [meeting]);
  const snapshot = useStore(meeting.snapshot);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const canUse = !!self && (self.owner || snapshot.integrationsAllowed !== false);
  const watch = snapshot.watch;
  const [provider, setProvider] = useState<WatchProvider | null>(null);
  const [query, setQuery] = useState('');
  /** Ищем не на каждую букву: поиск уходит на сервер, а тот — к площадке. */
  const [settled, setSettled] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query.trim()), 450);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    setQuery('');
    setSettled('');
  }, [provider]);

  const results = useQuery({
    queryKey: ['cinema', provider, settled],
    queryFn: ({ signal }) => api.search(provider!, settled, signal),
    enabled: !!provider && (provider === 'twitch' || settled.length > 1),
    staleTime: 60000,
  });

  const open = async (item: CinemaItem) => {
    if (!canUse) return;
    setBusy(item.id);
    setError('');
    try {
      await meeting.command('watch.open', item.title, undefined, {
        provider: item.provider,
        kind: item.kind,
        contentId: item.id,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  // Ступенька назад ровно одна и всегда на одном месте: витрина групп → сервисы → содержимое.
  if (!provider)
    return (
      <div className="cinema-group">
        <button className="text-button cinema-back" onClick={onBack}>
          <ArrowLeft size={16} /> Группы интеграций
        </button>
        {watch && (
          <div className="cinema-open">
            <p>
              Сейчас смотрим: <b>{watch.title ?? watch.contentId}</b>
            </p>
            <small>
              Управляет тот, кто открыл. Управление — под плеером на сцене; здесь можно выбрать другое.
            </small>
            {canUse && (
              <button
                className="button"
                onClick={() =>
                  void meeting.command('watch.close').catch((e) => setError((e as Error).message))
                }
              >
                <X size={16} /> Закрыть для всех
              </button>
            )}
          </div>
        )}
        <div className="service-tiles">
          {SERVICES.map((service) => (
            <button
              key={service.id}
              className="service-tile"
              disabled={!canUse}
              onClick={() => setProvider(service.id)}
            >
              <span className="service-tile-icon" style={{ background: service.accent }}>
                {service.id === 'twitch' ? <Radio size={22} /> : <Tv size={22} />}
              </span>
              <span>
                <b>{service.name}</b>
                <small>{service.hint}</small>
              </span>
            </button>
          ))}
        </div>
        {!canUse && <p className="form-footnote">Ведущий разрешил интеграции только себе.</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );

  return (
    <div className="cinema-group">
      <button className="text-button cinema-back" onClick={() => setProvider(null)}>
        <ArrowLeft size={16} /> Все сервисы
      </button>
      <label className="cinema-search">
        <Search size={16} />
        <input
          value={query}
          autoFocus
          placeholder={provider === 'youtube' ? 'Что ищем на YouTube?' : 'Канал на Twitch'}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button className="icon-button" aria-label="Очистить поиск" onClick={() => setQuery('')}>
            <X size={15} />
          </button>
        )}
      </label>
      {provider === 'twitch' && !settled && <h4 className="cinema-heading">Сейчас в эфире</h4>}
      {results.isFetching && <p className="muted">Ищем…</p>}
      {results.isError && (
        <p className="form-error" role="alert">
          {(results.error as Error).message}
        </p>
      )}
      {provider === 'youtube' && settled.length <= 1 && !results.isFetching && (
        <p className="muted">Наберите название ролика, канала или тему.</p>
      )}
      <div className="cinema-results">
        {(results.data ?? []).map((item) => (
          <button
            key={`${item.provider}:${item.id}`}
            className="cinema-card"
            disabled={!canUse || !!busy}
            onClick={() => void open(item)}
          >
            <span className="cinema-poster">
              {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : <Tv size={22} />}
              {item.live ? (
                <span className="cinema-live">В эфире</span>
              ) : (
                item.duration && <span className="cinema-duration">{clock(item.duration)}</span>
              )}
            </span>
            <span className="cinema-meta">
              <b>{item.title}</b>
              <small>
                {item.author}
                {item.category ? ` · ${item.category}` : ''}
                {viewers(item.viewers) ? (
                  <>
                    {' · '}
                    <Users size={11} /> {viewers(item.viewers)}
                  </>
                ) : null}
              </small>
            </span>
          </button>
        ))}
      </div>
      {results.data?.length === 0 && !results.isFetching && <p className="muted">Ничего не нашлось.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
