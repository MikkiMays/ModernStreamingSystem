import Hls from 'hls.js';
import type { Level } from '../watch-levels';
import { audioChoices, type AudioChoice, type MediaTrack } from '../watch-tracks';
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
    /** Подпись протухла (403/410): `true` — адрес обновляется, лечить на месте не нужно. */
    expired: () => boolean;
    fail: (message: string) => void;
  },
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
    audioPreference: language ? { lang: language } : undefined,
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
  hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_event, data) => {
    if (callbacks.alive()) callbacks.texts(data.subtitleTracks);
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    if ((data.response?.code === 403 || data.response?.code === 410) && callbacks.expired()) return;
    // Сеть и декодер лечатся на месте; всё остальное — честный отказ, а не вечный
    // чёрный кадр. Протухшую подпись чинит переоткрытие: адрес живёт пять часов.
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    else callbacks.fail('Поток прервался. Попробуйте открыть видео заново');
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
    destroy() {
      hls.destroy();
    },
  };
}
