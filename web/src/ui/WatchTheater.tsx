import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Maximize2, Minimize2, Pause, Play, Radio, SkipBack, Tv, Volume2, X } from 'lucide-react';
import type { Watch } from '../api/types';
import type { Meeting } from '../core/meeting';
import { CinemaApi, clock, type CinemaSource } from '../core/cinema';
import { correction, DRIFT_LIMIT, targetPosition } from '../core/watch';
import { savePreferences } from '../core/preferences';
import { IconButton, Slider, useStore } from './primitives';

/**
 * Кинозал: то, что комната смотрит вместе, своим плеером.
 *
 * ПОЧЕМУ СВОИМ. Раньше здесь стояла рамка YouTube. С машины сервера она работала, у человека —
 * нет: из его сети площадки недоступны, а рамка ходит из браузера, и поделать с этим нельзя
 * ничего. Теперь поток берёт сервер и отдаёт его со своего адреса (`core/cinema.ts`), а здесь
 * обычный `<video>` с hls.js. Побочные выгоды оказались крупнее самой починки: настоящий выбор
 * качества (уровни HLS, а не «шестерёнка внутри чужой рамки»), свои элементы управления, ни
 * одного чужого скрипта на странице и строгий CSP обратно.
 *
 * ДВА ПРАВИЛА СИНХРОННОСТИ. Истина — у комнаты: раз в секунду сравниваем `currentTime` с общим
 * якорем (`core/watch.ts`) и правим расхождение больше полутора секунд. И пульт один: играет,
 * останавливает и перематывает тот, кто принёс видео (и ведущий). Остальные могут поставить
 * своё вместо этого или закрыть — если комната разрешила интеграции; нажатия у них не отбирают
 * управление, а значит, десять человек не перетягивают паузу друг у друга.
 *
 * Своё эхо отличается окном тишины после каждой своей же команды плееру: без него пауза,
 * поставленная по приказу комнаты, улетала бы в комнату как новое нажатие.
 */
const SUPPRESS_MS = 1200;

export function WatchTheater({ meeting, watch }: { meeting: Meeting; watch: Watch }) {
  const snapshot = useStore(meeting.snapshot);
  const preferences = useStore(meeting.media.preferences);
  const api = useMemo(() => new CinemaApi(meeting.admission), [meeting]);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const canControl = !!self && (self.owner || self.id === watch.openedBy);
  const owner = snapshot.participants.find((p) => p.id === watch.openedBy);
  const [source, setSource] = useState<CinemaSource | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'blocked' | 'failed'>('loading');
  const [error, setError] = useState('');
  const [levels, setLevels] = useState<{ id: number; label: string }[]>([]);
  const [level, setLevel] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [behind, setBehind] = useState(false);
  /** Чтобы тик не дёргал состояние зря: он живёт дольше рендера и значения не видит. */
  const behindRef = useRef(false);
  behindRef.current = behind;
  const [fullscreen, setFullscreen] = useState(false);
  const screen = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const engine = useRef<Hls | null>(null);
  const suppressUntil = useRef(0);
  const sending = useRef(false);
  const started = useRef(false);
  const latest = useRef({ watch, canControl });
  latest.current = { watch, canControl };

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
    setStatus('loading');
    setError('');
    setSource(null);
    setLevels([]);
    setLevel(-1);
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
    };
  }, [api, content]);

  // Плеер живёт, пока не сменился источник: пересоздавать его на каждое изменение комнаты —
  // это чёрный кадр у всех на каждую чужую паузу.
  useEffect(() => {
    const element = video.current;
    if (!source || !element) return;
    let alive = true;
    suppress();
    element.volume = Math.max(0, Math.min(1, preferences.watchVolume / 100));
    const fail = (message: string) => {
      if (!alive) return;
      setStatus('failed');
      setError(message);
    };
    if (source.kind === 'file') {
      element.src = source.url;
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
        // Качество по размеру окна, а не по жадности. Поток идёт через наш сервер, и
        // 1440p в плитку шириной в тысячу пикселей — это втрое больше трафика без единого
        // лишнего пикселя на экране. Руками уровень по-прежнему выбирается любой.
        capLevelToPlayerSize: true,
      });
      engine.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!alive) return;
        setLevels(
          hls.levels.map((item, index) => ({
            id: index,
            label: item.height
              ? `${item.height}p${item.attrs?.['FRAME-RATE'] && Number(item.attrs['FRAME-RATE']) > 35 ? '60' : ''}`
              : `${Math.round((item.bitrate || 0) / 1000)} кбит/с`,
          })),
        );
        setLevel(hls.autoLevelEnabled ? -1 : hls.currentLevel);
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
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

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === screen.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);

  // Раз в секунду: где мы, где комната, и что из этого следует.
  useEffect(() => {
    const timer = setInterval(() => {
      const element = video.current;
      const now = latest.current.watch;
      if (!element) return;
      const serverNow = meeting.serverNow();
      /*
        Полоса и отставание — только у ролика: у эфира нет ни общей позиции, ни конца. Но
        поправку ниже считаем и для него — ровно ради одной команды `play`. Раньше эфир
        отсеивался здесь, до неё, и выглядело это так: сегменты идут, окно растёт, картинка
        стоит. Ни ошибки, ни подсказки — просто чёрный кадр с живым трафиком.
      */
      if (now.kind === 'video') {
        setPosition(element.currentTime * 1000);
        setDuration(Number.isFinite(element.duration) ? element.duration * 1000 : 0);
        const target = targetPosition(now, serverNow);
        setBehind(!now.paused && Math.abs(element.currentTime * 1000 - target) > DRIFT_LIMIT);
      } else if (behindRef.current) setBehind(false);
      if (Date.now() < suppressUntil.current || element.readyState < 2) return;
      const fix = correction({
        watch: now,
        serverNow,
        localMs: element.currentTime * 1000,
        playing: !element.paused && !element.ended,
      });
      if (fix.action === 'none') return;
      suppress();
      if (fix.action === 'play')
        void element.play().catch(() => setStatus((current) => (current === 'ready' ? 'blocked' : current)));
      if (fix.action === 'pause') {
        element.pause();
        element.currentTime = fix.positionMs / 1000;
      }
      if (fix.action === 'seek') element.currentTime = fix.positionMs / 1000;
    }, 1000);
    return () => clearInterval(timer);
  }, [meeting]);

  /** Нажатие пультом: сначала комнате, а плеер догонит себя сам ближайшей проверкой. */
  const command = (type: 'watch.play' | 'watch.pause' | 'watch.seek', positionMs?: number) => {
    if (!canControl) return;
    suppress();
    const element = video.current;
    const at =
      positionMs ??
      Math.round(element ? element.currentTime * 1000 : targetPosition(watch, meeting.serverNow()));
    if (type === 'watch.seek' && element) element.currentTime = at / 1000;
    if (type === 'watch.play') void element?.play().catch(() => {});
    if (type === 'watch.pause') element?.pause();
    send(type, Math.max(0, at));
  };

  const live = watch.kind === 'channel' || !!source?.live;
  const title = source?.title ?? watch.title ?? 'Совместный просмотр';
  return (
    <section className="watch-theater" aria-label="Совместный просмотр">
      <div className="watch-screen" ref={screen}>
        <video
          ref={video}
          className="watch-video"
          playsInline
          poster={source?.poster ?? undefined}
          onPlay={() => {
            setPlaying(true);
            setStatus((current) => (current === 'blocked' ? 'ready' : current));
            if (Date.now() < suppressUntil.current || !latest.current.canControl) return;
            if (latest.current.watch.paused) command('watch.play');
          }}
          onPause={() => {
            setPlaying(false);
            if (Date.now() < suppressUntil.current || !latest.current.canControl) return;
            if (!latest.current.watch.paused && !video.current?.ended) command('watch.pause');
          }}
          onLoadedMetadata={() => {
            setStatus('ready');
            const element = video.current;
            if (!element) return;
            setDuration(Number.isFinite(element.duration) ? element.duration * 1000 : 0);
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
        />
        {status !== 'ready' && (
          <div className="watch-overlay" role="status">
            {status === 'loading' && <span>Открываем…</span>}
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
      </div>
      <div className="watch-controls">
        <span className="watch-title">
          {live ? <Radio size={16} /> : <Tv size={16} />}
          <b>{title}</b>
          <small>
            {live
              ? `Эфир · ${source?.author || watch.contentId}`
              : behind
                ? 'Догоняем комнату…'
                : canControl
                  ? 'Вы управляете просмотром'
                  : `Управляет ${owner?.name ?? 'тот, кто открыл'}`}
          </small>
        </span>
        {/*
          Два ряда заданы намеренно, а не получились переносом: сверху — что открыто и кто
          этим распоряжается, снизу — лента времени. В одну строку это лезло только на широком
          мониторе, а с открытой панелью кнопки сваливались вниз по одной и выглядели поломкой.
        */}
        <div className="watch-tools">
          {levels.length > 1 && (
            <label className="watch-quality">
              Качество
              <select
                value={level}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setLevel(next);
                  if (engine.current) engine.current.currentLevel = next;
                }}
              >
                <option value={-1}>Автоматически</option>
                {levels
                  .slice()
                  .reverse()
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label className="watch-volume">
            <Volume2 size={16} aria-label="Громкость просмотра" />
            <Slider
              min={0}
              max={100}
              step={1}
              value={preferences.watchVolume}
              aria-label="Громкость просмотра"
              onChange={(event) => savePreferences({ watchVolume: Number(event.target.value) })}
            />
          </label>
          <IconButton
            label={fullscreen ? 'Выйти из полноэкранного режима' : 'Развернуть плеер'}
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else void screen.current?.requestFullscreen().catch(() => {});
            }}
          >
            {fullscreen ? <Minimize2 size={19} /> : <Maximize2 size={19} />}
          </IconButton>
          {(canControl || snapshot.integrationsAllowed !== false) && (
            <IconButton label="Закрыть просмотр для всех" onClick={() => send('watch.close')}>
              <X size={19} />
            </IconButton>
          )}
        </div>
        {!live && (
          <div className="watch-transport">
            <IconButton
              label={watch.paused ? 'Включить для всех' : 'Пауза для всех'}
              disabled={!canControl}
              onClick={() => command(watch.paused ? 'watch.play' : 'watch.pause')}
            >
              {watch.paused || !playing ? <Play size={20} /> : <Pause size={20} />}
            </IconButton>
            <IconButton
              label="В начало для всех"
              disabled={!canControl}
              onClick={() => command('watch.seek', 0)}
            >
              <SkipBack size={19} />
            </IconButton>
            <span className="watch-time">{clock(position / 1000)}</span>
            <Slider
              className="watch-progress"
              min={0}
              max={Math.max(1000, duration)}
              step={1000}
              value={Math.min(position, duration || position)}
              disabled={!canControl || !duration}
              aria-label="Положение в ролике"
              onChange={(event) => command('watch.seek', Number(event.target.value))}
            />
            <span className="watch-time">{clock(duration / 1000)}</span>
          </div>
        )}
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
