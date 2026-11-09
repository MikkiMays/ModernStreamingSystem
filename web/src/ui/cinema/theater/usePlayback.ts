import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Watch } from '../../../api/types';
import type { CinemaApi } from '../../../core/cinema';
import type { Meeting } from '../../../core/meeting';
import type { Preferences } from '../../../core/preferences';
import { noteFailure } from '../../../core/failure';
import { t } from '../../../i18n';
import { useStore } from '../../primitives';
import type { AdBreak } from './ad-breaks';
import { DecodeWatch, demote, demotedFamilies, type VideoFamily } from './decode';
import { videoCodecs, type MediaProfile } from './device';
import { attachDash } from './engines/dash';
import { attachFile } from './engines/file';
import { attachHls, hlsSupported } from './engines/hls';
import type { Playback } from './engines/playback';
import { aheadOf, type Playhead } from './playhead';
import { DATA, nextHeal, offline, type Heal } from './stall';
import type { Echo } from './useRoomSync';
import { contentOf, useSource } from './useSource';
import type { Level } from './watch-levels';
import { captionChoices, pickAudio, type AudioChoice, type CaptionChoice } from './watch-tracks';

/**
 * Движок на `<video>`: какой, с каким адресом и что он о себе рассказал.
 *
 * Адрес — {@link useSource}; движок выбирается по его виду и живёт, пока адрес тот же. От движка
 * сюда приходят ступени качества, озвучки и субтитры из плейлиста, а обратно уходит выбор
 * человека: ступень и язык.
 */
export function usePlayback({
  meeting,
  api,
  watch,
  video,
  echo,
  preferences,
  playhead,
  profile,
}: {
  meeting: Meeting;
  api: CinemaApi;
  watch: Watch;
  video: RefObject<HTMLVideoElement | null>;
  echo: Echo;
  preferences: Preferences;
  /** Сторож позиции (`playhead.ts`): по нему лечится застрявший плеер. Нет — лечения нет. */
  playhead?: Playhead;
  /** Что умеет устройство (`device.ts`): кодек картинки. */
  profile?: MediaProfile;
}) {
  const [levels, setLevels] = useState<Level[]>([]);
  const [level, setLevel] = useState(-1);
  const [automatic, setAutomatic] = useState(-1);
  const [voices, setVoices] = useState<AudioChoice[]>([]);
  const [voice, setVoice] = useState(-1);
  const [texts, setTexts] = useState<CaptionChoice[]>([]);
  /** Рекламные отрезки, которые пометил поток (T17): по ним плеер пропускает рекламу всей комнатой. */
  const [breaks, setBreaks] = useState<AdBreak[]>([]);
  /** Реклама, которую площадка вставила в эфир (R150): только чтобы сказать, сколько её ждать. */
  const [liveBreaks, setLiveBreaks] = useState<AdBreak[]>([]);
  const playback = useRef<Playback | null>(null);
  /** «Звук встречи» выключен (R156) — плеер молчит вместе со всей встречей; это свойство встречи (R161). */
  const deafened = useStore(meeting.media.deafened);
  /**
   * Что человек выбрал ушами, а не что сейчас играет.
   *
   * Живёт в ссылке, а не в состоянии, потому что спрашивают об этом изнутри плеера: список
   * звуковых дорожек у YouTube меняется на **каждой** смене качества (у каждой лестницы своя
   * группа звука), и на каждую такую смену выбор языка надо назначать заново.
   */
  const wantedVoice = useRef(preferences.watchAudio);
  // Новый адрес — новые ступени: прежние к нему не относятся, а выбор руками — тем более.
  const renewed = useCallback(() => {
    setLevels([]);
    setLevel(-1);
    setAutomatic(-1);
  }, []);
  const player = useSource(api, watch, echo, renewed);
  const { source, setStatus, setError, renew, expired, dashFailed, recover } = player;
  // Лечение открывает поток заново через `recover`, а движок живёт в эффекте источника: свежая ссылка.
  const recovery = useRef(recover);
  recovery.current = recover;

  /*
    Кодеки, от которых отказались в этом просмотре (`decode.ts`), — и те, что ещё не доказали, что отказ
    помог, и потому не запомнены на устройстве. Поток заново (лечение, срок подписи) иначе начинался бы с
    того же кодека, который устройство только что не потянуло.
  */
  const lightened = useRef(new Set<VideoFamily>());
  const codecs = (device: MediaProfile) =>
    videoCodecs(device, undefined, new Set([...demotedFamilies(), ...lightened.current]));
  // Другое видео — другие ступени, озвучки и субтитры. Автоматическую ступень прежнего здесь
  // не сбрасывали и раньше: до первой новой её перепишет сам движок.
  const content = contentOf(watch);
  useEffect(() => {
    lightened.current = new Set();
    setLevels([]);
    setLevel(-1);
    setVoices([]);
    setVoice(-1);
    setTexts([]);
    setBreaks([]);
  }, [api, content]);

  // Плеер живёт, пока не сменился источник: пересоздавать его на каждое изменение комнаты —
  // это чёрный кадр у всех на каждую чужую паузу.
  useEffect(() => {
    const element = video.current;
    if (!source || !element) return;
    let alive = true;
    echo.suppress();
    setWatchLevel(element, watchLevel(preferences.watchVolume, deafened));
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
      playback.current = attachFile(element, source.url);
    } else if (source.kind === 'dash') {
      // Дорожка картинки DASH — тоже кодеком по силам устройства (`device.ts`), а не самой широкой.
      void (profile ? codecs(profile).catch(() => ['avc1' as const]) : Promise.resolve(undefined))
        .then((codecs) =>
          alive
            ? attachDash(
                element,
                source.url,
                preferred,
                {
                  alive: () => alive,
                  levels: (next, current) => {
                    setLevels(next);
                    setAutomatic(current);
                  },
                  voices: (next, current) => {
                    setVoices(next);
                    setVoice(current);
                  },
                  error: dashFailed,
                },
                { codecs },
              )
            : null,
        )
        .then((player) => {
          if (!alive) player?.destroy();
          else playback.current = player;
        })
        .catch(() => {
          if (alive) void renew(false);
        });
    } else if (hlsSupported()) {
      // Кодек картинки решается до первого куска (`device.ts`): ответ `MediaCapabilities` — миллисекунды.
      const attach = (codecs: readonly VideoFamily[] | undefined) => {
        if (!alive) return;
        playback.current = attachHls(
          element,
          source.url,
          preferred,
          {
            alive: () => alive,
            levels: (next, chosen) => {
              setLevels(next);
              setLevel(chosen);
            },
            automatic: setAutomatic,
            voices: setVoices,
            wanted: (tracks) => pickAudio(tracks, wantedVoice.current, source.language),
            voice: setVoice,
            texts: (tracks) => setTexts(captionChoices(tracks, source.captions)),
            breaks: setBreaks,
            liveBreaks: setLiveBreaks,
            expired,
            reopen: () => alive && recovery.current(),
            fail,
          },
          { codecs },
        );
      };
      if (profile) void codecs(profile).then(attach, () => attach(['avc1']));
      else attach(undefined);
    } else if (element.canPlayType('application/vnd.apple.mpegurl')) {
      playback.current = attachFile(element, source.url);
    } else {
      fail(t(($) => $.cinema.theater.errors.unsupported));
    }
    return () => {
      alive = false;
      echo.suppress();
      playback.current?.destroy();
      playback.current = null;
      element.removeAttribute('src');
      element.load();
    };
    // Громкость меняется отдельным хуком: она не повод пересоздавать плеер.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => {
    if (video.current) setWatchLevel(video.current, watchLevel(preferences.watchVolume, deafened));
  }, [preferences.watchVolume, deafened]);

  /*
    Сторож застрявшего плеера (R216, `stall.ts`): раз в полсекунды — стоит ли картинка, хотя должна идти,
    и не пора ли следующей ступени лечения. Каждая ступень — один раз за застревание; пошла картинка —
    застревание кончилось, и счётчик ядра узнаёт, вылечили ли его (`cinema-healed`).
  */
  const statusNow = useRef(player.status);
  statusNow.current = player.status;
  useEffect(() => {
    const element = video.current;
    if (!source || !element || !playhead) return;
    let done = new Set<Heal>();
    let sound = new Set<Heal>();
    let soundSince: number | null = null;
    let soundFine: number | null = null;
    /** Когда сделана прошлая ступень: следующая — не раньше {@link STEP_GAP_MS}, сколько бы ни стояло. */
    let stepAt = -Infinity;
    /** Сколько «Открываем…» видно на экране (только видимая вкладка с сетью), мс. */
    let loadingFor = 0;
    let tickAt = performance.now();
    let reopened = false;
    /** Тянет ли устройство нынешнюю картинку (`decode.ts`): раз в секунду, каждый второй взгляд. */
    const decode = new DecodeWatch();
    let odd = false;
    /** Отказ поставило лечение: картинка пошла сама — отказ снимается (движок под ним живёт дальше). */
    let gaveUp = false;
    /**
     * `fresh` у `reopen` — новый разбор у площадки (данных нет); без него — новый движок на том же адресе.
     * `soft` — лечится звук при идущей картинке: кончились попытки — отказа поверх идущего фильма нет.
     */
    const apply = (step: Heal, fresh = true, soft = false) => {
      if (step === 'fail') {
        noteFailure('cinema', 'cinema-heal-failed');
        gaveUp = true;
        setStatus('failed');
        setError(t(($) => $.cinema.theater.errors.stalled));
        return;
      }
      // Своё действие с `<video>` — не человек: ни пауза, ни пуск отсюда в комнату не уходят.
      echo.suppress(HEAL_QUIET_MS);
      if (step === 'reopen') {
        if (!recovery.current(fresh) && !soft) apply('fail');
        return;
      }
      if (playback.current?.heal?.(step)) return;
      if (step === 'nudge') element.currentTime = element.currentTime + NUDGE_S;
    };
    /** Кодек, от которого отказались по потерям кадров, — запомнится, когда шаг докажет пользу. */
    let trial: VideoFamily | null = null;
    const lighten = (now: number, verdict: ReturnType<DecodeWatch['sample']>) => {
      if (decode.takeProven() && trial) {
        demote(trial);
        trial = null;
      }
      if (!verdict) return;
      const result = playback.current?.lighten?.();
      if (!result) {
        decode.done = true;
        return;
      }
      // Застревания при данных впереди — довод сам по себе; потери кадров — только если шаг помог.
      if ('codec' in result) {
        lightened.current.add(result.codec);
        if (verdict.reason === 'stalls') demote(result.codec);
        else trial = result.codec;
      }
      noteFailure('cinema', 'cinema-decode');
      decode.stepped(now, verdict);
    };
    const timer = setInterval(() => {
      const now = performance.now();
      const gap = now - tickAt;
      tickAt = now;
      /*
        Скрытая вкладка (свёрнутое окно, погасший экран телефона) — не лечим: браузер сам придерживает там
        видео, таймеры редкие или стоят вовсе, а человек всё равно не видит кадра. Без сети — тоже: лечить
        нечего, hls.js дождётся её сам, а переоткрытие без сети кончилось бы отказом. Вернулись — лестница
        продолжает с того же места, а срок первого кадра считает только видимое время.
      */
      const away = document.hidden || offline();
      // Не судим о кадрах — и следующая проверка начинает счёт заново, а не с кадров, потерянных в фоне.
      if (away || statusNow.current !== 'ready') decode.sample(now, null);
      if (statusNow.current === 'loading') {
        if (!away) loadingFor += Math.min(gap, WATCHDOG_MS * 4);
        /*
          Поток выбран, а первого кадра всё нет (первый кусок не приходит): «Открываем…» не должно висеть
          вечно. Через {@link OPEN_MS} — поток заново; кончились попытки — честный отказ с «Повторить».
        */
        if (!reopened && loadingFor >= OPEN_MS) {
          reopened = true;
          noteFailure('cinema', 'cinema-stalled');
          apply('reopen');
        }
        return;
      }
      loadingFor = 0;
      if (gaveUp && statusNow.current === 'failed' && playhead.playedMs(now) >= HEALED_MS) {
        gaveUp = false;
        noteFailure('cinema', 'cinema-healed');
        setStatus('ready');
        setError('');
      }
      if (statusNow.current !== 'ready' || away) return;
      // У самого конца ролика позиция стоит законно: дальше просто нечего играть.
      const end = Number.isFinite(element.duration) && element.currentTime >= element.duration - END_S;
      const stalled = end ? 0 : playhead.stalledMs(now);
      const health = {
        ahead: aheadOf(element),
        loading: element.networkState === NETWORK_LOADING,
        fedAgoMs: null,
        auto: true,
        ...playback.current?.health?.(),
      };
      /*
        Застревание кончается, когда картинка снова идёт, а не когда она просто перестала стоять: пересборка
        источника ставит `<video>` на паузу, и по «не стоит» лестница начиналась бы заново по кругу.
      */
      if (done.size && playhead.playedMs(now) >= HEALED_MS) {
        noteFailure('cinema', 'cinema-healed');
        done = new Set();
      }
      odd = !odd;
      if (odd) {
        // Слой кинозала спрятан (зритель ушёл к участникам, R121) — кадры там не рисуются, и потери не в счёт.
        const judged =
          !element.paused &&
          !element.ended &&
          !element.seeking &&
          element.playbackRate === 1 &&
          !element.closest('[data-away]');
        const quality = judged && stalled === 0 ? element.getVideoPlaybackQuality?.() : undefined;
        lighten(
          now,
          decode.sample(
            now,
            quality ? { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames } : null,
          ),
        );
      }
      if (stalled > 0) {
        if (now - stepAt < STEP_GAP_MS) return;
        const step = nextHeal({ stalledMs: stalled, health, done });
        if (step) {
          if (!done.size) {
            noteFailure('cinema', 'cinema-stalled');
            // Встала при данных впереди — это конвейер (декодер), а не сеть: тоже повод облегчить кодек.
            if (health.ahead >= DATA) lighten(now, decode.stall(now));
          }
          done.add(step);
          stepAt = now;
          // Данные впереди есть — встал конвейер, и площадка тут ни при чём: заново без нового разбора.
          apply(step, health.ahead < DATA);
        }
        return;
      }
      // Звук, отставший от идущей картинки, — своей лестницей; толчок сбрасывает замер, а не застревание.
      if (playhead.audioStalled) {
        soundFine = null;
        if (soundSince === null) {
          soundSince = now;
          noteFailure('cinema', 'cinema-audio');
        }
        const step =
          now - stepAt < STEP_GAP_MS
            ? null
            : nextHeal({ stalledMs: now - soundSince, health, done: sound, audio: true });
        if (step) {
          sound.add(step);
          stepAt = now;
          apply(step, false, true);
        }
      } else if (soundSince !== null) {
        soundFine ??= now;
        if (now - soundFine >= SOUND_FINE_MS) {
          if (sound.size) noteFailure('cinema', 'cinema-healed');
          soundSince = null;
          soundFine = null;
          sound = new Set();
        }
      }
    }, WATCHDOG_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, playhead]);

  /*
    Отказ после потери сети (R216): сеть вернулась — пробуем сами, один раз на каждое её возвращение.
    «Повторить» остаётся, но телевизор с пультом не должен ждать, пока до него дотянутся.
  */
  const retryNow = useRef(player.retry);
  retryNow.current = player.retry;
  /** Отказ случился без сети: только такой стоит повторять самим, когда она вернётся. */
  const failedOffline = useRef(false);
  useEffect(() => {
    failedOffline.current = player.status === 'failed' && offline();
  }, [player.status]);
  useEffect(() => {
    const online = () => {
      if (statusNow.current === 'failed' && failedOffline.current) retryNow.current();
    };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, []);

  /**
   * `<video>` сообщил об ошибке. У HLS и DASH отказ приходит от движка, а у файла — только
   * отсюда: сначала одна попытка с новой подписью, потом честный отказ.
   */
  const mediaError = () => {
    if (player.status !== 'failed' && source?.kind === 'file') {
      if (player.fileFailed()) return;
      setStatus('failed');
      setError(t(($) => $.cinema.theater.errors.streamFailed));
    }
  };

  const chooseVoice = (choice: AudioChoice) => {
    // Помним язык, а не номер: у следующего ролика номера будут другие, а язык тот же.
    // Оригинал помнится пустой строкой — «как снял автор» у каждого ролика свой.
    const language = playback.current?.voice(choice.index);
    wantedVoice.current = choice.original ? '' : (language ?? '');
    meeting.media.saveSettings({ watchAudio: wantedVoice.current });
    setVoice(choice.index);
  };

  /** Ступень руками: номер в `levels`, `-1` — автоматически. */
  const chooseLevel = (index: number) => {
    setLevel(index);
    playback.current?.quality(index);
  };

  return {
    ...player,
    levels,
    level,
    automatic,
    voices,
    voice,
    texts,
    breaks,
    liveBreaks,
    playback,
    mediaError,
    chooseVoice,
    chooseLevel,
  };
}

/** Как часто сторож застрявшего плеера смотрит на позицию, мс. */
const WATCHDOG_MS = 500;
/** Между ступенями лечения — не меньше этого: каждой нужно время показать, помогла ли она, мс. */
const STEP_GAP_MS = 2000;
/** Ближе этого к концу ролика стоящая позиция — не застревание, секунды. */
const END_S = 0.5;
/** `HTMLMediaElement.NETWORK_LOADING`: у движка без своего счёта загрузки (готовый файл) — по `<video>`. */
const NETWORK_LOADING = 2;
/** Толчок позиции, секунды: столько, чтобы конвейер пересобрал кадр, и не больше, чтобы этого не было видно. */
const NUDGE_S = 0.05;
/** Окно тишины после лечения: пересборка источника рождает паузу и пуск, и это не человек. */
const HEAL_QUIET_MS = 4000;
/** Столько ждём первого кадра выбранного потока, прежде чем открыть его заново, мс. */
const OPEN_MS = 25_000;
/** Вылечили — когда картинка идёт без остановки столько, мс. */
const HEALED_MS = 2000;
/** Звук вылечили — когда он декодируется столько, мс. */
const SOUND_FINE_MS = 10_000;

/**
 * Громкость и «без звука» плеера (R213, владелец: «нельзя менять/выключать громкость… с телефона»). Safari на iPhone
 * громкость элемента не меняет — `volume` там только для чтения, и ноль не глушил; `muted` работает везде.
 */
export function setWatchLevel(element: HTMLMediaElement, level: number) {
  element.volume = level;
  element.muted = level <= 0;
}

/** Громкость плеера кинозала, 0–1: своя ручка, а «звук встречи» (R156) глушит и его. */
function watchLevel(watchVolume: number, deafened: boolean) {
  return deafened ? 0 : Math.max(0, Math.min(1, watchVolume / 100));
}
