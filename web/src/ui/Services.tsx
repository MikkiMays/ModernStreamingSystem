import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Music2, Unplug } from 'lucide-react';
import type { Meeting } from '../core/meeting';
import {
  YandexApi,
  MusicApi,
  servicesApi,
  type MusicAction,
  type MusicState,
  type MusicTrack,
} from '../core/services';
import { allowed, type RoomAction } from '../core/permissions';
import { useStore } from './primitives';
import { Button } from './kit';
import { YandexIntegration, useYandexAccount } from './YandexIntegration';
import { MusicPlayer } from './MusicPlayer';
import { MusicQueue } from './MusicQueue';
import { MusicSearch } from './MusicSearch';
import { MusicUpload } from './MusicUpload';
import { CinemaGroup } from './cinema/CinemaGroup';
import { GamesGroup } from './GamesGroup';
import { IntegrationShelf } from './IntegrationShelf';
import { musicHint, SHELF, type ShelfId } from './integration-shelf';
import { foresee, foresightSpent, offeredSources, type Foresight } from './music-playback';
import { gameActivity, musicActivity } from './services-status';

/**
 * Панель интеграций встречи: витрина (`IntegrationShelf`) и внутри — группа.
 *
 * ПОРЯДОК ВНУТРИ МУЗЫКИ — ЭТО ПОВЕДЕНИЕ, А НЕ ОФОРМЛЕНИЕ. Загрузка файлов, очередь и поиск
 * раньше показывались и тогда, когда музыкального сервиса во встрече ещё не было. Треки в
 * такую очередь и правда складывались — но играть их было некому, и человек оставался с
 * полным списком и тишиной. Поэтому сначала плеер: пока его нет, панель предлагает ровно одно
 * действие, а всё, что относится к содержимому и источникам, появляется после него.
 */
type Group = 'cinema' | 'music' | 'games';
const OPENS: readonly ShelfId[] = ['cinema', 'music', 'games'];
const NAMES = Object.fromEntries(SHELF.map((item) => [item.id, item.name])) as Record<ShelfId, string>;

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
  /*
    Права — ответ ядра (`you.can`), а не правило, пересчитанное здесь. Каждое действие спрашивается
    своим именем: убрать музыку может каждый, кому разрешены интеграции, а не только ведущий (T14).
  */
  const can = (action: RoomAction) => active && allowed(snapshot, meeting.admission.participantId, action);
  const canUse = can('music.control');
  const canRemove = can('music.remove');
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
  const client = useQueryClient();
  const key = ['music', meeting.admission.roomId, meeting.admission.participantId];
  const catalog = useQuery({ queryKey: ['services'], queryFn: servicesApi.catalog, staleTime: 30000 });
  const music = useQuery({
    queryKey: key,
    queryFn: api.state,
    enabled: active,
    refetchInterval: active ? 2000 : false,
  });
  const musicStatus = musicActivity(music.data, music.isError);
  const gamesStatus = gameActivity(snapshot.poker, snapshot.durak, snapshot.chess, snapshot.gartic);
  const running: Record<Group, boolean> = {
    cinema: !!snapshot.watch,
    music: musicStatus.active,
    games: gamesStatus.active,
  };
  const RIVALS: Record<Group, Group[]> = {
    cinema: ['music', 'games'],
    music: ['cinema'],
    games: ['cinema'],
  };
  const blockedBy = (group: Group): Group | null =>
    running[group] ? null : (RIVALS[group].find((rival) => running[rival]) ?? null);
  // `busy` covers only what genuinely takes seconds and changes the room: adding the service,
  // removing it, changing who may use it. The transport buttons are not that, and disabling
  // them for the length of a round trip is what made the panel look like it was reloading.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [foresight, setForesight] = useState<Foresight | null>(null);
  // Сколько команд очереди ушло и ещё без ответа — для предсказания (`command`).
  const inFlight = useRef(0);
  const sources = useMemo(() => offeredSources(catalog.data?.sources), [catalog.data?.sources]);
  const served = music.data;
  const state = foresee(served, foresight);
  const yandexOn = sources.includes('yandex') && can('yandex.connect');
  const yandexAccount = useYandexAccount(yandexApi, meeting.admission.roomId, yandexOn && !!state?.enabled);
  useEffect(() => {
    if (foresightSpent(served, foresight)) setForesight(null);
  }, [served, foresight]);

  // The bot holds a seat in the room, so only joining and leaving change the snapshot.
  // Refreshing it after every play or skip fetched the whole meeting a second time and
  // repainted the panel, which read as the panel reloading on every button.
  const update = (next: MusicState, rosterChanged = false) => {
    client.setQueryData(key, next);
    if (rosterChanged) void meeting.refresh();
  };
  const run = async (job: () => Promise<MusicState>, rosterChanged = false) => {
    setError('');
    try {
      update(await job(), rosterChanged);
    } catch (e) {
      // The server did not agree, so what is on screen is not true. Показываем, как есть.
      setForesight(null);
      setError((e as Error).message);
    }
  };

  const command = (
    action: MusicAction,
    extra?: Parameters<MusicApi['command']>[1],
    patch?: Partial<MusicState>,
  ) => {
    if (!canUse) return;
    /*
      Каждая команда сдвигает ревизию службы на одну. Если до этой ещё не ответили прежние (две
      перестановки стрелками подряд), предсказание живёт, пока служба не применит и их: иначе ответ
      на первую сбросил бы его, и список на миг откатился бы ко второй половине пути.
    */
    const ahead = inFlight.current;
    inFlight.current += 1;
    if (patch && state) setForesight({ base: state.revision + ahead, patch });
    void run(() => api.command(action, extra)).finally(() => {
      inFlight.current -= 1;
    });
  };
  /** Joining and leaving the room take seconds and change who is in it; those do wait. */
  const heavy = async (job: () => Promise<MusicState>, permitted: boolean) => {
    if (busy || !permitted) return;
    setBusy(true);
    try {
      await run(job, true);
    } finally {
      setBusy(false);
    }
  };
  /*
    Сохранённый токен Яндекса подставляется при добавлении музыки — как и раньше по умолчанию.
    Выбор «источника по умолчанию» перед добавлением убран: он решал только это, а источник теперь
    выбирается поиском.
  */
  const enableMusic = () =>
    void heavy(async () => {
      const token = preferences.yandexMusicToken.trim();
      if (sources.includes('yandex') && token)
        await yandexApi
          .connectToken(token)
          .catch(() =>
            setError(
              'Не удалось подключить сохранённый токен Яндекс Музыки. Подключите аккаунт вручную ниже.',
            ),
          );
      return api.enable();
    }, can('music.enable'));

  if (!group) {
    const blocked = Object.fromEntries(
      OPENS.map((id) => [id, blockedBy(id as Group)])
        .filter(([, rival]) => rival)
        .map(([id, rival]) => [id, NAMES[rival as ShelfId]]),
    );
    return (
      <div className="services-panel" key="groups">
        <IntegrationShelf
          hints={{ music: musicHint(sources) }}
          live={{
            cinema: running.cinema ? 'Идёт показ' : undefined,
            music: musicStatus.active ? musicStatus.label : undefined,
            games: gamesStatus.active ? gamesStatus.label : undefined,
          }}
          blockedBy={blocked}
          canLinkTelegram={can('telegram.link')}
          onOpen={(id) => {
            if ((OPENS as readonly string[]).includes(id)) setGroup(id as Group);
          }}
        />
        {error && (
          <p className="services-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (group === 'cinema')
    return (
      <div className="services-panel" key="cinema">
        <CinemaGroup meeting={meeting} onBack={() => setGroup(null)} />
      </div>
    );

  if (group === 'games')
    return (
      <div className="services-panel" key="games">
        <GamesGroup meeting={meeting} onBack={() => setGroup(null)} />
      </div>
    );

  const platforms = sources.filter((source) => source === 'youtube' || source === 'soundcloud');
  const yandexReady = yandexOn && can('yandex.search');
  return (
    <div className="services-panel music-panel" key="music">
      <Button
        variant="quiet"
        size="sm"
        className="music-panel__back"
        icon={<ArrowLeft />}
        onClick={() => setGroup(null)}
      >
        Интеграции
      </Button>
      {active && !can('integrations.use') && (
        <p className="music-panel__note">
          Организатор разрешил управление интеграциями только себе. Громкость музыки для себя можно менять
          ниже.
        </p>
      )}
      {!active ? (
        <p className="music-panel__note">Музыка доступна после входа во встречу.</p>
      ) : catalog.isError || music.isError ? (
        <div role="alert" className="music-panel__problem">
          <p>Музыка сейчас не отвечает.</p>
          <Button
            size="sm"
            onClick={() => {
              void catalog.refetch();
              void music.refetch();
            }}
          >
            Повторить
          </Button>
        </div>
      ) : !state ? (
        <p role="status" className="music-panel__note">
          Подключаем музыку…
        </p>
      ) : !state.enabled ? (
        <section className="music-intro" aria-labelledby="music-intro-title">
          <span className="music-intro__icon" aria-hidden="true">
            <Music2 size={26} />
          </span>
          <h3 id="music-intro-title">Музыка</h3>
          <p>Одна очередь на всю встречу: {musicHint(sources)}. Занимает одно место во встрече.</p>
          {state.queue.length > 0 && (
            <p className="music-intro__queue">
              Очередь никуда не делась: {state.queue.length} трек(ов) заиграют, как только музыка вернётся во
              встречу.
            </p>
          )}
          {can('music.enable') ? (
            <Button variant="primary" full loading={busy} icon={<Music2 />} onClick={enableMusic}>
              Добавить во встречу
            </Button>
          ) : (
            <p className="music-intro__queue">Добавлять интеграции организатор разрешил только себе.</p>
          )}
          {state.error && (
            <p className="services-error" role="alert">
              {state.error}
            </p>
          )}
        </section>
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
            <p className="services-error" role="alert">
              {state.error}
            </p>
          )}
          {/* Добавлять — тем, кому разрешены интеграции; остальным поле только обещало бы отказ. */}
          {can('integrations.use') && (
            <MusicUpload
              canUse={can('music.upload')}
              maxFileBytes={catalog.data?.maxFileBytes ?? 50 * 1024 * 1024}
              upload={(file, signal) => api.upload(file, signal)}
              onAdded={update}
              onError={setError}
            >
              <MusicSearch
                abilities={{
                  platforms,
                  canSearch: can('music.search'),
                  searchPlatform: api.search,
                  addLink: can('music.link') ? api.addLink : null,
                  yandex: yandexReady
                    ? {
                        connected: !!yandexAccount.data?.connected,
                        search: yandexApi.search,
                        add: can('yandex.queue') ? yandexApi.enqueue : null,
                      }
                    : null,
                }}
                onAdded={update}
              />
            </MusicUpload>
          )}
          <MusicQueue
            state={state}
            canUse={canUse}
            onClear={(patch) => command('clear', undefined, patch)}
            onPromote={(track: MusicTrack, patch) => command('next', { trackId: track.id }, patch)}
            onRemove={(track: MusicTrack, patch) => command('remove', { trackId: track.id }, patch)}
            onMove={(track: MusicTrack, index, patch) => command('move', { trackId: track.id, index }, patch)}
          />
          {yandexOn && (
            <YandexIntegration
              api={yandexApi}
              roomId={meeting.admission.roomId}
              storedToken={preferences.yandexMusicToken}
              onStoredTokenChange={(next) => meeting.media.saveSettings({ yandexMusicToken: next })}
            />
          )}
          {canRemove && (
            <Button
              variant="quiet"
              className="music-panel__remove"
              icon={<Unplug />}
              loading={busy}
              onClick={() => void heavy(api.disable, canRemove)}
            >
              Убрать музыку из встречи
            </Button>
          )}
        </>
      )}
      {error && (
        <p className="services-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
