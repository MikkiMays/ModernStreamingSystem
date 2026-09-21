import { useState } from 'react';
import { ArrowLeft, Clapperboard, Radio, Tv, X } from 'lucide-react';
import type { Meeting } from '../core/meeting';
import type { WatchProvider } from '../core/watch';
import { useStore } from './primitives';

/**
 * Кинозал в панели интеграций: выключатель, а не витрина.
 *
 * ПОЧЕМУ ЗДЕСЬ ТАК МАЛО. Каталог тут и был — поиск, список, обложки в триста пикселей ширины, —
 * и выбирать в нём кино было неудобно ровно потому, что панель для этого узкая. Теперь выбор
 * площадки открывает {@link CinemaBrowser} на сцене, а панели остаётся то, для чего она и
 * нужна: сказать, что играет сейчас, и закрыть это для всех.
 */
const SERVICES: { id: WatchProvider; name: string; hint: string; accent: string }[] = [
  { id: 'youtube', name: 'YouTube', hint: 'Ролики, фильмы и каналы', accent: '#ff3d3d' },
  { id: 'twitch', name: 'Twitch', hint: 'Живые эфиры и записи', accent: '#9147ff' },
];

export function CinemaGroup({ meeting, onBack }: { meeting: Meeting; onBack: () => void }) {
  const snapshot = useStore(meeting.snapshot);
  const cinema = useStore(meeting.cinema);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const canUse = !!self && (self.owner || snapshot.integrationsAllowed !== false);
  const watch = snapshot.watch;
  const [error, setError] = useState('');

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
        {SERVICES.map((service) => (
          <button
            key={service.id}
            className="service-tile"
            data-active={cinema === service.id ? 'true' : undefined}
            onClick={() => meeting.openCinema(service.id)}
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
      {cinema ? (
        <button className="button secondary full" onClick={() => meeting.openCinema(null)}>
          <X size={17} /> Закрыть каталог
        </button>
      ) : (
        <p className="form-footnote">
          <Clapperboard size={13} /> Каталог откроется на сцене — там же, где потом пойдёт кино.
        </p>
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
