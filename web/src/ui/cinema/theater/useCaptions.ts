import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Watch } from '../../../api/types';
import type { CinemaSource } from '../../../core/cinema';
import type { Meeting } from '../../../core/meeting';
import type { Preferences } from '../../../core/preferences';
import type { Playback } from './engines/playback';
import { contentOf } from './useSource';
import { pickCaption, type CaptionChoice } from './watch-tracks';

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

/**
 * Субтитры: какие включены и что в них звучит прямо сейчас.
 *
 * Что предлагает ролик (`texts`), знает движок; здесь — выбор человека и реплики, которые плеер
 * рисует сам, над пультом.
 */
export function useCaptions({
  meeting,
  watch,
  video,
  playback,
  source,
  texts,
  preferences,
}: {
  meeting: Meeting;
  watch: Watch;
  video: RefObject<HTMLVideoElement | null>;
  playback: RefObject<Playback | null>;
  source: CinemaSource | null;
  texts: CaptionChoice[];
  preferences: Preferences;
}) {
  const [text, setText] = useState('');
  const [lines, setLines] = useState<string[]>([]);
  const wantedText = useRef(preferences.watchSubtitles);

  // Другое видео — реплики прежнего гаснут сразу, а не когда до них дойдёт очередь.
  const content = contentOf(watch);
  useEffect(() => setLines([]), [meeting, content]);

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
    playback.current?.subtitles?.(chosen && chosen.track >= 0 ? chosen.track : -1);
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

  /** Выбранные субтитры — и файл, если их приносит не плейлист, а наш сервер. */
  const caption = texts.find((item) => item.id === text);
  const chooseText = (id: string) => {
    wantedText.current = id;
    setText(id);
    meeting.media.saveSettings({ watchSubtitles: id });
  };

  return { text, lines, caption, chooseText };
}
