import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Music2, Unplug } from 'lucide-react';
import type { Meeting } from '../core/meeting';
import {
  YandexApi,
  MusicApi,
  servicesApi,
  type MusicAction,
  type MusicSource,
  type MusicState,
  type MusicTrack,
} from '../core/services';
import { useStore } from './primitives';
import { YandexIntegration } from './YandexIntegration';
import { MusicPlayer } from './MusicPlayer';
import { MusicQueue } from './MusicQueue';
import { MusicUpload } from './MusicUpload';
import { TelegramService } from './TelegramService';
import {
  foresee,
  foresightSpent,
  MUSIC_SOURCE_LABELS,
  offeredSources,
  preferredSource,
  type Foresight,
} from './music-playback';

/**
 * Панель сервисов встречи.
 *
 * ПОРЯДОК ЗДЕСЬ — ЭТО ПОВЕДЕНИЕ, А НЕ ОФОРМЛЕНИЕ. Загрузка файлов, очередь и поиск в Яндексе
 * раньше показывались и тогда, когда музыкального сервиса во встрече ещё не было. Треки в
 * такую очередь и правда складывались — но играть их было некому, и человек оставался с
 * полным списком и тишиной. Поэтому сначала плеер: пока его нет, панель предлагает ровно одно
 * действие, а всё, что относится к содержимому и источникам, появляется после него.
 */
export function Services({ meeting }: { meeting: Meeting }) {
  const api = useMemo(() => new MusicApi(meeting.admission), [meeting]);
  const yandexApi = useMemo(() => new YandexApi(meeting.admission), [meeting]);
  const snapshot = useStore(meeting.snapshot);
  const volumes = useStore(meeting.media.volumes);
  const preferences = useStore(meeting.media.preferences);
  const ended = useStore(meeting.ended);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const active = !!self && ['JOINING', 'CONNECTED', 'RECOVERING'].includes(self.status) && !ended;
  const canUse = active && (self?.owner || snapshot.integrationsAllowed !== false);
  const client = useQueryClient();
  const key = ['music', meeting.admission.roomId, meeting.admission.participantId];
  const catalog = useQuery({ queryKey: ['services'], queryFn: servicesApi.catalog, staleTime: 30000 });
  const music = useQuery({
    queryKey: key,
    queryFn: api.state,
    enabled: active,
    refetchInterval: active ? 2000 : false,
  });
  // `busy` covers only what genuinely takes seconds and changes the room: adding the service,
  // removing it, changing who may use it. The transport buttons are not that, and disabling
  // them for the length of a round trip is what made the panel look like it was reloading.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState<{ command: string; expiresAt: number } | null>(null);
  const [foresight, setForesight] = useState<Foresight | null>(null);
  const [source, setSource] = useState<MusicSource>('yandex');
  const sources = useMemo(() => offeredSources(catalog.data?.sources), [catalog.data?.sources]);
  const fallback = preferredSource(sources);
  useEffect(() => {
    if (!sources.includes(source)) setSource(fallback);
  }, [fallback, source, sources]);

  // The bot holds a seat in the room, so only joining and leaving change the snapshot.
  // Refreshing it after every play or skip fetched the whole meeting a second time and
  // repainted the panel, which read as the panel reloading on every button.
  const update = (next: MusicState, rosterChanged = false) => {
    client.setQueryData(key, next);
    if (rosterChanged) void meeting.refresh();
  };
  const run = async (job: () => Promise<MusicState>, rosterChanged = false) => {
    if (!canUse) return;
    setError('');
    try {
      update(await job(), rosterChanged);
    } catch (e) {
      // The server did not agree, so what is on screen is not true. Показываем, как есть.
      setForesight(null);
      setError((e as Error).message);
    }
  };
  const served = music.data;
  const state = foresee(served, foresight);
  useEffect(() => {
    if (foresightSpent(served, foresight)) setForesight(null);
  }, [served, foresight]);

  const command = (
    action: MusicAction,
    extra?: Parameters<MusicApi['command']>[1],
    patch?: Partial<MusicState>,
  ) => {
    if (patch && state) setForesight({ base: state.revision, patch });
    void run(() => api.command(action, extra));
  };
  /** Joining and leaving the room take seconds and change who is in it; those do wait. */
  const heavy = async (job: () => Promise<MusicState>) => {
    if (busy || !canUse) return;
    setBusy(true);
    try {
      await run(job, true);
    } finally {
      setBusy(false);
    }
  };
  const enableMusic = () =>
    void heavy(async () => {
      const token = preferences.yandexMusicToken.trim();
      if (source === 'yandex' && token)
        await yandexApi
          .connectToken(token)
          .catch(() =>
            setError(
              'Не удалось подключить сохранённый токен Яндекс Музыки. Откройте интеграцию для ручной авторизации.',
            ),
          );
      return api.enable();
    });

  return (
    <div className="services-panel">
      {self?.owner && active && (
        <section className="integration-permission">
          <label className="check-setting">
            <input
              type="checkbox"
              checked={snapshot.integrationsAllowed !== false}
              disabled={!canUse || busy}
              onChange={async (e) => {
                const enabled = e.target.checked;
                setBusy(true);
                try {
                  await api.permissions(enabled);
                  await meeting.refresh();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            />
            Разрешить интеграции всем участникам
          </label>
          <p className="form-footnote">Привязку Telegram меняете только вы.</p>
        </section>
      )}
      {active && !canUse && (
        <p className="muted">
          Организатор разрешил управление интеграциями только себе. Громкость музыки для себя можно менять
          ниже.
        </p>
      )}
      <section className="service-card">
        <div className="service-heading">
          <span className="service-icon">
            <Music2 size={24} />
          </span>
          <div>
            <h3>Музыка</h3>
            <p>Одна очередь на всю встречу</p>
          </div>
        </div>
        {!active ? (
          <p className="muted">Сервисы доступны после входа во встречу.</p>
        ) : catalog.isError || music.isError ? (
          <div role="alert" className="form-error">
            <p>Сервисы временно недоступны.</p>
            <button
              className="button secondary"
              onClick={() => {
                void catalog.refetch();
                void music.refetch();
              }}
            >
              Повторить
            </button>
          </div>
        ) : !state ? (
          <p role="status" className="muted">
            Подключаем сервисы…
          </p>
        ) : !state.enabled ? (
          <>
            <p className="muted">Общая музыка для всех. Занимает одно место во встрече.</p>
            <label>
              Источник музыки по умолчанию
              <select value={source} onChange={(e) => setSource(e.target.value as MusicSource)}>
                {sources.map((value) => (
                  <option key={value} value={value}>
                    {MUSIC_SOURCE_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            {state.queue.length > 0 && (
              <p className="form-footnote">
                Очередь никуда не делась: {state.queue.length} трек(ов) заиграют, как только сервис вернётся
                во встречу.
              </p>
            )}
            {canUse ? (
              <button className="button primary full" disabled={busy} onClick={enableMusic}>
                <Music2 size={18} />
                Добавить во встречу
              </button>
            ) : (
              <p className="form-footnote">Добавление сервисов ограничено организатором.</p>
            )}
            {state.error && (
              <p className="form-error" role="alert">
                {state.error}
              </p>
            )}
          </>
        ) : (
          <>
            <MusicPlayer
              state={state}
              canUse={canUse}
              volume={(state.participantId ? volumes[state.participantId] : undefined) ?? 1}
              onVolume={(value) => state.participantId && meeting.media.setVolume(state.participantId, value)}
              onCommand={command}
              onSeek={(position) => command('seek', { position }, { position })}
            />
            {state.error && (
              <p className="form-error" role="alert">
                {state.error}
              </p>
            )}
            <MusicUpload
              canUse={canUse}
              maxFileBytes={catalog.data?.maxFileBytes ?? 50 * 1024 * 1024}
              upload={(file, signal) => api.upload(file, signal)}
              onAdded={update}
              onError={setError}
            />
            <MusicQueue
              state={state}
              canUse={canUse}
              onClear={(patch) => command('clear', undefined, patch)}
              onPromote={(track: MusicTrack, patch) => command('next', { trackId: track.id }, patch)}
              onRemove={(track: MusicTrack, patch) => command('remove', { trackId: track.id }, patch)}
            />
            {self?.owner && (
              <button
                className="button ghost full"
                disabled={!canUse || busy}
                onClick={() => void heavy(api.disable)}
              >
                <Unplug size={17} />
                Убрать сервис из встречи
              </button>
            )}
          </>
        )}
      </section>
      {canUse && state?.enabled && (
        <YandexIntegration
          meeting={meeting}
          update={update}
          storedToken={preferences.yandexMusicToken}
          onStoredTokenChange={(next) => meeting.media.saveSettings({ yandexMusicToken: next })}
        />
      )}
      <TelegramService
        username={catalog.data?.telegram.username}
        canLink={!!self?.owner && active && canUse}
        busy={busy}
        link={link}
        onError={setError}
        onLink={async () => {
          setBusy(true);
          setError('');
          try {
            setLink(await api.linkTelegram());
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
