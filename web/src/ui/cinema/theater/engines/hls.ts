import Hls from 'hls.js';
import { t } from '../../../../i18n';
import { adBreaks, type AdBreak, type AdFragment } from '../ad-breaks';
import type { Level } from '../watch-levels';
import { audioChoices, type AudioChoice, type MediaTrack } from '../watch-tracks';
import { AHEAD_MIN, aheadFor, BEHIND } from './buffer';
import type { Playback } from './playback';

/** Умеет ли браузер играть HLS через `hls.js` (то есть есть ли у него MSE). */
export function hlsSupported(): boolean {
  return Hls.isSupported();
}

/**
 * HLS через `hls.js` — тем же видом, что и `attachDash`: движок сообщает о ступенях и дорожках
 * обратными вызовами, а наружу отдаёт {@link Playback}.
 *
 * `language` — язык звука, который нужен до первого байта: выбор человека или язык ролика.
 */
export function attachHls(
  video: HTMLVideoElement,
  url: string,
  language: string,
  callbacks: {
    alive: () => boolean;
    /** Ступени пришли: весь список и какая выбрана руками (`-1` — автоматически). */
    levels: (levels: Level[], chosen: number) => void;
    /** Автоматика перешла на другую ступень. */
    automatic: (level: number) => void;
    voices: (voices: AudioChoice[]) => void;
    /** Какую из пришедших дорожек звука включить. */
    wanted: (tracks: MediaTrack[]) => number;
    voice: (current: number) => void;
    /** Субтитры, которые лежат в самом плейлисте. */
    texts: (tracks: MediaTrack[]) => void;
    /** Рекламные отрезки, которые пометил сам поток (`ad-breaks.ts`), — у записи, не у эфира. */
    breaks?: (breaks: AdBreak[]) => void;
    /**
     * То же у эфира (R150): пропустить там нечего — у эфира нет общей позиции, — но площадка (Twitch)
     * вставляет рекламу в сам поток, и плеер честно говорит, сколько её ждать.
     */
    liveBreaks?: (breaks: AdBreak[]) => void;
    /** Подпись протухла (403/410): `true` — адрес обновляется, лечить на месте не нужно. */
    expired: () => boolean;
    /**
     * Лечение на месте не помогло — открыть поток заново (новый разбор, новые адреса, новый движок).
     * `false` — попытки кончились, и тогда честный отказ.
     */
    reopen?: () => boolean;
    fail: (message: string) => void;
  },
  options: {
    /**
     * Кодек картинки, который брать с первого куска (`device.preferredVideoCodec`): `'avc1'` — H.264, если
     * VP9 этому устройству не по силам. Пусто — выбирает hls.js.
     */
    videoCodec?: 'avc1';
  } = {},
): Playback {
  /*
    hls.js идёт первым, и это не вкусовщина.

    Chromium на вопрос «умеешь ли ты HLS» отвечает `maybe` — и что-то действительно
    играет, но без списка уровней: выбора качества нет, а адаптация сама уходит в
    максимум, то есть в 1440p через наш канал на каждого зрителя. Родной путь остаётся
    запасным для Safari, который HLS умеет по-настоящему.
  */
  const hls = new Hls({
    enableWorker: true,
    /*
      Позади — полминуты (R172, `buffer.ts`): короткая отмотка не качает то же самое заново, а
      остальное плеер отдаёт обратно. Было 120 с — до семидесяти мегабайт памяти за спиной зрителя.
    */
    backBufferLength: BEHIND,
    /*
      Вперёд — 20–30 с по запасу канала (R172, `buffer.ts`), и не больше: обе границы hls.js меняются
      на лету (ниже, `FRAG_BUFFERED`). Без них плеер тянул бы вперёд до `maxMaxBufferLength` — по
      умолчанию 600 с, а с `maxBufferSize` в 60 МБ на ступени в 2 Мбит/с — четыре минуты.

      «Вежливый» кинозал (R151). Фильм идёт во время звонка, и на Wi-Fi ноутбука первый набор буфера
      полной скоростью забивал канал: SFU ставил камеры этого человека на паузу, сигнал опаздывал, у
      всех — «Восстанавливаем связь». Поэтому начало — 20 с, а оценка канала — с запасом
      (`abrBandWidthFactor`, `abrBandWidthUpFactor`): уровень выше выбирается, только если его с лихвой
      хватает и на звонок рядом.
    */
    maxBufferLength: AHEAD_MIN,
    maxMaxBufferLength: AHEAD_MIN,
    abrBandWidthFactor: 0.8,
    abrBandWidthUpFactor: 0.6,
    // Замирание хоста на 20–35 с (MEDIA-DIAGNOSIS §6) — сегменты не отвечают; восемь попыток с
    // ростом паузы до четырёх секунд переживают его без MEDIA_ERROR и чёрного кадра.
    fragLoadingMaxRetry: 8,
    fragLoadingRetryDelay: 500,
    fragLoadingMaxRetryTimeout: 4000,
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
    audioPreference: language ? { lang: language } : undefined,
    /*
      Вставки-интерстишелы (`EXT-X-DATERANGE` с `CLASS="com.apple.hls.interstitial"`) — это рекламный
      ролик поверх основного потока, и hls.js 1.6 по умолчанию играет его сам. Рекламу, которую
      помечает поток, кинозал не показывает (T17): вставка просто не играется, основной поток идёт
      дальше. Её адрес к тому же чужой и мимо нашего прокси — CSP его всё равно не пустил бы.
    */
    enableInterstitialPlayback: false,
    /*
      Первый кусок — пока `<video>` ещё только подключается к источнику: сотни миллисекунд до первого кадра.
    */
    startFragPrefetch: true,
    /*
      H.264, если VP9 не по силам (R216, `device.ts`): ступени одного кодека hls.js держит весь просмотр, и
      выбрать его нужно до первого куска.
    */
    ...(options.videoCodec ? { videoPreference: { videoCodec: options.videoCodec } } : {}),
  });
  // Рисуем реплики сами: браузер кладёт их на нижний край кадра, ровно под пульт с
  // паузой и громкостью. Дорожка при этом остаётся живой — «спрятана» значит «разобрана,
  // но не нарисована», и активные реплики по-прежнему приходят.
  hls.subtitleDisplay = false;
  const readLevels = () => {
    if (!callbacks.alive()) return;
    callbacks.levels(hls.levels as unknown as Level[], hls.autoLevelEnabled ? -1 : hls.currentLevel);
  };
  hls.on(Hls.Events.MANIFEST_PARSED, readLevels);
  /*
    Цель буфера вперёд — по каждому загруженному кусочку: оценка полосы против битрейта той ступени,
    что сейчас играет (`aheadFor`). hls.js читает обе границы из своей настройки на каждом шаге загрузки,
    поэтому новая цель действует со следующего кусочка, без перезапуска.
  */
  hls.on(Hls.Events.FRAG_BUFFERED, () => {
    const level = hls.levels[hls.currentLevel] ?? hls.levels[hls.nextLoadLevel];
    const ahead = aheadFor(hls.bandwidthEstimate, level?.bitrate);
    hls.config.maxBufferLength = ahead;
    hls.config.maxMaxBufferLength = ahead;
  });
  hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
    if (callbacks.alive()) callbacks.automatic(data.level);
  });
  /*
    Дорожки звука приезжают не один раз: у каждой ступени качества своя группа, и смена
    ступени переписывает список целиком. Поэтому выбранный язык назначается на каждое
    обновление — он принадлежит человеку, а не группе, из которой сейчас идёт звук.
  */
  hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
    if (!callbacks.alive()) return;
    const tracks = hls.audioTracks;
    callbacks.voices(audioChoices(tracks));
    const wanted = callbacks.wanted(tracks);
    const track = tracks[wanted];
    if (track && wanted !== hls.audioTrack) hls.setAudioOption({ lang: track.lang, name: track.name });
    callbacks.voice(wanted);
  });
  hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_event, data) => {
    if (callbacks.alive()) callbacks.voice(data.id);
  });
  // Рекламу, которую помечает сам поток, ищем в каждом пришедшем списке записи: у эфира общей
  // позиции нет, и пропустить вставку всей комнатой там некуда.
  hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
    if (!callbacks.alive()) return;
    const found = adBreaks(data.details.fragments as unknown as AdFragment[]);
    if (data.details.live) callbacks.liveBreaks?.(found);
    else callbacks.breaks?.(found);
  });
  hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_event, data) => {
    if (callbacks.alive()) callbacks.texts(data.subtitleTracks);
  });
  /*
    Что знает движок о своей загрузке — для лестницы лечения (`stall.ts`): когда пришёл последний кусок и
    идёт ли загрузка следующего.
  */
  let fedAt: number | null = null;
  let loadingAt: number | null = null;
  /** Ступень ниже, поставленная лечением: потолок автоматики и когда его поставили. */
  let cappedAt: number | null = null;
  hls.on(Hls.Events.FRAG_LOADING, () => {
    loadingAt = performance.now();
  });
  hls.on(Hls.Events.FRAG_LOADED, () => {
    fedAt = performance.now();
    // Потолок лечения — на минуту ровной загрузки: канал ожил — автоматика снова решает сама.
    if (cappedAt !== null && fedAt - cappedAt > CAP_MS) {
      cappedAt = null;
      hls.autoLevelCapping = -1;
    }
  });
  /*
    Фатальные ошибки — лечением с паузами и счётом, а не по кругу (R216). Раньше сеть и декодер «лечились»
    без конца: `startLoad` и `recoverMediaError` на каждую ошибку, и плеер, у которого не выходило,
    крутил кружок вечно. Теперь: сеть — три попытки за минуту с паузой 1, 2, 4 с; декодер — пересборка, потом
    пересборка с другим кодеком звука (так советует сам hls.js); дальше — открыть поток заново
    (`reopen`), а если и это кончилось — честный отказ. Протухшую подпись чинит переоткрытие сразу.
  */
  const failures: { network: number[]; media: number[] } = { network: [], media: [] };
  let waiting: ReturnType<typeof setTimeout> | undefined;
  let gone = false;
  const recent = (list: number[], windowMs: number) => {
    const now = performance.now();
    while (list.length && now - list[0]! > windowMs) list.shift();
    list.push(now);
    return list.length;
  };
  const giveUp = () => {
    if (!callbacks.reopen?.()) callbacks.fail(t(($) => $.cinema.theater.errors.streamBroken));
  };
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal || gone) return;
    if ((data.response?.code === 403 || data.response?.code === 410) && callbacks.expired()) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      const count = recent(failures.network, NETWORK_WINDOW_MS);
      if (count > NETWORK_DELAYS_MS.length) return giveUp();
      clearTimeout(waiting);
      waiting = setTimeout(
        () => {
          if (!gone) hls.startLoad();
        },
        NETWORK_DELAYS_MS[count - 1],
      );
    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      const count = recent(failures.media, MEDIA_WINDOW_MS);
      if (count > 2) return giveUp();
      if (count === 2) hls.swapAudioCodec();
      hls.recoverMediaError();
    } else giveUp();
  });
  hls.loadSource(url);
  hls.attachMedia(video);
  return {
    get levels() {
      return hls.levels as unknown as Level[];
    },
    quality(index) {
      hls.currentLevel = index;
    },
    voice(index) {
      const track = hls.audioTracks[index];
      if (track) hls.setAudioOption({ lang: track.lang, name: track.name });
      return track?.lang ?? '';
    },
    subtitles(track) {
      hls.subtitleTrack = track;
    },
    reload() {
      hls.startLoad(-1);
    },
    get liveSyncPosition() {
      return hls.liveSyncPosition;
    },
    get playingDate() {
      return hls.playingDate;
    },
    health() {
      const now = performance.now();
      return {
        loading: loadingAt !== null && (fedAt === null || loadingAt > fedAt),
        fedAgoMs: fedAt === null ? null : now - fedAt,
        auto: hls.autoLevelEnabled,
      };
    },
    heal(step) {
      if (step === 'kick') {
        // Загрузка, которая не идёт, — заново с того места, где стоит картинка.
        hls.stopLoad();
        hls.startLoad(video.currentTime);
        return true;
      }
      if (step === 'rebuild') {
        // Новый источник медиа и новые буферы под ту же позицию: так оживает вставший декодер.
        hls.recoverMediaError();
        return true;
      }
      if (step === 'lower') {
        const playing = hls.currentLevel >= 0 ? hls.currentLevel : hls.nextLoadLevel;
        const lower = lowerLevel(hls.levels as unknown as Level[], playing);
        if (lower < 0 || !hls.autoLevelEnabled) return false;
        cappedAt = performance.now();
        hls.autoLevelCapping = lower;
        hls.nextLoadLevel = lower;
        return true;
      }
      return false;
    },
    destroy() {
      gone = true;
      clearTimeout(waiting);
      hls.destroy();
    },
  };
}

/** Паузы перед повторной загрузкой после фатальной ошибки сети, мс; больше попыток за минуту нет. */
const NETWORK_DELAYS_MS = [1000, 2000, 4000];
const NETWORK_WINDOW_MS = 60_000;
/** Две пересборки декодера за 30 с — дальше уже не декодер, а поток. */
const MEDIA_WINDOW_MS = 30_000;
/** Ступень ниже, поставленная лечением, держится, пока загрузка не пройдёт ровно столько, мс. */
const CAP_MS = 60_000;

/**
 * Ступень ниже по битрейту того же кодека, что играет (`current`), — номер в `levels`; `-1` — ниже нет.
 * Кодек тот же: hls.js не переходит между кодеками посреди просмотра, и ступень другого он не возьмёт.
 */
export function lowerLevel(levels: Level[], current: number): number {
  const now = levels[current];
  if (!now) return -1;
  const family = (level: Level) => (level.videoCodec ?? '').slice(0, 4);
  let best = -1;
  const rate = (level: Level) => level.bitrate ?? 0;
  levels.forEach((level, index) => {
    if (family(level) !== family(now) || !(rate(level) < rate(now))) return;
    if (best < 0 || rate(level) > rate(levels[best]!)) best = index;
  });
  return best;
}
