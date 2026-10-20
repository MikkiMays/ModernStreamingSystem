import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Music2, Unplug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
import { TelegramGroup } from './TelegramGroup';
import { IntegrationShelf } from './IntegrationShelf';
import { musicHint, shelfName, type ShelfId } from './integration-shelf';
import { foresee, foresightSpent, offeredSources, type Foresight } from './music-playback';
import {
  lastPlatform,
  offeredPlatforms,
  openPlatform,
  platformTiles,
  type MusicPlatform,
} from './music-platforms';
import { PlatformPicker, PlatformTabs, useLastPlatform } from './PlatformPicker';
import { gameActivity, musicActivity } from './services-status';

/**
 * Панель интеграций встречи: витрина (`IntegrationShelf`) и внутри — группа.
 *
 * ПОРЯДОК ВНУТРИ МУЗЫКИ — ЭТО ПОВЕДЕНИЕ, А НЕ ОФОРМЛЕНИЕ. Загрузка файлов, очередь и поиск
 * раньше показывались и тогда, когда музыкального сервиса во встрече ещё не было. Треки в
 * такую очередь и правда складывались — но играть их было некому, и человек оставался с
 * полным списком и тишиной. Поэтому сначала плеер: пока его нет, панель предлагает ровно одно
 * действие, а всё, что относится к содержимому и источникам, появляется после него.
 *
 * ВХОД В МУЗЫКУ — ВЫБОР ПЛОЩАДКИ, КАК В КИНОЗАЛЕ (T59). Сначала экран площадок (`PlatformPicker`,
 * общий с кинозалом), потом музыка выбранной площадки: поиск и ссылки — только её, вкладки сверху
 * меняют площадку на месте. Плеер и очередь — одни на встречу и от площадки не зависят: смена
 * площадки не шлёт службе ничего.
 */
type Group = 'cinema' | 'music' | 'games';
const OPENS: readonly ShelfId[] = ['cinema', 'music', 'games'];

export function Services({ meeting }: { meeting: Meeting }) {
  /**
   * Какая группа открыта. `null` — витрина. Переход между ними не мгновенный: у панели есть
   * короткая анимация появления, иначе подмена содержимого читается как сбой, а не как шаг.
   */
  const { t } = useTranslation();
  const [group, setGroup] = useState<Group | 'telegram' | null>(null);
  /**
   * Площадка музыки, выбранная после входа. `null` — экран выбора: так музыка открывается каждый
   * раз, как и кинозал. Прошлый выбор помнит устройство и отмечает его на этом экране.
   */
  const [chosen, setChosen] = useState<MusicPlatform | null>(null);
  /** Ссылка, принесённая с другой площадки, — в поле только что открытой. */
  const [carried, setCarried] = useState('');
  const memory = useLastPlatform(meeting, 'music');
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
  const musicStatus = musicActivity(t, music.data, music.isError);
  const gamesStatus = gameActivity(t, snapshot.poker, snapshot.durak, snapshot.chess, snapshot.gartic);
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
  /** Площадки музыки этого сервера; YouTube и SoundCloud включены, пока `MUSIC_SOURCES` их не убрал. */
  const platforms = useMemo(() => offeredPlatforms(sources), [sources]);
  const platform = openPlatform(chosen, platforms);
  /** Открыть площадку — с экрана выбора, вкладкой или «Перейти» под полем — и запомнить выбор. */
  const choose = (next: MusicPlatform, text = '') => {
    setChosen(next);
    setCarried(text);
    memory.remember(next);
  };
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
        await yandexApi.connectToken(token).catch(() => setError(t(($) => $.services.music.tokenFailed)));
      return api.enable();
    }, can('music.enable'));

  if (!group) {
    const blocked = Object.fromEntries(
      OPENS.map((id) => [id, blockedBy(id as Group)])
        .filter(([, rival]) => rival)
        .map(([id, rival]) => [id, shelfName(t, rival as ShelfId)]),
    );
    return (
      <div className="services-panel" key="groups">
        <IntegrationShelf
          hints={{ music: musicHint(t, sources) }}
          live={{
            cinema: running.cinema ? t(($) => $.services.cinemaLive) : undefined,
            music: musicStatus.active ? musicStatus.label : undefined,
            games: gamesStatus.active ? gamesStatus.label : undefined,
          }}
          blockedBy={blocked}
          canLinkTelegram={can('telegram.link')}
          telegramReady={!!catalog.data?.telegram.webapp}
          onOpen={(id) => {
            // Привязка беседы — не интеграция во встрече: с остальными за сцену и звук не спорит.
            if (id === 'telegram') {
              if (can('telegram.link')) setGroup('telegram');
              return;
            }
            if (!(OPENS as readonly string[]).includes(id)) return;
            // Музыка, как и кинозал, каждый раз открывается выбором площадки.
            if (id === 'music') setChosen(null);
            setGroup(id as Group);
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

  if (group === 'telegram')
    return (
      <div className="services-panel" key="telegram">
        <TelegramGroup meeting={meeting} onBack={() => setGroup(null)} />
      </div>
    );

  if (group === 'games')
    return (
      <div className="services-panel" key="games">
        <GamesGroup meeting={meeting} onBack={() => setGroup(null)} />
      </div>
    );

  const yandexReady = yandexOn && can('yandex.search');
  const tiles = platformTiles(t, platforms);
  const current = state?.enabled ? state.queue[0] : undefined;

  /*
    Вход в музыку — выбор площадки, как в кинозале (T59). Если сервер не оставил ни одной площадки
    (только Telegram), выбирать нечего: сразу плеер и очередь.
  */
  if (!platform && platforms.length)
    return (
      <div className="services-panel music-panel" key="music-pick">
        <PlatformPicker
          className="music-picker"
          title={shelfName(t, 'music')}
          backLabel={t(($) => $.services.music.back)}
          onBack={() => setGroup(null)}
          label={t(($) => $.music.platforms.tiles)}
          tiles={tiles}
          last={lastPlatform(memory.last, platforms)}
          onPick={(id) => choose(id)}
          now={
            current && (
              <p>
                {state?.paused ? t(($) => $.music.platforms.paused) : t(($) => $.music.platforms.playing)}{' '}
                <b>{current.title}</b>
                {current.artist && <small>{current.artist}</small>}
              </p>
            )
          }
        />
      </div>
    );

  /** Чем добавлять на открытой площадке: поле поиска и ссылок или, у своих файлов, загрузка. */
  const adder =
    platform === 'upload' ? (
      <MusicUpload
        canUse={can('music.upload')}
        maxFileBytes={catalog.data?.maxFileBytes ?? 50 * 1024 * 1024}
        upload={(file, signal) => api.upload(file, signal)}
        onAdded={update}
        onError={setError}
      >
        <p className="music-add__lead">{t(($) => $.music.platforms.upload.drop)}</p>
      </MusicUpload>
    ) : platform ? (
      <>
        {/* Аккаунт Яндекса — на его площадке, над полем: без аккаунта там искать нечем. */}
        {platform === 'yandex' && yandexOn && (
          <YandexIntegration
            api={yandexApi}
            roomId={meeting.admission.roomId}
            storedToken={preferences.yandexMusicToken}
            onStoredTokenChange={(next) => meeting.media.saveSettings({ yandexMusicToken: next })}
          />
        )}
        {(platform !== 'yandex' || (yandexReady && yandexAccount.data?.connected)) && (
          <MusicSearch
            key={platform}
            abilities={{
              platform,
              offered: platforms,
              canSearch: can('music.search'),
              searchPlatform: api.search,
              addLink: can('music.link') ? api.addLink : null,
              yandex:
                platform === 'yandex' && yandexReady
                  ? {
                      connected: !!yandexAccount.data?.connected,
                      search: yandexApi.search,
                      add: can('yandex.queue') ? yandexApi.enqueue : null,
                    }
                  : null,
            }}
            initialQuery={carried}
            onSwitch={choose}
            onAdded={update}
          />
        )}
      </>
    ) : null;

  return (
    <div className="services-panel music-panel" key="music">
      <Button
        variant="quiet"
        size="sm"
        className="music-panel__back"
        icon={<ArrowLeft />}
        onClick={() => setGroup(null)}
      >
        {t(($) => $.services.music.back)}
      </Button>
      {platform ? (
        <PlatformTabs
          label={t(($) => $.music.platforms.label)}
          tiles={tiles}
          current={platform}
          onPick={(id) => choose(id)}
        />
      ) : (
        <p className="music-panel__note">{t(($) => $.music.platforms.none)}</p>
      )}
      {active && !can('integrations.use') && (
        <p className="music-panel__note">{t(($) => $.services.music.locked)}</p>
      )}
      {!active ? (
        <p className="music-panel__note">{t(($) => $.services.music.needJoin)}</p>
      ) : catalog.isError || music.isError ? (
        <div role="alert" className="music-panel__problem">
          <p>{t(($) => $.services.music.down)}</p>
          <Button
            size="sm"
            onClick={() => {
              void catalog.refetch();
              void music.refetch();
            }}
          >
            {t(($) => $.services.music.retry)}
          </Button>
        </div>
      ) : !state ? (
        <p role="status" className="music-panel__note">
          {t(($) => $.services.music.connecting)}
        </p>
      ) : !state.enabled ? (
        <section className="music-intro" aria-labelledby="music-intro-title">
          <span className="music-intro__icon" aria-hidden="true">
            <Music2 size={26} />
          </span>
          <h3 id="music-intro-title">{t(($) => $.services.music.title)}</h3>
          <p>{t(($) => $.services.music.intro, { sources: musicHint(t, sources) })}</p>
          {state.queue.length > 0 && (
            <p className="music-intro__queue">
              {t(($) => $.services.music.queueKept, { count: state.queue.length })}
            </p>
          )}
          {can('music.enable') ? (
            <Button variant="primary" full loading={busy} icon={<Music2 />} onClick={enableMusic}>
              {t(($) => $.services.music.enable)}
            </Button>
          ) : (
            <p className="music-intro__queue">{t(($) => $.services.music.enableLocked)}</p>
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
          {can('integrations.use') && adder}
          <MusicQueue
            state={state}
            canUse={canUse}
            onClear={(patch) => command('clear', undefined, patch)}
            onPromote={(track: MusicTrack, patch) => command('next', { trackId: track.id }, patch)}
            onRemove={(track: MusicTrack, patch) => command('remove', { trackId: track.id }, patch)}
            onMove={(track: MusicTrack, index, patch) => command('move', { trackId: track.id, index }, patch)}
          />
          {canRemove && (
            <Button
              variant="quiet"
              className="music-panel__remove"
              icon={<Unplug />}
              loading={busy}
              onClick={() => void heavy(api.disable, canRemove)}
            >
              {t(($) => $.services.music.remove)}
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
