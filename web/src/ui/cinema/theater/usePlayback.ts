import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Watch } from '../../../api/types';
import type { CinemaApi } from '../../../core/cinema';
import type { Meeting } from '../../../core/meeting';
import type { Preferences } from '../../../core/preferences';
import { attachDash } from './engines/dash';
import { attachFile } from './engines/file';
import { attachHls, hlsSupported } from './engines/hls';
import type { Playback } from './engines/playback';
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
}: {
  meeting: Meeting;
  api: CinemaApi;
  watch: Watch;
  video: RefObject<HTMLVideoElement | null>;
  echo: Echo;
  preferences: Preferences;
}) {
  const [levels, setLevels] = useState<Level[]>([]);
  const [level, setLevel] = useState(-1);
  const [automatic, setAutomatic] = useState(-1);
  const [voices, setVoices] = useState<AudioChoice[]>([]);
  const [voice, setVoice] = useState(-1);
  const [texts, setTexts] = useState<CaptionChoice[]>([]);
  const playback = useRef<Playback | null>(null);
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
  const { source, setStatus, setError, renew, expired, dashFailed } = player;

  // Другое видео — другие ступени, озвучки и субтитры. Автоматическую ступень прежнего здесь
  // не сбрасывали и раньше: до первой новой её перепишет сам движок.
  const content = contentOf(watch);
  useEffect(() => {
    setLevels([]);
    setLevel(-1);
    setVoices([]);
    setVoice(-1);
    setTexts([]);
  }, [api, content]);

  // Плеер живёт, пока не сменился источник: пересоздавать его на каждое изменение комнаты —
  // это чёрный кадр у всех на каждую чужую паузу.
  useEffect(() => {
    const element = video.current;
    if (!source || !element) return;
    let alive = true;
    echo.suppress();
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
      playback.current = attachHls(element, source.url, preferred, {
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
        expired,
        fail,
      });
    } else if (element.canPlayType('application/vnd.apple.mpegurl')) {
      playback.current = attachFile(element, source.url);
    } else {
      fail('Этот браузер не умеет играть потоковое видео');
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
    if (video.current) video.current.volume = Math.max(0, Math.min(1, preferences.watchVolume / 100));
  }, [preferences.watchVolume]);

  /**
   * `<video>` сообщил об ошибке. У HLS и DASH отказ приходит от движка, а у файла — только
   * отсюда: сначала одна попытка с новой подписью, потом честный отказ.
   */
  const mediaError = () => {
    if (player.status !== 'failed' && source?.kind === 'file') {
      if (player.fileFailed()) return;
      setStatus('failed');
      setError('Поток не открылся. Попробуйте другое видео');
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
    playback,
    mediaError,
    chooseVoice,
    chooseLevel,
  };
}
