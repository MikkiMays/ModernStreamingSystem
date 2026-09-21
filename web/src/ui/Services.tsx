import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Gamepad2, Music2, Send, Tv, Unplug } from 'lucide-react';
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
import { CinemaGroup } from './CinemaGroup';
import { PokerGroup } from './PokerGroup';
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
type Group = 'cinema' | 'music' | 'games' | 'telegram';
type GroupCard = {
  id: Group;
  name: string;
  hint: string;
  icon: typeof Music2;
  accent: string;
  ready: boolean;
};
const GROUPS: GroupCard[] = [
  {
    id: 'cinema',
    name: 'Кинозал',
    hint: 'YouTube и Twitch на всю комнату',
    icon: Tv,
    accent: '#4674f3',
    ready: true,
  },
  {
    id: 'music',
    name: 'Музыка',
    hint: 'Общая очередь и Яндекс Музыка',
    icon: Music2,
    accent: '#1f9d63',
    ready: true,
  },
  {
    id: 'games',
    name: 'Игры',
    hint: 'Покер на всю комнату, до десяти игроков',
    icon: Gamepad2,
    accent: '#8a5cf6',
    ready: true,
  },
];
/**
 * Telegram стоит отдельно и внизу — и пока не открывается.
 *
 * Он не «ещё один сервис во встрече»: остальные три звучат и показывают, а этот связывает
 * комнату с беседой снаружи. Жил он при музыке — как её часть, хотя музыка про него не знает
 * ничего, кроме того, что оттуда тоже присылают треки. Нынешняя привязка устарела целиком и
 * будет переделана; до тех пор она недоступна, как и «Игры», — обещание видно, а не спрятано.
 */
const TELEGRAM: GroupCard = {
  id: 'telegram',
  name: 'Telegram',
  hint: 'Встреча и музыка из вашей беседы',
  icon: Send,
  accent: '#2ea6da',
  ready: false,
};

export function Services({ meeting }: { meeting: Meeting }) {
  /**
   * Какая группа открыта. `null` — витрина. Переход между ними не мгновенный: у панели есть
   * короткая анимация появления, иначе подмена содержимого читается как сбой, а не как шаг.
   */
  const [group, setGroup] = useState<Group | null>(null);
  const api = useMemo(() => new MusicApi(meeting.admission), [meeting]);
  const yandexApi = useMemo(() => new YandexApi(meeting.admission), [meeting]);
  const snapshot = useStore(meeting.snapshot);
  const volumes = useStore(meeting.media.volumes);
  const preferences = useStore(meeting.media.preferences);
  const ended = useStore(meeting.ended);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const active = !!self && ['JOINING', 'CONNECTED', 'RECOVERING'].includes(self.status) && !ended;
  const canUse = active && (self?.owner || snapshot.integrationsAllowed !== false);
  /**
   * Что во встрече занято прямо сейчас — и что чему мешает.
   *
   * Спорят не все со всеми, а за одно и то же. Кинозал и покер делят **сцену**: там и там
   * смотреть нужно в середину экрана, и вместе они не помещаются. Кинозал и музыка делят
   * **уши**: два звука разом — это не две интеграции, а ни одной. А музыка со столом не спорит
   * вовсе, и играть под неё в карты — ровно то, чего от домашней игры и ждут.
   *
   * Запреты стоят в ядре; здесь они лишь видны заранее, до нажатия.
   */
  const running: Record<Group, boolean> = {
    cinema: !!snapshot.watch,
    music: snapshot.participants.some(
      (person) => person.service === 'music' && person.status !== 'LEFT' && person.status !== 'REMOVED',
    ),
    games: !!snapshot.poker,
    telegram: false,
  };
  const RIVALS: Record<Group, Group[]> = {
    cinema: ['music', 'games'],
    music: ['cinema'],
    games: ['cinema'],
    telegram: [],
  };
  const blockedBy = (group: Group): Group | null =>
    running[group] ? null : (RIVALS[group].find((rival) => running[rival]) ?? null);
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

  /*
    Панель интеграций — это витрина, а не длинный список всего сразу.

    Раньше здесь одной страницей лежали и музыка, и Яндекс, и Telegram; кинозал стал бы
    четвёртым, и человек искал бы нужное прокруткой. Теперь сверху группы — «Кинозал»,
    «Музыка», «Игры», — а внутри каждой её собственные сервисы. Группа «Игры» пустая
    намеренно: место для неё занято, и обещание видно, а не спрятано в планах.
  */
  const groupCard = (item: GroupCard) => {
    // Занятую группу открыть можно — там её и выключают; ту, которой мешает соседняя, нет.
    // Ненаписанной группе объяснять нечего: у неё свой ответ — «скоро».
    const blocked = item.ready ? blockedBy(item.id) : null;
    return (
      <button
        key={item.id}
        className="service-group"
        data-active={running[item.id] ? 'true' : undefined}
        disabled={!item.ready || !!blocked}
        onClick={() => item.ready && !blocked && setGroup(item.id)}
      >
        <span className="service-group-icon" style={{ background: item.accent }}>
          <item.icon size={24} />
        </span>
        <span>
          <b>{item.name}</b>
          <small>
            {blocked
              ? `Сейчас активна другая интеграция — ${GROUPS.find((g) => g.id === blocked)?.name}`
              : item.hint}
          </small>
        </span>
        {!item.ready && <span className="service-soon">Скоро</span>}
        {running[item.id] && <span className="service-live">Активна</span>}
      </button>
    );
  };

  if (!group)
    return (
      <div className="services-panel" key="groups">
        <h3 className="services-title">Что добавить во встречу</h3>
        <div className="service-groups">{GROUPS.map(groupCard)}</div>
        <div className="service-groups service-groups-apart">{groupCard(TELEGRAM)}</div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );

  if (group === 'cinema')
    return (
      <div className="services-panel" key="cinema">
        <CinemaGroup meeting={meeting} onBack={() => setGroup(null)} />
      </div>
    );

  if (group === 'games')
    return (
      <div className="services-panel" key="games">
        <PokerGroup meeting={meeting} onBack={() => setGroup(null)} />
      </div>
    );

  return (
    <div className="services-panel" key="music">
      <button className="text-button cinema-back" onClick={() => setGroup(null)}>
        <ArrowLeft size={16} /> Группы интеграций
      </button>
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
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
