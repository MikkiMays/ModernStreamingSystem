import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import Hls from 'hls.js';
import {
  ArrowLeft,
  Captions,
  Clapperboard,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Settings2,
  SkipBack,
  Tv,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { Menu } from '@base-ui/react/menu';
import type { Watch } from '../api/types';
import type { Meeting } from '../core/meeting';
import { CinemaApi, clock, type CinemaSource } from '../core/cinema';
import { useFullscreen } from '../core/fullscreen';
import { correction, targetPosition, VISIBLE_DRIFT } from '../core/watch';
import { levelLabel, qualities, type Level } from './watch-levels';
import {
  audioChoices,
  captionChoices,
  pickAudio,
  pickCaption,
  type AudioChoice,
  type CaptionChoice,
} from './watch-tracks';
import { controlsShown, framePress, skipTarget } from './watch-controls';
import { attachDash, type DashPlayback } from './watch-dash';
import { IconButton, Slider, useStore } from './primitives';

/**
 * Кинозал: то, что комната смотрит вместе, своим плеером.
 *
 * ПОЧЕМУ СВОИМ. Раньше здесь стояла рамка YouTube. С машины сервера она работала, у человека —
 * нет: из его сети площадки недоступны, а рамка ходит из браузера, и поделать с этим нельзя
 * ничего. Теперь поток берёт сервер и отдаёт его со своего адреса (`core/cinema/api.ts`), а здесь
 * обычный `<video>` с hls.js. Побочные выгоды оказались крупнее самой починки: настоящий выбор
 * качества (уровни HLS, а не «шестерёнка внутри чужой рамки»), свои элементы управления, ни
 * одного чужого скрипта на странице и строгий CSP обратно.
 *
 * ЧТО ОБЩЕЕ, А ЧТО СВОЁ. Общее — это **что** открыто, идёт ли это и с какой секунды: пауза
 * одна на комнату, и нажать её может каждый, кому комната разрешает трогать интеграции. Своё —
 * то, о чём договариваться не с кем: громкость, качество приёма, полный экран и место в живом
 * эфире. Комната о них не знает и знать не должна.
 *
 * ГДЕ ЛЕЖИТ УПРАВЛЕНИЕ. Поверх кадра, а не полосой под ним, и с автоскрытием. Полоса под
 * кадром выглядела опрятнее, но в полноэкранном режиме разворачивался **только кадр** — и
 * пульт вместе с паузой и громкостью оставался за краем экрана. Поверх кадра эта разница
 * исчезает: разворачивается весь плеер целиком, и в окне, и во весь экран он один и тот же.
 *
 * Своё эхо отличается окном тишины после каждой своей же команды плееру: без него пауза,
 * поставленная по приказу комнаты, улетала бы в комнату как новое нажатие.
 */
const SUPPRESS_MS = 1200;
/** Сколько пульт висит без движения мыши, прежде чем уйти с кадра вместе с курсором. */
const IDLE_MS = 2800;
/**
 * Шаг перемотки кнопками, миллисекунды.
 *
 * Пятнадцать секунд — не круглое число, а привычка: столько отматывают плееры, у которых это
 * есть, и рука к ним уже приучена. Перемотка общая, как и пауза: комната смотрит одно кино, и
 * «отмотать себе» означало бы смотреть его в одиночку.
 */
const SKIP_MS = 15000;
/**
 * Насколько можно отстать от края живого эфира, прежде чем это стоит исправить прыжком.
 *
 * У эфира нет общей позиции, но есть край, и отстать от него можно надолго: одна затычка в
 * сети, и буфер растёт, а картинка едет с задержкой в полминуты — это и есть жалоба «звук
 * отстаёт на стриме», только отстаёт не звук от картинки, а всё вместе от эфира. Раз в секунду
 * сравниваем себя с краем и возвращаемся, если отстали слишком сильно; кнопка «LIVE» делает то
 * же самое по просьбе.
 */
const LIVE_LAG = 12;
/**
 * Отставание, которое для эфира нормально.
 *
 * У края эфира есть запас — три сегмента, — и это не задержка, а цена устойчивости: без него
 * любая заминка в сети останавливает картинку. Измерено на Twitch: обычное отставание около
 * пяти-шести секунд. Поэтому «мы на краю» — это не ноль, и красная точка горит до
 * {@link LIVE_EDGE}; дальше она гаснет, показывает число и предлагает вернуться.
 */
const LIVE_EDGE = 7;
/**
 * Реплика субтитров без разметки.
 *
 * Распознанная речь приходит с покадровой подсветкой — `слово<00:00:12.400><c> следующее</c>`,
 * — и в готовом виде это не текст, а разметка. Браузер разбирает её сам, но только для
 * дорожек, которые сам же и рисует; наши он держит как данные, и разбор остаётся за нами.
 * Заодно отсюда уходят пустые строки: у YouTube каждая вторая реплика — пустая половинка
 * бегущей строки.
 */
function spoken(cue: TextTrackCue): string {
  const raw =
    (cue as VTTCue).getCueAsHTML?.().textContent ?? ((cue as VTTCue).text as string | undefined) ?? '';
  return raw
    .replace(/<[^>]*>/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

type Status = 'loading' | 'ready' | 'blocked' | 'failed';

export function WatchTheater({
  meeting,
  watch,
  onBrowse,
}: {
  meeting: Meeting;
  watch: Watch;
  /** Открыть каталог, не закрывая просмотр. */
  onBrowse?: () => void;
}) {
  const snapshot = useStore(meeting.snapshot);
  const preferences = useStore(meeting.media.preferences);
  const api = useMemo(() => new CinemaApi(meeting.admission), [meeting]);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const owner = snapshot.participants.find((p) => p.id === watch.openedBy);
  /**
   * Пауза общая. Право на неё — то же самое право трогать во встрече постороннее: ведущему
   * всегда, остальным пока комната разрешает интеграции. Ядро проверяет это же правило;
   * здесь оно только показывается кнопками.
   */
  const canControl = !!self && (self.owner || snapshot.integrationsAllowed !== false);
  const [source, setSource] = useState<CinemaSource | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState('');
  const [levels, setLevels] = useState<Level[]>([]);
  const [level, setLevel] = useState(-1);
  const [automatic, setAutomatic] = useState(-1);
  const [voices, setVoices] = useState<AudioChoice[]>([]);
  const [voice, setVoice] = useState(-1);
  const [texts, setTexts] = useState<CaptionChoice[]>([]);
  const [text, setText] = useState('');
  const [lines, setLines] = useState<string[]>([]);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [drift, setDrift] = useState(0);
  const [lag, setLag] = useState(0);
  const [idle, setIdle] = useState(false);
  const [menu, setMenu] = useState(false);
  /** Какая страница открыта в шестерёнке: сам список разделов, качество или язык звука. */
  const [menuPage, setMenuPage] = useState<'root' | 'quality' | 'voice'>('root');
  const [captionMenu, setCaptionMenu] = useState(false);
  /**
   * Пальцем или мышью.
   *
   * Разница здесь не в удобстве, а в том, что означает нажатие по кадру. Мышь наводится
   * заранее, и пульт под ней уже виден — клик по кадру осмысленно ставит паузу. Палец
   * наводиться не умеет: первое касание в спящем плеере — это «покажи, что тут есть», и
   * принимать его за паузу значит останавливать кино каждый раз, когда до него дотронулись.
   */
  const coarse = useMemo(() => window.matchMedia?.('(pointer: coarse)').matches ?? false, []);
  const screen = useRef<HTMLDivElement>(null);
  /*
    КУДА КЛАДУТСЯ ПОПАПЫ ПЛЕЕРА, И ПОЧЕМУ ЭТО НЕ МЕЛОЧЬ.

    Меню качества и субтитров Base UI по умолчанию уезжают порталом в `body`. В полном экране
    браузер рисует **только поддерево развёрнутого элемента** — и меню открывалось в
    невидимости: нажатие срабатывало, попап существовал, а на экране не менялось ничего.
    Выглядело это как «в полном экране качество не переключается».

    Поэтому портал направлен в сам плеер (`container={screen}`): там он и в обычном режиме, и в
    полном экране лежит внутри того, что видно. Ссылка та же, что у полного экрана, — второй
    якорь развёл бы их однажды по разным элементам.
  */
  // На телефоне полноэкранного режима для чужих элементов нет, и кнопка там раскладывает
  // плеер на всё окно сама — см. {@link useFullscreen}.
  const { full: fullscreen, targetFull, toggle: toggleFullscreen } = useFullscreen(screen);
  const video = useRef<HTMLVideoElement>(null);
  const engine = useRef<Hls | null>(null);
  const dashEngine = useRef<DashPlayback | null>(null);
  const refreshing = useRef(false);
  const sourceGeneration = useRef(0);
  const renewals = useRef(0);
  const suppressUntil = useRef(0);
  const sending = useRef(false);
  const started = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loudness = useRef(Math.max(8, preferences.watchVolume || 70));
  /**
   * Что человек выбрал ушами и глазами, а не что сейчас играет.
   *
   * Живёт в ссылке, а не в состоянии, потому что спрашивают об этом изнутри плеера: список
   * звуковых дорожек у YouTube меняется на **каждой** смене качества (у каждой лестницы своя
   * группа звука), и на каждую такую смену выбор языка надо назначать заново.
   */
  const wantedVoice = useRef(preferences.watchAudio);
  const wantedText = useRef(preferences.watchSubtitles);
  const live = watch.kind === 'channel' || !!source?.live;
  const latest = useRef({ watch, canControl, live });
  latest.current = { watch, canControl, live };

  const suppress = () => {
    suppressUntil.current = Date.now() + SUPPRESS_MS;
  };
  const send = useCallback(
    (type: 'watch.play' | 'watch.pause' | 'watch.seek' | 'watch.close', positionMs?: number) => {
      if (sending.current) return;
      sending.current = true;
      void meeting
        .command(type, undefined, undefined, positionMs === undefined ? undefined : { positionMs })
        .catch((e) => meeting.media.report(e))
        .finally(() => {
          sending.current = false;
        });
    },
    [meeting],
  );

  // Адрес потока спрашиваем у своего сервера — он единственный, кто ходит к площадке.
  const content = `${watch.provider}:${watch.kind}:${watch.contentId}`;
  useEffect(() => {
    let alive = true;
    sourceGeneration.current++;
    renewals.current = 0;
    refreshing.current = false;
    setStatus('loading');
    setError('');
    setSource(null);
    setLevels([]);
    setLevel(-1);
    setVoices([]);
    setVoice(-1);
    setTexts([]);
    setLines([]);
    setDrift(0);
    setLag(0);
    started.current = false;
    const current = latest.current.watch;
    void api
      .resolve(current.provider, current.contentId, current.kind)
      .then((resolved) => {
        if (alive) setSource(resolved);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setStatus('failed');
        setError((e as Error).message || 'Не удалось открыть видео');
      });
    return () => {
      alive = false;
      sourceGeneration.current++;
    };
  }, [api, content]);

  const renewSource = useCallback(
    async (adaptive = true) => {
      if (refreshing.current) return;
      refreshing.current = true;
      const generation = sourceGeneration.current;
      const current = latest.current.watch;
      try {
        const resolved = await api.resolve(current.provider, current.contentId, current.kind, {
          adaptive,
          refresh: true,
        });
        if (generation !== sourceGeneration.current) return;
        suppressUntil.current = Date.now() + SUPPRESS_MS;
        setLevels([]);
        setLevel(-1);
        setAutomatic(-1);
        setStatus('loading');
        setSource(resolved);
      } catch (e) {
        if (generation === sourceGeneration.current) {
          setStatus('failed');
          setError((e as Error).message || 'Не удалось обновить поток');
        }
      } finally {
        if (generation === sourceGeneration.current) refreshing.current = false;
      }
    },
    [api],
  );

  useEffect(() => {
    if (!source?.expiresAt) return;
    const timer = setTimeout(
      () => void renewSource(source.kind === 'dash'),
      Math.max(1000, source.expiresAt - Date.now() - 60000),
    );
    return () => clearTimeout(timer);
  }, [source, renewSource]);

  // Плеер живёт, пока не сменился источник: пересоздавать его на каждое изменение комнаты —
  // это чёрный кадр у всех на каждую чужую паузу.
  useEffect(() => {
    const element = video.current;
    if (!source || !element) return;
    let alive = true;
    suppress();
    element.volume = Math.max(0, Math.min(1, preferences.watchVolume / 100));
    element.playbackRate = 1;
    const fail = (message: string) => {
      if (!alive) return;
      setStatus('failed');
      setError(message);
    };
    // Распознанная речь есть и у ролика без плейлиста: она приезжает отдельными файлами, и
    // её список известен раньше, чем плеер что-либо скажет о своих дорожках.
    setTexts(captionChoices([], source.captions));
    const preferred = wantedVoice.current || source.language;
    if (source.kind === 'file') {
      element.src = source.url;
    } else if (source.kind === 'dash') {
      void attachDash(element, source.url, preferred, {
        alive: () => alive,
        levels: (next, current) => {
          setLevels(next);
          setAutomatic(current);
        },
        voices: (next, current) => {
          setVoices(next);
          setVoice(current);
        },
        error: () => {
          if (refreshing.current) return;
          // Retry signed sources once, then use the compatible file rather than a retry loop.
          const adaptive = renewals.current++ === 0;
          void renewSource(adaptive);
        },
      })
        .then((player) => {
          if (!alive) player?.destroy();
          else dashEngine.current = player;
        })
        .catch(() => {
          if (alive) void renewSource(false);
        });
    } else if (Hls.isSupported()) {
      /*
        hls.js идёт первым, и это не вкусовщина.

        Chromium на вопрос «умеешь ли ты HLS» отвечает `maybe` — и что-то действительно
        играет, но без списка уровней: выбора качества нет, а адаптация сама уходит в
        максимум, то есть в 1440p через наш канал на каждого зрителя. Родной путь остаётся
        запасным для Safari, который HLS умеет по-настоящему.
      */
      const hls = new Hls({
        enableWorker: true,
        // Запас назад нужен ровно для того, ради чего люди и жмут «назад»: отмотать
        // на минуту, не скачивая её заново с нашего же канала.
        backBufferLength: 120,
        maxBufferLength: 30,
        fragLoadingMaxRetry: 6,
        manifestLoadingMaxRetry: 4,
        // Network throughput chooses automatic quality; a small player must not hide HD.
        capLevelToPlayerSize: false,
        /*
          Дыру в полсекунды лучше перескочить, чем встать перед ней.

          Значение по умолчанию — десятая доля секунды, и этого мало: у потока, собранного из
          отдельных дорожек звука и картинки (а YouTube отдаёт именно такой), пропуск в одной
          из них означает, что вторая продолжает идти. Слышно это как «звук ушёл вперёд», а
          выглядит как застывший кадр с живым звуком. Перескок склеивает такой пропуск за
          доли секунды вместо того, чтобы копить рассинхрон.
        */
        maxBufferHole: 0.5,
        nudgeMaxRetry: 8,
        /*
          Не начинать с самого дна.

          По умолчанию hls.js грузит первый кусок **нижним** уровнем, чтобы померить канал, —
          и кино у всех начинается с 240p, поднимаясь через несколько сегментов. Измерено:
          через четыре секунды после старта плеер всё ещё показывал 426×240 на экране в
          полторы тысячи пикселей.

          Мерить нам, в общем, нечего: поток идёт не от площадки, а от своего же сервера, и
          нижняя оценка в полмегабита к нему отношения не имеет. Поэтому начальная оценка —
          честные два с половиной мегабита, а дальше адаптация
          поправят в обе стороны за считаные секунды.
        */
        testBandwidth: false,
        abrEwmaDefaultEstimate: 2_500_000,
        // Край живого эфира: три сегмента запаса — обычная цена устойчивости, а дальше
        // двенадцати мы уже не отстаём, а смотрим запись.
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 12,
        /*
          Язык звука — до первого байта, а не после.

          У ролика с озвучками YouTube не помечает основной **ни одну** дорожку: `DEFAULT=NO`
          стоит у всех двадцати четырёх. Плеер в таком случае берёт первую по списку, а
          список отсортирован по коду языка — так английский ролик и начинал говорить
          по-арабски или по-французски. Подсказка здесь ставит нужную дорожку до загрузки,
          а не переключает уже играющую; если такого языка у ролика нет, выбор поправится
          по списку дорожек, когда он приедет.
        */
        audioPreference: preferred ? { lang: preferred } : undefined,
      });
      engine.current = hls;
      // Рисуем реплики сами: браузер кладёт их на нижний край кадра, ровно под пульт с
      // паузой и громкостью. Дорожка при этом остаётся живой — «спрятана» значит «разобрана,
      // но не нарисована», и активные реплики по-прежнему приходят.
      hls.subtitleDisplay = false;
      const readLevels = () => {
        if (!alive) return;
        setLevels(hls.levels as unknown as Level[]);
        setLevel(hls.autoLevelEnabled ? -1 : hls.currentLevel);
      };
      hls.on(Hls.Events.MANIFEST_PARSED, readLevels);
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        if (alive) setAutomatic(data.level);
      });
      /*
        Дорожки звука приезжают не один раз: у каждой ступени качества своя группа, и смена
        ступени переписывает список целиком. Поэтому выбранный язык назначается на каждое
        обновление — он принадлежит человеку, а не группе, из которой сейчас идёт звук.
      */
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        if (!alive) return;
        const tracks = hls.audioTracks;
        setVoices(audioChoices(tracks));
        const wanted = pickAudio(tracks, wantedVoice.current, source.language);
        const track = tracks[wanted];
        if (track && wanted !== hls.audioTrack) hls.setAudioOption({ lang: track.lang, name: track.name });
        setVoice(wanted);
      });
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_event, data) => {
        if (alive) setVoice(data.id);
      });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_event, data) => {
        if (alive) setTexts(captionChoices(data.subtitleTracks, source.captions));
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if ((data.response?.code === 403 || data.response?.code === 410) && renewals.current++ < 2) {
          void renewSource();
          return;
        }
        // Сеть и декодер лечатся на месте; всё остальное — честный отказ, а не вечный
        // чёрный кадр. Протухшую подпись чинит переоткрытие: адрес живёт пять часов.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else fail('Поток прервался. Попробуйте открыть видео заново');
      });
      hls.loadSource(source.url);
      hls.attachMedia(element);
    } else if (element.canPlayType('application/vnd.apple.mpegurl')) {
      element.src = source.url;
    } else {
      fail('Этот браузер не умеет играть потоковое видео');
    }
    return () => {
      alive = false;
      suppressUntil.current = Date.now() + SUPPRESS_MS;
      dashEngine.current?.destroy();
      dashEngine.current = null;
      engine.current?.destroy();
      engine.current = null;
      element.removeAttribute('src');
      element.load();
    };
    // Громкость меняется отдельным хуком: она не повод пересоздавать плеер.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => {
    if (video.current) video.current.volume = Math.max(0, Math.min(1, preferences.watchVolume / 100));
  }, [preferences.watchVolume]);

  // Список субтитров у каждого ролика свой, а выбор человека — один на все: он помнится
  // языком и заново прикладывается к тому, что этот ролик предлагает.
  useEffect(() => setText(pickCaption(texts, wantedText.current)), [texts]);

  /**
   * Показать выбранные субтитры — или ничьи.
   *
   * Дорожка из плейлиста включается плеером, отдельный файл — тегом `<track>` ниже. Обе
   * дороги ведут в один и тот же список дорожек элемента `<video>`, откуда реплики и
   * читаются; поэтому здесь важно ровно одно: чтобы включённой была одна.
   */
  useEffect(() => {
    const chosen = texts.find((item) => item.id === text);
    if (engine.current) engine.current.subtitleTrack = chosen && chosen.track >= 0 ? chosen.track : -1;
    if (!chosen) setLines([]);
  }, [text, texts]);

  /**
   * Реплики, которые звучат прямо сейчас.
   *
   * Спрятанная дорожка — это разобранная, но не нарисованная: браузер держит её реплики в
   * `activeCues` и предупреждает о смене, а рисуем мы сами. Так субтитры поднимаются над
   * пультом, а не прячутся под ним, и выглядят одинаково во всех браузерах.
   */
  useEffect(() => {
    const element = video.current;
    if (!element || !text) return;
    const list = element.textTracks;
    const update = () => {
      const shown: string[] = [];
      for (const track of Array.from(list)) {
        if (track.mode !== 'hidden') continue;
        for (const cue of Array.from(track.activeCues ?? [])) {
          const line = spoken(cue);
          if (line) shown.push(line);
        }
      }
      setLines(shown);
    };
    // Дорожки появляются и исчезают по ходу дела: файл субтитров подгружается тегом, а
    // дорожки плейлиста заводит плеер, когда доберётся до них.
    const listen = () => {
      for (const track of Array.from(list)) {
        track.removeEventListener('cuechange', update);
        track.addEventListener('cuechange', update);
      }
      update();
    };
    list.addEventListener('addtrack', listen);
    list.addEventListener('removetrack', listen);
    list.addEventListener('change', listen);
    listen();
    return () => {
      list.removeEventListener('addtrack', listen);
      list.removeEventListener('removetrack', listen);
      list.removeEventListener('change', listen);
      for (const track of Array.from(list)) track.removeEventListener('cuechange', update);
      setLines([]);
    };
  }, [text, source]);

  /** Пульт живёт, пока в плеере что-то происходит; потом уходит с кадра вместе с курсором. */
  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => clearTimeout(hideTimer.current);
  }, [wake]);

  // Раз в секунду: где мы, где комната, и что из этого следует.
  useEffect(() => {
    const timer = setInterval(() => {
      const element = video.current;
      const now = latest.current.watch;
      if (!element) return;
      const serverNow = meeting.serverNow();
      const ranges = element.buffered;
      setBuffered(ranges.length ? ranges.end(ranges.length - 1) * 1000 : 0);
      /*
        Полоса и отставание — только у произведения с началом и концом. У эфира ни общей
        позиции, ни конца нет; у него считается другое — насколько мы отстали от края.
      */
      if (!latest.current.live) {
        setPosition(element.currentTime * 1000);
        setDuration(Number.isFinite(element.duration) ? element.duration * 1000 : 0);
        setDrift(now.paused ? 0 : element.currentTime * 1000 - targetPosition(now, serverNow));
        setLag(0);
      } else {
        setDrift(0);
        const edge = engine.current?.liveSyncPosition;
        const known = edge !== undefined && edge !== null && Number.isFinite(edge);
        const behind = known ? edge - element.currentTime : 0;
        setLag(Math.max(0, behind));
        // Отстали настолько, что это уже не эфир: возвращаемся к краю сами, не спрашивая.
        if (known && behind > LIVE_LAG && element.readyState >= 2 && !element.paused) {
          suppress();
          element.currentTime = edge;
        }
      }
      if (Date.now() < suppressUntil.current || element.readyState < 2) return;
      const fix = correction({
        watch: now,
        live: latest.current.live,
        serverNow,
        localMs: element.currentTime * 1000,
        playing: !element.paused && !element.ended,
        rate: element.playbackRate,
      });
      if (fix.action === 'none') return;
      // Подтяжка скоростью — не команда плееру, а наклон: своё эхо от неё не рождается, и
      // глушить проверку на секунду из-за неё было бы ошибкой (за секунду она и не успеет).
      if (fix.action === 'rate') {
        element.playbackRate = fix.rate;
        return;
      }
      suppress();
      if (fix.action === 'play')
        void element.play().catch(() => setStatus((current) => (current === 'ready' ? 'blocked' : current)));
      if (fix.action === 'pause') {
        element.pause();
        element.playbackRate = 1;
        element.currentTime = fix.positionMs / 1000;
      }
      if (fix.action === 'seek') {
        element.playbackRate = 1;
        element.currentTime = fix.positionMs / 1000;
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [meeting]);

  /** Нажатие пультом: сначала комнате, а плеер догонит себя сам ближайшей проверкой. */
  const command = (type: 'watch.play' | 'watch.pause' | 'watch.seek', positionMs?: number) => {
    if (!canControl) return;
    wake();
    suppress();
    const element = video.current;
    const at =
      positionMs ??
      Math.round(element ? element.currentTime * 1000 : targetPosition(watch, meeting.serverNow()));
    if (element) element.playbackRate = 1;
    if (type === 'watch.seek' && element) element.currentTime = at / 1000;
    if (type === 'watch.play') void element?.play().catch(() => {});
    if (type === 'watch.pause') element?.pause();
    send(type, Math.max(0, at));
  };

  /** Отмотать всем на пятнадцать секунд назад или вперёд — не дальше начала и конца. */
  const skip = (delta: number) => {
    const element = video.current;
    const at = element ? element.currentTime * 1000 : targetPosition(watch, meeting.serverNow());
    command('watch.seek', skipTarget(at, delta, duration));
  };

  /**
   * Вернуться туда, где комната, — или к краю эфира.
   *
   * Своё действие, а не команда: комнату оно не двигает. Автоматика делает это сама, но
   * «сама» — это через секунду и незаметно, а кнопка нужна тогда, когда человек уже видит,
   * что отстал, и ждать не хочет.
   */
  const resync = () => {
    const element = video.current;
    if (!element) return;
    wake();
    suppress();
    element.playbackRate = 1;
    if (live) {
      const edge = engine.current?.liveSyncPosition;
      if (edge !== undefined && edge !== null && Number.isFinite(edge)) element.currentTime = edge;
      else engine.current?.startLoad(-1);
      setLag(0);
    } else {
      element.currentTime = targetPosition(latest.current.watch, meeting.serverNow()) / 1000;
      setDrift(0);
    }
    if (!element.paused) return;
    if (live || !latest.current.watch.paused) void element.play().catch(() => {});
  };

  const setVolume = (value: number) => {
    if (value > 0) loudness.current = value;
    meeting.media.saveSettings({ watchVolume: value });
  };

  const choices = useMemo(() => qualities(levels), [levels]);
  /** Выбранные субтитры — и файл, если их приносит не плейлист, а наш сервер. */
  const caption = texts.find((item) => item.id === text);
  const chooseText = (id: string) => {
    wantedText.current = id;
    setText(id);
    meeting.media.saveSettings({ watchSubtitles: id });
  };
  const chooseVoice = (choice: AudioChoice) => {
    const track = engine.current?.audioTracks[choice.index];
    // Помним язык, а не номер: у следующего ролика номера будут другие, а язык тот же.
    // Оригинал помнится пустой строкой — «как снял автор» у каждого ролика свой.
    const dashLanguage = dashEngine.current?.voice(choice.index);
    wantedVoice.current = choice.original ? '' : (dashLanguage ?? track?.lang ?? '');
    meeting.media.saveSettings({ watchAudio: wantedVoice.current });
    setVoice(choice.index);
    if (track) engine.current?.setAudioOption({ lang: track.lang, name: track.name });
  };
  const title = source?.title ?? watch.title ?? 'Совместный просмотр';
  const muted = preferences.watchVolume <= 0;
  const behind = !live && Math.abs(drift) > VISIBLE_DRIFT;
  // Когда пульт виден — правило в `watch-controls.ts`: по бездействию он уходит и на паузе.
  const showControls = controlsShown({
    idle,
    menuOpen: menu || captionMenu,
    ready: status === 'ready',
  });
  /** Большая кнопка посередине есть только у записи: эфир не останавливают и не мотают. */
  const showCenter = showControls && !live && status === 'ready';
  const chosen = level >= 0 ? levelLabel(levels[level]) : '';
  return (
    <section
      className="watch-theater"
      aria-label="Совместный просмотр"
      ref={screen}
      data-idle={showControls ? undefined : 'true'}
      data-full={targetFull ? 'true' : undefined}
      onPointerMove={wake}
      onPointerDown={wake}
      onFocusCapture={wake}
    >
      <div className="watch-screen">
        <video
          ref={video}
          className="watch-video"
          playsInline
          poster={source?.poster ?? undefined}
          onClick={() => {
            // Что значит нажатие по кадру — решает `watch-controls.ts`: пальцем и во весь
            // экран это «покажи пульт», мышью в окне — привычная пауза.
            const press = framePress({ coarse, fullscreen, live, canControl });
            if (press === 'wake') wake();
            if (press === 'toggle') command(watch.paused ? 'watch.play' : 'watch.pause');
          }}
          onPlay={() => {
            setPlaying(true);
            setWaiting(false);
            setStatus((current) => (current === 'blocked' ? 'ready' : current));
            if (Date.now() < suppressUntil.current || !latest.current.canControl) return;
            if (latest.current.watch.paused && !latest.current.live) command('watch.play');
          }}
          onPause={() => {
            setPlaying(false);
            if (Date.now() < suppressUntil.current || !latest.current.canControl) return;
            if (latest.current.live || video.current?.ended) return;
            if (!latest.current.watch.paused) command('watch.pause');
          }}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onLoadedMetadata={() => {
            setStatus('ready');
            const element = video.current;
            if (!element) return;
            setDuration(Number.isFinite(element.duration) ? element.duration * 1000 : 0);
            if (!latest.current.live) {
              suppress();
              element.currentTime = targetPosition(latest.current.watch, meeting.serverNow()) / 1000;
            }
            // Открывший включает, как только его плеер готов: состояние уже у всех, а
            // отставших подтянет обычная проверка расхождения.
            const now = latest.current.watch;
            if (
              !started.current &&
              now.paused &&
              now.positionMs === 0 &&
              now.openedBy === meeting.admission.participantId
            ) {
              started.current = true;
              setTimeout(() => command('watch.play', 0), 500);
            }
          }}
          onError={() => {
            if (status !== 'failed' && source?.kind === 'file') {
              setStatus('failed');
              setError('Поток не открылся. Попробуйте другое видео');
            }
          }}
        >
          {/*
            Субтитры, которых нет в плейлисте, приезжают отдельным файлом.

            `metadata` — чтобы браузер разобрал дорожку, но не рисовал её сам и чтобы плеер
            не принял её за свою: он держит список своих дорожек и гасит в нём чужие.
            Рисуем мы, из `activeCues`; «спрятана» здесь значит «работает молча».
          */}
          {caption?.url && (
            <track
              key={caption.id}
              kind="metadata"
              src={caption.url}
              label={caption.label}
              ref={(node) => {
                if (node?.track) node.track.mode = 'hidden';
              }}
            />
          )}
        </video>
        {!!lines.length && (
          <div className="watch-captions" aria-live="polite">
            {/* Ключ по месту, а не по тексту: у бегущей строки распознанной речи соседние
                реплики бывают дословно одинаковыми, и текст ключом быть не может. */}
            {lines.map((line, index) => (
              <span key={index}>{line}</span>
            ))}
          </div>
        )}
        {status === 'ready' && waiting && playing && (
          <div className="watch-buffering" role="status" aria-label="Загружаем">
            <LoaderCircle size={34} />
          </div>
        )}
        {status !== 'ready' && (
          <div className="watch-overlay" role="status">
            {status === 'loading' && (
              <span className="watch-loading">
                <LoaderCircle size={30} />
                Открываем…
              </span>
            )}
            {status === 'blocked' && (
              <button
                className="button primary"
                onClick={() => {
                  suppress();
                  void video.current?.play();
                  setStatus('ready');
                }}
              >
                <Play size={18} /> Смотреть вместе
              </button>
            )}
            {status === 'failed' && <span className="watch-error">{error}</span>}
          </div>
        )}
        {/*
          Управление лежит поверх кадра одним слоем: так полный экран разворачивает плеер
          вместе с пультом, а не кадр без него. Верхняя строка — что открыто и кто принёс,
          нижняя — лента времени и кнопки.
        */}
        <div className="watch-chrome" data-shown={showControls ? 'true' : undefined}>
          <div className="watch-head">
            <span className="watch-title">
              {live ? <Radio size={15} /> : <Tv size={15} />}
              <b>{title}</b>
              <small>
                {source?.notice ||
                  (live
                    ? `Эфир · ${source?.author || watch.contentId}`
                    : behind
                      ? 'Догоняем комнату…'
                      : owner
                        ? `Открыл${owner.id === self?.id ? 'и вы' : ` ${owner.name}`}`
                        : 'Смотрим вместе')}
              </small>
            </span>
            {/* На телефоне подпись прячется, а имя кнопки остаётся: без него это была бы
                кнопка без названия — и для голосового доступа, и для проверок. */}
            {onBrowse && (
              <button className="watch-browse" aria-label="Каталог" onClick={onBrowse}>
                <Clapperboard size={16} />
                <span>Каталог</span>
              </button>
            )}
            {canControl && (
              <IconButton label="Закрыть просмотр для всех" onClick={() => send('watch.close')}>
                <X size={19} />
              </IconButton>
            )}
          </div>
          {/*
            Середина кадра: отмотать, остановить, отмотать. Здесь её ждут пальцем — и здесь же
            она честно говорит, что пауза общая: комната останавливается вся сразу.
          */}
          <div className="watch-center" data-shown={showCenter ? 'true' : undefined}>
            {showCenter && (
              <>
                <IconButton
                  label="Назад на 15 секунд для всех"
                  className="watch-skip"
                  disabled={!canControl || !duration}
                  onClick={() => skip(-SKIP_MS)}
                >
                  <RotateCcw size={22} />
                  <span>15</span>
                </IconButton>
                <IconButton
                  label={watch.paused ? 'Включить для всех' : 'Пауза для всех'}
                  className="watch-center-play"
                  disabled={!canControl}
                  onClick={() => command(watch.paused ? 'watch.play' : 'watch.pause')}
                >
                  {watch.paused || !playing ? <Play size={30} /> : <Pause size={30} />}
                </IconButton>
                <IconButton
                  label="Вперёд на 15 секунд для всех"
                  className="watch-skip"
                  disabled={!canControl || !duration}
                  onClick={() => skip(SKIP_MS)}
                >
                  <RotateCw size={22} />
                  <span>15</span>
                </IconButton>
              </>
            )}
          </div>
          <div className="watch-foot">
            {!live && (
              <div className="watch-line">
                <span className="watch-time">{clock(position / 1000)}</span>
                <Slider
                  className="watch-progress"
                  min={0}
                  max={Math.max(1000, duration)}
                  step={1000}
                  value={Math.min(position, duration || position)}
                  disabled={!canControl || !duration}
                  aria-label="Положение в ролике"
                  style={
                    {
                      '--slider-b': Math.min(1, buffered / Math.max(1000, duration)),
                    } as CSSProperties
                  }
                  onChange={(event) => command('watch.seek', Number(event.target.value))}
                />
                <span className="watch-time">{clock(duration / 1000)}</span>
              </div>
            )}
            <div className="watch-tools">
              {/*
                У эфира на месте «играть» стоит «LIVE»: останавливать его нельзя, а вот
                вернуться к краю после затычки в сети — самое частое, чего от него хотят.
              */}
              {live ? (
                <button
                  className="watch-live"
                  data-edge={lag > LIVE_EDGE ? undefined : 'true'}
                  aria-label={
                    lag > LIVE_EDGE ? `Вернуться к эфиру, отстали на ${Math.round(lag)} с` : 'Идёт эфир'
                  }
                  onClick={resync}
                >
                  <span className="watch-live-dot" />
                  LIVE
                  {lag > LIVE_EDGE && <small>−{Math.round(lag)} с</small>}
                </button>
              ) : (
                <>
                  <IconButton
                    label={watch.paused ? 'Включить для всех' : 'Пауза для всех'}
                    className="watch-play"
                    disabled={!canControl}
                    onClick={() => command(watch.paused ? 'watch.play' : 'watch.pause')}
                  >
                    {watch.paused || !playing ? <Play size={21} /> : <Pause size={21} />}
                  </IconButton>
                  <IconButton
                    label="В начало для всех"
                    disabled={!canControl}
                    onClick={() => command('watch.seek', 0)}
                  >
                    <SkipBack size={18} />
                  </IconButton>
                </>
              )}
              {/*
                У эфира этой кнопки нет: «обновить» и «LIVE» делали одно и то же действие
                (`resync`) и стояли рядом — вторая ручка от того же самого. У записи она
                остаётся, и смысл у неё другой: встать туда, где комната.
              */}
              {!live && (
                <IconButton
                  label="Встать на секунду комнаты"
                  className={behind ? 'watch-behind' : ''}
                  onClick={resync}
                >
                  <RefreshCw size={17} />
                </IconButton>
              )}
              <div className="watch-volume">
                <IconButton
                  label={muted ? 'Включить звук просмотра' : 'Выключить звук просмотра'}
                  onClick={() => setVolume(muted ? loudness.current : 0)}
                >
                  {muted ? (
                    <VolumeX size={18} />
                  ) : preferences.watchVolume < 50 ? (
                    <Volume1 size={18} />
                  ) : (
                    <Volume2 size={18} />
                  )}
                </IconButton>
                <Slider
                  min={0}
                  max={100}
                  step={1}
                  value={preferences.watchVolume}
                  aria-label="Громкость просмотра"
                  onChange={(event) => setVolume(Number(event.target.value))}
                />
              </div>
              <span className="watch-gap" />
              {/*
                Субтитры — отдельной кнопкой, а не строкой в шестерёнке: их включают и
                выключают посреди просмотра, и у площадки они стоят ровно здесь же.
              */}
              {texts.length > 0 && (
                <Menu.Root open={captionMenu} onOpenChange={setCaptionMenu}>
                  <Menu.Trigger
                    render={
                      <IconButton
                        label={caption ? `Субтитры: ${caption.label}` : 'Субтитры'}
                        className={caption ? 'watch-on' : ''}
                      >
                        <Captions size={19} />
                      </IconButton>
                    }
                  />
                  <Menu.Portal container={screen}>
                    <Menu.Positioner className="menu-layer" side="top" sideOffset={10} align="end">
                      <Menu.Popup className="action-menu watch-quality-menu">
                        <Menu.Item data-selected={text ? undefined : 'true'} onClick={() => chooseText('')}>
                          Выключены
                        </Menu.Item>
                        {texts.map((item) => (
                          <Menu.Item
                            key={item.id}
                            data-selected={text === item.id ? 'true' : undefined}
                            onClick={() => chooseText(item.id)}
                          >
                            {item.label}
                            {item.auto && <small>распознано</small>}
                          </Menu.Item>
                        ))}
                      </Menu.Popup>
                    </Menu.Positioner>
                  </Menu.Portal>
                </Menu.Root>
              )}
              {(choices.length > 1 || voices.length > 1) && (
                <Menu.Root
                  open={menu}
                  onOpenChange={(open) => {
                    setMenu(open);
                    // Закрылось — значит, в следующий раз открывается с разделов, а не там,
                    // где его бросили: список языков без заголовка читается как весь список.
                    if (!open) setMenuPage('root');
                  }}
                >
                  <Menu.Trigger
                    render={
                      <button className="watch-quality" aria-label="Качество картинки и язык звука">
                        <Settings2 size={17} />
                        <span>{chosen || 'Авто'}</span>
                      </button>
                    }
                  />
                  <Menu.Portal container={screen}>
                    <Menu.Positioner className="menu-layer" side="top" sideOffset={10} align="end">
                      <Menu.Popup className="action-menu watch-quality-menu">
                        {/*
                          Два раздела, а не один список.

                          Раньше озвучки и качества лежали друг под другом, разделённые только
                          подписями: у ролика с двумя десятками переозвучек это полтора экрана
                          прокрутки, в конце которых — «Автоматически». Теперь сначала вопрос
                          («что менять»), потом ответы; каждый раздел показывает выбранное
                          прямо в строке, так что заходить ради проверки не нужно.
                        */}
                        {menuPage === 'root' && (
                          <>
                            {voices.length > 1 && (
                              <Menu.Item closeOnClick={false} onClick={() => setMenuPage('voice')}>
                                Язык озвучки
                                <small>{voices.find((item) => item.index === voice)?.label ?? 'Авто'}</small>
                              </Menu.Item>
                            )}
                            {choices.length > 1 && (
                              <Menu.Item closeOnClick={false} onClick={() => setMenuPage('quality')}>
                                Качество
                                <small>
                                  {level < 0
                                    ? `Авто${automatic >= 0 ? ` · ${levelLabel(levels[automatic])}` : ''}`
                                    : chosen}
                                </small>
                              </Menu.Item>
                            )}
                          </>
                        )}
                        {menuPage !== 'root' && (
                          <button
                            type="button"
                            className="watch-menu-back"
                            onClick={() => setMenuPage('root')}
                          >
                            <ArrowLeft size={15} />
                            {menuPage === 'voice' ? 'Язык озвучки' : 'Качество'}
                          </button>
                        )}
                        {menuPage === 'voice' &&
                          voices.map((item) => (
                            <Menu.Item
                              key={item.index}
                              data-selected={voice === item.index ? 'true' : undefined}
                              onClick={() => chooseVoice(item)}
                            >
                              {item.label}
                              {item.original && <small>оригинал</small>}
                            </Menu.Item>
                          ))}
                        {menuPage === 'quality' && (
                          <>
                            <Menu.Item
                              data-selected={level < 0 ? 'true' : undefined}
                              onClick={() => {
                                setLevel(-1);
                                if (engine.current) engine.current.currentLevel = -1;
                                dashEngine.current?.quality(-1);
                              }}
                            >
                              Автоматически
                              {level < 0 && automatic >= 0 && <small>{levelLabel(levels[automatic])}</small>}
                            </Menu.Item>
                            {choices.map((choice) => (
                              <Menu.Item
                                key={choice.label}
                                data-selected={level === choice.level ? 'true' : undefined}
                                onClick={() => {
                                  setLevel(choice.level);
                                  if (engine.current) engine.current.currentLevel = choice.level;
                                  dashEngine.current?.quality(choice.level);
                                }}
                              >
                                {choice.label}
                              </Menu.Item>
                            ))}
                          </>
                        )}
                      </Menu.Popup>
                    </Menu.Positioner>
                  </Menu.Portal>
                </Menu.Root>
              )}
              <IconButton
                label={fullscreen ? 'Выйти из полноэкранного режима' : 'Развернуть плеер'}
                onClick={toggleFullscreen}
              >
                {fullscreen ? <Minimize2 size={19} /> : <Maximize2 size={19} />}
              </IconButton>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/*
  Ленивая загрузка: hls.js весит больше всего остального интерфейса вместе взятого, а нужен
  только тем, у кого во встрече открыт кинозал. Грузить его каждому, кто просто зашёл
  поговорить, — это лишние сотни килобайт на первом экране.
*/
export default WatchTheater;
