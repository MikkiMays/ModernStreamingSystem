import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../../core/meeting';
import { CinemaApi, PROVIDERS, providerName, type ProviderId } from '../../core/cinema';
import { allowed } from '../../core/permissions';
import { Button } from '../kit';
import { shelfName } from '../integration-shelf';
import { PlatformPicker, useLastPlatform, type PlatformTile } from '../PlatformPicker';
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
 *
 * КАК У МУЗЫКИ. Экран выбора площадки — общий с музыкой (`PlatformPicker`, T59): тот же заголовок,
 * те же плитки, и последний выбор отмечен у обоих.
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
  const { last, remember } = useLastPlatform(meeting, 'cinema');
  const tiles: PlatformTile<ProviderId>[] = providers.listed.map((id) => {
    const entry = providers.entry(id);
    const available = !entry || entry.available;
    return {
      id,
      name: providerName(t, id),
      note: available
        ? t(($) => $.cinema.providers[id].hint)
        : entry?.reason || t(($) => $.cinema.group.unavailable),
      icon: PROVIDERS[id].icon,
      color: PROVIDERS[id].tile,
      disabled: !available,
    };
  });

  return (
    <PlatformPicker
      className="cinema-group"
      title={shelfName(t, 'cinema')}
      backLabel={t(($) => $.cinema.group.back)}
      onBack={onBack}
      label={t(($) => $.cinema.group.platforms)}
      tiles={tiles}
      last={last}
      onPick={(id) => {
        remember(id);
        meeting.openCinema(id);
      }}
      now={
        watch && (
          <>
            <p>
              {t(($) => $.cinema.group.watching)} <b>{watch.title ?? watch.contentId}</b>
            </p>
            {canUse && (
              <Button
                size="sm"
                icon={<X />}
                onClick={() =>
                  void meeting.command('watch.close').catch((e) => setError((e as Error).message))
                }
              >
                {t(($) => $.cinema.group.closeForAll)}
              </Button>
            )}
          </>
        )
      }
    >
      {!providers.listed.length && (
        <p className="platform-picker__note">{t(($) => $.cinema.group.noProviders)}</p>
      )}
      {cinema && (
        <Button full icon={<X />} onClick={() => meeting.openCinema(null)}>
          {t(($) => $.cinema.group.closeCatalog)}
        </Button>
      )}
      {!canUse && <p className="platform-picker__note">{t(($) => $.cinema.group.locked)}</p>}
      {error && (
        <p className="services-error" role="alert">
          {error}
        </p>
      )}
    </PlatformPicker>
  );
}
