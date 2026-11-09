import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Watch } from '../../../api/types';
import type { CinemaApi } from '../../../core/cinema';
import type { Meeting } from '../../../core/meeting';
import type { Preferences } from '../../../core/preferences';
import { noteFailure } from '../../../core/failure';
import { t } from '../../../i18n';
import { useStore } from '../../primitives';
import type { AdBreak } from './ad-breaks';
import { preferredVideoCodec, type MediaProfile } from './device';
import { attachDash } from './engines/dash';
import { attachFile } from './engines/file';
import { attachHls, hlsSupported } from './engines/hls';
import type { Playback } from './engines/playback';
import { aheadOf, type Playhead } from './playhead';
import { nextHeal, type Heal } from './stall';
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

  // Другое видео — другие ступени, озвучки и субтитры. Автоматическую ступень прежнего здесь
  // не сбрасывали и раньше: до первой новой её перепишет сам движок.
  const content = contentOf(watch);
  useEffect(() => {
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
        error: dashFailed,
      })
        .then((player) => {
          if (!alive) player?.destroy();
          else playback.current = player;
        })
        .catch(() => {
          if (alive) void renew(false);
        });
    } else if (hlsSupported()) {
      // Кодек картинки решается до первого куска (`device.ts`): ответ `MediaCapabilities` — миллисекунды.
      const attach = (videoCodec: 'avc1' | undefined) => {
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
          { videoCodec },
        );
      };
      if (profile) void preferredVideoCodec(profile).then(attach, () => attach('avc1'));
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
    const apply = (step: Heal) => {
      if (step === 'fail') {
        noteFailure('cinema', 'cinema-heal-failed');
        setStatus('failed');
        setError(t(($) => $.cinema.theater.errors.stalled));
        return;
      }
      // Своё действие с `<video>` — не человек: ни пауза, ни пуск отсюда в комнату не уходят.
      echo.suppress(HEAL_QUIET_MS);
      if (step === 'reopen') {
        if (!recovery.current()) apply('fail');
        return;
      }
      if (playback.current?.heal?.(step)) return;
      if (step === 'nudge') element.currentTime = element.currentTime + NUDGE_S;
    };
    const opened = performance.now();
    let reopened = false;
    const timer = setInterval(() => {
      const now = performance.now();
      /*
        Поток выбран, а первого кадра всё нет (первый кусок не приходит): «Открываем…» не должно висеть
        вечно. Через {@link OPEN_MS} — поток заново; кончились попытки — честный отказ с «Повторить».
      */
      if (statusNow.current === 'loading') {
        if (!reopened && now - opened >= OPEN_MS) {
          reopened = true;
          noteFailure('cinema', 'cinema-stalled');
          apply('reopen');
        }
        return;
      }
      if (statusNow.current !== 'ready') return;
      const stalled = playhead.stalledMs(now);
      const health = {
        ahead: aheadOf(element),
        loading: false,
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
      if (stalled > 0) {
        const step = nextHeal({ stalledMs: stalled, health, done });
        if (step) {
          if (!done.size) noteFailure('cinema', 'cinema-stalled');
          done.add(step);
          apply(step);
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
        const step = nextHeal({ stalledMs: now - soundSince, health, done: sound, audio: true });
        if (step) {
          sound.add(step);
          apply(step);
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
