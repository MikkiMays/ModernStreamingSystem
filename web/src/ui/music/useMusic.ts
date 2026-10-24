import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../../core/meeting';
import { allowed, type RoomAction } from '../../core/permissions';
import {
  MusicApi,
  servicesApi,
  YandexApi,
  type MusicAction,
  type MusicSource,
  type MusicState,
} from '../../core/services';
import { Store } from '../../core/store';
import { foresee, foresightSpent, offeredSources, type Foresight } from '../music-playback';
import { lastPlatform, offeredPlatforms, type MusicPlatform } from '../music-platforms';
import { useLastPlatform } from '../PlatformPicker';
import { useStore } from '../primitives';

/**
 * Музыка встречи — одним хуком на всех, кто её показывает (R31, R44): панель интеграций, мини-плеер
 * и чип над сценой.
 *
 * ЗАЧЕМ ОБЩЕЕ. Раньше состояние, команды и права музыки жили внутри панели (`Services.tsx`), а чип
 * над сценой спрашивал службу сам. Мини-плеер поверх игры — третий потребитель, и у каждого было бы
 * своё «нажал — уже видно» (предсказание) и свой опрос. Теперь у встречи одно общее место
 * (`shared`): предсказание нажатий, счёт команд в пути, «добавляем/убираем» и отказы площадок —
 * нажатие в мини-плеере сразу видно и в панели. Опрос — один на встречу: опрашивает первый из
 * потребителей, которым он нужен, остальные читают тот же кэш запроса.
 *
 * Площадка (YouTube, SoundCloud, Яндекс, свои файлы) — выбор устройства (`lastPlatform`): вход в
 * музыку больше не начинается с экрана площадок, вкладки — внутри плеера, и выбор не сбрасывается.
 */
interface Shared {
  /** Ещё не подтверждённое нажатие (`foresee`). */
  foresight: Foresight | null;
  /** Сколько команд ушло и ещё без ответа: предсказание живёт, пока служба не применит и их. */
  inFlight: number;
  /** Добавляем или убираем музыку — это секунды и меняет состав встречи. */
  busy: boolean;
  error: string;
  /** Площадки, которые служба только что отказала как недоступные с этого сервера (R112). */
  refused: readonly MusicSource[];
  /** Кто опрашивает службу: первый в списке. */
  pollers: readonly symbol[];
}

const SHARED = new WeakMap<Meeting, Store<Shared>>();

function sharedOf(meeting: Meeting): Store<Shared> {
  let found = SHARED.get(meeting);
  if (!found) {
    found = new Store<Shared>({
      foresight: null,
      inFlight: 0,
      busy: false,
      error: '',
      refused: [],
      pollers: [],
    });
    SHARED.set(meeting, found);
  }
  return found;
}

const LIVE: readonly string[] = ['JOINING', 'CONNECTED', 'RECOVERING'];
/** Как часто спрашивать службу, пока музыку кто-то показывает. */
export const MUSIC_POLL_MS = 2000;

export type MusicCommand = (
  action: MusicAction,
  extra?: Parameters<MusicApi['command']>[1],
  patch?: Partial<MusicState>,
) => void;

export function useMusic(meeting: Meeting, { poll = true }: { poll?: boolean } = {}) {
  const { t } = useTranslation();
  const store = sharedOf(meeting);
  const shared = useStore(store);
  const [token] = useState(() => Symbol('music'));
  const client = useQueryClient();
  const snapshot = useStore(meeting.snapshot);
  const ended = useStore(meeting.ended);
  const preferences = useStore(meeting.media.preferences);
  const api = useMemo(() => new MusicApi(meeting.admission), [meeting]);
  const yandexApi = useMemo(() => new YandexApi(meeting.admission), [meeting]);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  /** Я во встрече (не в ожидании и не после конца) — только тогда служба отвечает. */
  const active = !!self && LIVE.includes(self.status) && !ended;
  /** Бот музыки сидит во встрече. */
  const present = snapshot.participants.some((p) => p.service === 'music' && LIVE.includes(p.status));
  /*
    Права — ответ ядра (`you.can`), а не правило, пересчитанное здесь. Каждое действие спрашивается
    своим именем: убрать музыку может каждый, кому разрешены интеграции, а не только ведущий (T14).
  */
  const can = (action: RoomAction) => active && allowed(snapshot, meeting.admission.participantId, action);

  const wants = active && poll;
  useEffect(() => {
    if (!wants) return;
    store.update((s) => ({ ...s, pollers: [...s.pollers, token] }));
    return () => store.update((s) => ({ ...s, pollers: s.pollers.filter((other) => other !== token) }));
  }, [store, token, wants]);
  const leader = wants && shared.pollers[0] === token;

  const key = ['music', meeting.admission.roomId, meeting.admission.participantId];
  const catalog = useQuery({
    queryKey: ['services'],
    queryFn: servicesApi.catalog,
    staleTime: 30000,
    enabled: wants,
  });
  const music = useQuery({
    queryKey: key,
    queryFn: api.state,
    enabled: wants,
    refetchInterval: leader ? MUSIC_POLL_MS : false,
  });
  const served = music.data;
  const state = foresee(served, shared.foresight);
  useEffect(() => {
    if (foresightSpent(served, store.get().foresight)) store.update((s) => ({ ...s, foresight: null }));
  }, [served, store]);

  const sources = useMemo(() => offeredSources(catalog.data?.sources), [catalog.data?.sources]);
  /** Площадки музыки этого сервера; YouTube и SoundCloud включены, пока `MUSIC_SOURCES` их не убрал. */
  const platforms = useMemo(() => offeredPlatforms(sources), [sources]);
  const memory = useLastPlatform(meeting, 'music');
  const platform: MusicPlatform | null = lastPlatform(memory.last, platforms) ?? platforms[0] ?? null;

  const down = useMemo(
    () => new Set<string>([...(catalog.data?.unreachable ?? []), ...shared.refused]),
    [catalog.data?.unreachable, shared.refused],
  );

  const setError = (error: string) => store.update((s) => ({ ...s, error }));
  // Бот сидит во встрече, поэтому только вход и уход меняют её снимок. Обновлять его после каждого
  // «играть» или «дальше» значило бы второй раз тянуть всю встречу и перерисовывать панель.
  const update = (next: MusicState, rosterChanged = false) => {
    client.setQueryData(key, next);
    if (rosterChanged) void meeting.refresh();
  };
  const run = async (job: () => Promise<MusicState>, rosterChanged = false) => {
    setError('');
    try {
      update(await job(), rosterChanged);
    } catch (e) {
      // Служба не согласилась — на экране неправда. Показываем, как есть.
      store.update((s) => ({ ...s, foresight: null, error: (e as Error).message }));
    }
  };
  const command: MusicCommand = (action, extra, patch) => {
    if (!can('music.control')) return;
    /*
      Каждая команда сдвигает ревизию службы на одну. Если до этой ещё не ответили прежние (две
      перестановки стрелками подряд), предсказание живёт, пока служба не применит и их: иначе ответ
      на первую сбросил бы его, и список на миг откатился бы ко второй половине пути.
    */
    const ahead = store.get().inFlight;
    store.update((s) => ({
      ...s,
      inFlight: s.inFlight + 1,
      ...(patch && state ? { foresight: { base: state.revision + ahead, patch } } : {}),
    }));
    void run(() => api.command(action, extra)).finally(() =>
      store.update((s) => ({ ...s, inFlight: s.inFlight - 1 })),
    );
  };
  /** Добавить и убрать музыку — секунды и смена состава встречи: эти ждут. */
  const heavy = async (job: () => Promise<MusicState>, permitted: boolean) => {
    if (store.get().busy || !permitted) return;
    store.update((s) => ({ ...s, busy: true }));
    try {
      await run(job, true);
    } finally {
      store.update((s) => ({ ...s, busy: false }));
    }
  };
  /*
    Сохранённый токен Яндекса подставляется при добавлении музыки — как и раньше по умолчанию.
    Выбор «источника по умолчанию» перед добавлением убран: он решал только это, а источник теперь
    выбирается вкладкой и поиском.
  */
  const enable = () =>
    void heavy(async () => {
      const saved = preferences.yandexMusicToken.trim();
      if (sources.includes('yandex') && saved)
        await yandexApi.connectToken(saved).catch(() => setError(t(($) => $.services.music.tokenFailed)));
      return api.enable();
    }, can('music.enable'));
  const disable = () => void heavy(api.disable, can('music.remove'));

  return {
    api,
    yandexApi,
    /** Ответ службы с ещё не подтверждёнными нажатиями. */
    state,
    active,
    present,
    can,
    /** Служба музыки не ответила или ответила своей ошибкой. */
    failed: music.isError || !!served?.error,
    /** Не достучались до службы или каталога вовсе — панель предлагает «Повторить». */
    down: catalog.isError || music.isError,
    loading: !served,
    catalog: catalog.data,
    sources,
    platforms,
    platform,
    setPlatform: memory.remember as (id: MusicPlatform) => void,
    /** Площадка недоступна с этого сервера (R112): по каталогу службы или по только что полученному отказу. */
    unreachable: (source: MusicSource) => down.has(source),
    /** Служба отказала: площадка недоступна отсюда — отметить её, не дожидаясь каталога. */
    refuse: (source: MusicSource) =>
      store.update((s) => (s.refused.includes(source) ? s : { ...s, refused: [...s.refused, source] })),
    /** «Повторить»: спросить службу снова — каталог сам проверит, вернулась ли площадка. */
    retry: () => {
      store.update((s) => ({ ...s, refused: [] }));
      void catalog.refetch();
      void music.refetch();
    },
    busy: shared.busy,
    error: shared.error,
    setError,
    update,
    command,
    enable,
    disable,
  };
}

export type MusicControl = ReturnType<typeof useMusic>;
