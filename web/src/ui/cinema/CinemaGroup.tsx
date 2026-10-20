import { useMemo, useState } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../../core/meeting';
import { CinemaApi, PROVIDERS, providerName } from '../../core/cinema';
import { allowed } from '../../core/permissions';
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
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const cinema = useStore(meeting.cinema);
  const canUse = allowed(snapshot, meeting.admission.participantId, 'watch.close');
  const watch = snapshot.watch;
  const [error, setError] = useState('');
  const api = useMemo(() => new CinemaApi(meeting.admission), [meeting]);
  /** Какие площадки есть на этой установке и какие из них отсюда доступны прямо сейчас. */
  const providers = useProviders(api);

  return (
    <div className="cinema-group">
      <button className="text-button cinema-back" onClick={onBack}>
        <ArrowLeft size={16} /> {t(($) => $.cinema.group.back)}
      </button>
      {watch && (
        <div className="cinema-open-now">
          <p>
            {t(($) => $.cinema.group.watching)} <b>{watch.title ?? watch.contentId}</b>
          </p>
          {canUse && (
            <button
              className="button"
              onClick={() => void meeting.command('watch.close').catch((e) => setError((e as Error).message))}
            >
              <X size={16} /> {t(($) => $.cinema.group.closeForAll)}
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
                <b>{providerName(t, id)}</b>
                {/* Почему площадка недоступна — строкой на самой плитке, на месте подсказки:
                    подсказку по наведению палец не покажет никогда, а серая плитка без
                    объяснения выглядит поломкой. */}
                <small>
                  {available
                    ? t(($) => $.cinema.providers[id].hint)
                    : entry?.reason || t(($) => $.cinema.group.unavailable)}
                </small>
              </span>
            </button>
          );
        })}
      </div>
      {!providers.listed.length && <p className="form-footnote">{t(($) => $.cinema.group.noProviders)}</p>}
      {cinema && (
        <button className="button secondary full" onClick={() => meeting.openCinema(null)}>
          <X size={17} /> {t(($) => $.cinema.group.closeCatalog)}
        </button>
      )}
      {!canUse && <p className="form-footnote">{t(($) => $.cinema.group.locked)}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
