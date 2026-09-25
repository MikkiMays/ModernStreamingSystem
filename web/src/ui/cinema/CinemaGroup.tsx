import { useMemo, useState } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import type { Meeting } from '../../core/meeting';
import { CinemaApi, PROVIDERS } from '../../core/cinema';
import { useStore } from '../primitives';
import { useProviders } from './useProviders';

/**
 * Кинозал в панели интеграций: выключатель, а не витрина.
 *
 * ПОЧЕМУ ЗДЕСЬ ТАК МАЛО. Каталог тут и был — поиск, список, обложки в триста пикселей ширины, —
 * и выбирать в нём кино было неудобно ровно потому, что панель для этого узкая. Теперь выбор
 * площадки открывает каталог на сцене встречи, а панели остаётся то, для чего она и нужна:
 * сказать, что играет сейчас, и закрыть это для всех.
 *
 * ОТКУДА ПЛИТКИ. Из реестра площадок ({@link PROVIDERS}), в его порядке: список здесь больше
 * не свой, а общий с переключателем каталога — новая площадка добавляется в реестр один раз и
 * появляется сразу везде. Но только те, что служба назвала (`useProviders`): площадка, выключенная
 * на этой установке, не рисуется вовсе — любая её кнопка отвечала бы «выключена на этом сервере».
 */
export function CinemaGroup({ meeting, onBack }: { meeting: Meeting; onBack: () => void }) {
  const snapshot = useStore(meeting.snapshot);
  const cinema = useStore(meeting.cinema);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const canUse = !!self && (self.owner || snapshot.integrationsAllowed !== false);
  const watch = snapshot.watch;
  const [error, setError] = useState('');
  const api = useMemo(() => new CinemaApi(meeting.admission), [meeting]);
  /** Какие площадки есть на этой установке и какие из них отсюда доступны прямо сейчас. */
  const providers = useProviders(api);

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
        {providers.listed.map((id) => {
          const provider = PROVIDERS[id];
          const entry = providers.entry(id);
          const available = !entry || entry.available;
          return (
            <button
              key={provider.id}
              className="service-tile"
              disabled={!available}
              onClick={() => meeting.openCinema(provider.id)}
            >
              <span className="service-tile-icon" style={{ background: provider.tile }}>
                <provider.icon size={22} />
              </span>
              <span>
                <b>{provider.name}</b>
                {/* Почему площадка недоступна — строкой на самой плитке, на месте подсказки:
                    подсказку по наведению палец не покажет никогда, а серая плитка без
                    объяснения выглядит поломкой. */}
                <small>{available ? provider.hint : entry?.reason || 'Сейчас недоступна'}</small>
              </span>
            </button>
          );
        })}
      </div>
      {!providers.listed.length && (
        <p className="form-footnote">Площадки кинозала на этом сервере выключены.</p>
      )}
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
