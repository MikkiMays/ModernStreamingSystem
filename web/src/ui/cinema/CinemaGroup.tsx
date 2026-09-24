import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, X } from 'lucide-react';
import type { Meeting } from '../../core/meeting';
import { CinemaApi, PROVIDER_IDS, PROVIDERS } from '../../core/cinema';
import { useStore } from '../primitives';

/**
 * Кинозал в панели интеграций: выключатель, а не витрина.
 *
 * ПОЧЕМУ ЗДЕСЬ ТАК МАЛО. Каталог тут и был — поиск, список, обложки в триста пикселей ширины, —
 * и выбирать в нём кино было неудобно ровно потому, что панель для этого узкая. Теперь выбор
 * площадки открывает каталог на сцене встречи, а панели остаётся то, для чего она и нужна:
 * сказать, что играет сейчас, и закрыть это для всех.
 *
 * ОТКУДА ПЛИТКИ. Из реестра площадок ({@link PROVIDERS}), в его порядке: список здесь больше
 * не свой, а общий с переключателем каталога и с панелью подсказки над группой — новая площадка
 * добавляется в реестр один раз и появляется сразу везде.
 */
export function CinemaGroup({ meeting, onBack }: { meeting: Meeting; onBack: () => void }) {
  const snapshot = useStore(meeting.snapshot);
  const cinema = useStore(meeting.cinema);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const canUse = !!self && (self.owner || snapshot.integrationsAllowed !== false);
  const watch = snapshot.watch;
  const [error, setError] = useState('');
  const api = useMemo(() => new CinemaApi(meeting.admission), [meeting]);
  /**
   * Какие площадки отсюда доступны прямо сейчас.
   *
   * Пока запрос не ответил или ответил отказом, площадки считаются доступными — так плитки вели
   * себя и раньше, когда этой проверки не было вовсе: сбой одной проверки не должен запирать
   * весь кинозал, а недоступность видна только тогда, когда служба её подтвердила.
   */
  const status = useQuery({
    queryKey: ['cinema', 'providers'],
    queryFn: ({ signal }) => api.providers(signal),
    staleTime: 60000,
  });
  const known = new Map((status.data?.providers ?? []).map((entry) => [entry.id, entry] as const));

  return (
    <div className="cinema-group">
      <button className="text-button cinema-back" onClick={onBack}>
        <ArrowLeft size={16} /> Группы интеграций
      </button>
      {watch && (
        <div className="cinema-open-now">
          <p>
            Сейчас смотрим: <b>{watch.title ?? watch.contentId}</b>
          </p>
          {canUse && (
            <button
              className="button"
              onClick={() => void meeting.command('watch.close').catch((e) => setError((e as Error).message))}
            >
              <X size={16} /> Закрыть для всех
            </button>
          )}
        </div>
      )}
      <div className="service-tiles">
        {PROVIDER_IDS.map((id) => {
          const provider = PROVIDERS[id];
          const entry = known.get(id);
          const available = !entry || entry.available;
          return (
            <button
              key={provider.id}
              className="service-tile"
              disabled={!available}
              title={available ? undefined : (entry?.reason ?? undefined)}
              onClick={() => meeting.openCinema(provider.id)}
            >
              <span className="service-tile-icon" style={{ background: provider.tile }}>
                <provider.icon size={22} />
              </span>
              <span>
                <b>{provider.name}</b>
                <small>{provider.hint}</small>
              </span>
            </button>
          );
        })}
      </div>
      {cinema && (
        <button className="button secondary full" onClick={() => meeting.openCinema(null)}>
          <X size={17} /> Закрыть каталог
        </button>
      )}
      {!canUse && <p className="form-footnote">Ведущий разрешил включать и останавливать только себе.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
