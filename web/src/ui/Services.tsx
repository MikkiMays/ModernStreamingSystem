import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Music2,
  Pause,
  Play,
  SkipForward,
  Upload,
  Shuffle,
  Repeat2,
  Trash2,
  ListPlus,
  Send,
  Copy,
  Unplug,
  LoaderCircle,
} from 'lucide-react';
import type { Meeting } from '../core/meeting';
import {
  YandexApi,
  MusicApi,
  servicesApi,
  musicSourceName,
  type MusicAction,
  type MusicSource,
  type MusicState,
} from '../core/services';
import { IconButton, useStore } from './primitives';
import { YandexIntegration } from './YandexIntegration';

function duration(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
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
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState<{ command: string; expiresAt: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [seek, setSeek] = useState<number | null>(null);
  const [musicSource, setMusicSource] = useState<MusicSource>('yandex');
  const [progressNow, setProgressNow] = useState(Date.now);
  const progressAnchor = useRef<{ position: number; trackId: string | undefined; at: number }>({
    position: 0,
    trackId: undefined,
    at: Date.now(),
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const availableSources = useMemo<MusicSource[]>(
    () =>
      (catalog.data?.sources ?? ['upload', 'telegram', 'yandex']).filter((value) =>
        ['upload', 'telegram', 'yandex'].includes(value),
      ) as MusicSource[],
    [catalog.data?.sources],
  );
  const defaultSource = availableSources.includes('yandex') ? 'yandex' : (availableSources[0] ?? 'upload');
  useEffect(() => {
    if (!musicSource || !availableSources.includes(musicSource)) setMusicSource(defaultSource);
  }, [defaultSource, musicSource, availableSources]);
  const sourceLabel: Record<MusicSource, string> = {
    upload: 'Аудиофайл',
    telegram: 'Telegram',
    yandex: 'Яндекс Музыка',
  };
  useEffect(() => () => uploadAbort.current?.abort(), []);
  const yandexToken = preferences.yandexMusicToken.trim();
  // The bot holds a seat in the room, so only joining and leaving change the snapshot.
  // Refreshing it after every play or skip fetched the whole meeting a second time and
  // repainted the panel, which read as the panel reloading on every button.
  const update = (state: MusicState, rosterChanged = false) => {
    client.setQueryData(key, state);
    if (rosterChanged) void meeting.refresh();
  };
  const run = async (job: () => Promise<MusicState>, rosterChanged = false) => {
    if (busy || !canUse) return false;
    setBusy(true);
    setError('');
    try {
      update(await job(), rosterChanged);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const command = (action: MusicAction, extra?: Parameters<MusicApi['command']>[1]) =>
    void run(() => api.command(action, extra));
  const commitSeek = async (position: number) => {
    if (await run(() => api.command('seek', { position }))) setSeek(null);
  };
  const connectYandexToken = async () => {
    if (musicSource !== 'yandex' || !yandexToken) return true;
    try {
      await yandexApi.connectToken(yandexToken);
      return true;
    } catch {
      setError(
        'Не удалось подключить сохранённый токен Яндекс Музыки. Откройте интеграцию для ручной авторизации.',
      );
      return false;
    }
  };
  const enableMusic = async () => {
    if (!canUse || busy || state?.enabled) return;
    setBusy(true);
    setError('');
    try {
      await connectYandexToken();
      update(await api.enable(), true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const upload = async (files: File[]) => {
    if (!canUse || uploading || !files.length) return;
    setError('');
    setUploading(true);
    const abort = new AbortController();
    uploadAbort.current = abort;
    try {
      for (const file of files) {
        if (file.size > (catalog.data?.maxFileBytes ?? 50 * 1024 * 1024))
          throw new Error(`«${file.name}»: максимум 50 МБ на трек`);
        update(await api.upload(file, abort.signal));
      }
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
    } finally {
      setUploading(false);
      uploadAbort.current = null;
    }
  };
  const state = music.data;
  const current = state?.queue[0];
  const playing = !!current && state?.status === 'playing' && !state.paused;
  const reported = state?.position ?? 0;
  // Polling hands back a new object every two seconds even when nothing moved. Anchoring on
  // the reported position instead of object identity keeps the tick from restarting, and
  // makes this re-anchor idempotent when React renders twice.
  if (progressAnchor.current.position !== reported || progressAnchor.current.trackId !== current?.id)
    progressAnchor.current = { position: reported, trackId: current?.id, at: Date.now() };
  useEffect(() => {
    setProgressNow(Date.now());
    if (!playing) return;
    const timer = setInterval(() => setProgressNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [playing, current?.id]);
  const playbackPosition = state
    ? Math.min(
        current?.duration ?? reported,
        progressAnchor.current.position +
          (playing ? Math.max(0, progressNow - progressAnchor.current.at) / 1000 : 0),
      )
    : 0;
  const username = catalog.data?.telegram.username;
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
        ) : (
          <>
            {!state.enabled && (
              <>
                <p className="muted">Общая музыка для всех. Занимает одно место во встрече.</p>
                <label>
                  Источник музыки по умолчанию
                  <select value={musicSource} onChange={(e) => setMusicSource(e.target.value as MusicSource)}>
                    {availableSources.map((value) => (
                      <option key={value} value={value}>
                        {sourceLabel[value]}
                      </option>
                    ))}
                  </select>
                </label>
                {canUse ? (
                  <button
                    className="button primary full"
                    disabled={!canUse || busy}
                    onClick={() => void enableMusic()}
                  >
                    <Music2 size={18} />
                    Добавить во встречу
                  </button>
                ) : (
                  <p className="form-footnote">Добавление сервисов ограничено организатором.</p>
                )}
              </>
            )}
            {state.enabled && (
              <>
                <div className="now-playing">
                  <span className="panel-eyebrow">
                    {state.status === 'connecting'
                      ? 'ПОДКЛЮЧАЕМ МУЗЫКУ'
                      : state.paused
                        ? 'НА ПАУЗЕ'
                        : current
                          ? 'СЕЙЧАС ИГРАЕТ'
                          : 'ГОТОВЫ СЛУШАТЬ'}
                  </span>
                  <strong>{current?.title ?? 'Добавьте первый трек'}</strong>
                  <span>
                    {current?.artist || (current ? `Добавил: ${current.addedBy}` : 'Из файла или Telegram')}
                  </span>
                  {current && (
                    <span className="music-source">Источник · {musicSourceName(current.source)}</span>
                  )}
                </div>
                {current && (
                  <div className="music-progress">
                    <input
                      type="range"
                      min="0"
                      max={Math.max(1, current.duration)}
                      step="1"
                      disabled={!canUse || busy}
                      aria-label="Позиция трека"
                      value={seek ?? playbackPosition}
                      onChange={(e) => setSeek(Number(e.target.value))}
                      onPointerUp={(e) => {
                        void commitSeek(Number(e.currentTarget.value));
                      }}
                      onKeyUp={(e) => {
                        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                          void commitSeek(Number(e.currentTarget.value));
                        }
                      }}
                    />
                    <div>
                      <span>{duration(seek ?? playbackPosition)}</span>
                      <span>{duration(current.duration)}</span>
                    </div>
                  </div>
                )}
                <div className="music-controls">
                  <IconButton
                    label={state.paused ? 'Продолжить музыку' : 'Пауза музыки'}
                    disabled={!canUse || busy || !current}
                    onClick={() => command(state.paused ? 'play' : 'pause')}
                  >
                    {state.paused ? <Play size={22} /> : <Pause size={22} />}
                  </IconButton>
                  <IconButton
                    label="Следующий трек"
                    disabled={!canUse || busy || !current}
                    onClick={() => command('skip')}
                  >
                    <SkipForward size={22} />
                  </IconButton>
                  <IconButton
                    label="Перемешать очередь"
                    disabled={!canUse || busy || state.queue.length < 3}
                    onClick={() => command('shuffle')}
                  >
                    <Shuffle size={19} />
                  </IconButton>
                  <IconButton
                    label="Повторять очередь"
                    aria-pressed={state.repeat}
                    className={state.repeat ? 'selected' : ''}
                    disabled={!canUse || busy}
                    onClick={() => command('repeat', { enabled: !state.repeat })}
                  >
                    <Repeat2 size={19} />
                  </IconButton>
                </div>
                {state.participantId && (
                  <label className="gain-setting music-volume">
                    Громкость музыки у вас · {Math.round((volumes[state.participantId] ?? 1) * 100)}%
                    <input
                      type="range"
                      min="0"
                      max="200"
                      step="5"
                      value={(volumes[state.participantId] ?? 1) * 100}
                      onChange={(e) =>
                        meeting.media.setVolume(state.participantId!, Number(e.target.value) / 100)
                      }
                    />
                  </label>
                )}
              </>
            )}
            {state.error && (
              <p className="form-error" role="alert">
                {state.error}
              </p>
            )}
            <div
              className="music-drop"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void upload(Array.from(e.dataTransfer.files));
              }}
            >
              <input
                ref={fileInput}
                type="file"
                multiple
                accept="audio/*,.m4a,.flac,.ogg,.opus,.webm"
                hidden
                aria-label="Добавить музыкальные файлы"
                onChange={(e) => {
                  void upload(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              <button
                className="button secondary full"
                disabled={!canUse || uploading}
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? <LoaderCircle size={18} className="spin" /> : <Upload size={18} />}
                {uploading ? 'Добавляем треки…' : 'Добавить аудиофайлы'}
              </button>
              {uploading && (
                <button className="button ghost" onClick={() => uploadAbort.current?.abort()}>
                  Отменить загрузку
                </button>
              )}
              <p className="form-footnote">
                Можно перетащить сюда несколько файлов. До 50 МБ и 60 минут на трек; файлы хранятся до суток.
              </p>
            </div>
            {!!state.queue.length && (
              <section className="music-queue" aria-label="Музыкальная очередь">
                <div className="queue-heading">
                  <h4>Сейчас и далее · {state.queue.length}</h4>
                  <IconButton
                    label="Очистить следующие треки"
                    disabled={!canUse || busy || state.queue.length < 2}
                    onClick={() => command('clear')}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </div>
                <ol>
                  {state.queue.map((track, i) => (
                    <li key={track.id} data-current={i === 0}>
                      <span className="queue-number">{i + 1}</span>
                      <div className="queue-track">
                        <strong>{track.title}</strong>
                        <small>
                          {track.artist || track.addedBy} · {musicSourceName(track.source)} ·{' '}
                          {duration(track.duration)}
                        </small>
                      </div>
                      {i > 1 && (
                        <IconButton
                          label={`Следующим: ${track.title}`}
                          disabled={!canUse || busy}
                          onClick={() => command('next', { trackId: track.id })}
                        >
                          <ListPlus size={16} />
                        </IconButton>
                      )}
                      <IconButton
                        label={`Убрать трек: ${track.title}`}
                        disabled={!canUse || busy}
                        onClick={() => command('remove', { trackId: track.id })}
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {state.enabled && self?.owner && (
              <button
                className="button ghost full"
                disabled={!canUse || busy}
                onClick={() => void run(api.disable, true)}
              >
                <Unplug size={17} />
                Убрать сервис из встречи
              </button>
            )}
          </>
        )}
      </section>
      {canUse && (
        <YandexIntegration
          meeting={meeting}
          update={update}
          storedToken={preferences.yandexMusicToken}
          onStoredTokenChange={(next) => meeting.media.saveSettings({ yandexMusicToken: next })}
        />
      )}
      <section className="service-card telegram-card">
        <div className="service-heading">
          <span className="service-icon telegram">
            <Send size={22} />
          </span>
          <div>
            <h3>Telegram</h3>
            <p>Встреча и музыка из вашей беседы</p>
          </div>
        </div>
        {username ? (
          <>
            <a
              href={`https://t.me/${username}?startgroup=true`}
              target="_blank"
              rel="noopener noreferrer"
              className="button secondary full"
            >
              Добавить @{username} в чат
            </a>
            <p className="form-footnote">
              Ответьте на аудиофайл командой /play@{username}. /meet откроет встречу. Привязку можно менять
              отдельно для каждого чата и темы.
            </p>
            {self?.owner && active && (
              <button
                className="button secondary full"
                disabled={!canUse || busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    setLink(await api.linkTelegram());
                    setCopied(false);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Связать эту комнату с чатом
              </button>
            )}
            {link && (
              <div className="telegram-link">
                <p>
                  Отправьте эту команду в нужный чат или тему от имени администратора. Код действует 15 минут.
                </p>
                <code>{link.command}</code>
                <button
                  className="button secondary full"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(link.command)
                      .then(() => setCopied(true))
                      .catch(() => setError('Выделите и скопируйте команду вручную'));
                  }}
                >
                  <Copy size={16} />
                  {copied ? 'Скопировано' : 'Скопировать команду'}
                </button>
                <p className="form-footnote">
                  Участники привязанного чата смогут открывать эту комнату и управлять общей музыкой.
                </p>
              </div>
            )}
          </>
        ) : (
          <p className="muted">
            Подключение Telegram настраивается на сервере. Загрузка файлов в музыку доступна отдельно.
          </p>
        )}
      </section>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
