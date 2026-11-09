import { useEffect, useState, type RefObject } from 'react';

/**
 * Идёт ли картинка на самом деле — по самой позиции `<video>`, а не по его событиям (R216).
 *
 * ПОЧЕМУ НЕ СОБЫТИЯ. Крутящийся кружок раньше включало `waiting` и гасило `playing`. Телевизоры и старые
 * движки шлют `waiting` после перемотки, а `playing` — не всегда: кадр уже шёл, а кружок крутился посреди
 * него (жалоба владельца с телевизора 09.11.2026). Позиция не врёт нигде: двигается — значит, идёт.
 *
 * ЧТО ЕЩЁ ОТСЮДА ВИДНО:
 * - сколько этот плеер ждёт данные после перемотки за край загруженного (`resumeMs`) — по нему комната
 *   целится вдогонку (`core/watch.catchUpLead`); перемотка внутри загруженного в счёт не идёт;
 * - звук, который перестал декодироваться при идущей картинке (`audioStalled`): у Chromium и WebKit
 *   `webkitAudioDecodedByteCount` растёт, пока звук играет; стоит на месте три секунды фильма при
 *   включённом звуке — звук застрял (`stall.ts` его лечит).
 */

/** Насколько позиция должна сдвинуться, чтобы это считалось движением, секунды. */
const MOVE = 0.05;
/** Перемотка в пределах загруженного — если до края загруженного остаётся хотя бы столько, секунды. */
const INSIDE = 0.3;
/** Дольше этого «ожидание после перемотки» — уже не ожидание, а застревание: в оценку не идёт. */
const LONGEST_RESUME = 15_000;
/** Сколько секунд фильма звук может не декодироваться при идущей картинке. */
const AUDIO_SILENT = 3;
/** По скольким последним ожиданиям после перемотки судим (медиана). */
const RESUMES_KEPT = 5;

/** То, что сторож читает у `<video>`. */
export interface Watched {
  currentTime: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  muted: boolean;
  volume: number;
  buffered: { length: number; start(index: number): number; end(index: number): number };
  webkitAudioDecodedByteCount?: number;
}

/** Сколько загружено впереди позиции, секунды (0 — позиция вне загруженного). */
export function aheadOf(video: Pick<Watched, 'buffered' | 'currentTime'>, at = video.currentTime): number {
  const ranges = video.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= at + 0.1 && at < ranges.end(i)) return ranges.end(i) - at;
  }
  return 0;
}

export class Playhead {
  /** Позиция и время последнего движения (или последней перемотки). */
  private mark: { at: number; time: number } | null = null;
  /** С какого момента позиция стоит, хотя должна идти. */
  private still: number | null = null;
  /** С какого момента позиция идёт без остановки. */
  private going: number | null = null;
  /** Перемотка, после которой позиция ещё не двинулась: когда и было ли место загружено. */
  private seek: { at: number; inside: boolean } | null = null;
  /** Звук: байты декодера и позиция, на которой они были такими. */
  private sound: { bytes: number; time: number } | null = null;
  private heard = false;
  /** Сколько этот плеер ждёт данные после перемотки за край загруженного, мс (медиана); `null` — не мерили. */
  resumeMs: number | null = null;
  /** Последние замеры ожидания после перемотки за край загруженного, мс. */
  private waits: number[] = [];
  /** Последний замер ожидания после перемотки, мс. */
  lastResumeMs: number | null = null;
  /** Сколько перемоток уже дождались движения картинки: по нему видно, что замер — про свою перемотку. */
  resumes = 0;
  /** Звук не декодируется при идущей картинке. */
  audioStalled = false;

  /**
   * Перемотка началась (`seeking`): позиция уже новая. Перемотка, пока картинка не пошла после прошлой, —
   * то же ожидание: hls.js сам переставляет позицию на начало пришедших данных, и без этого четыре секунды
   * ожидания записывались бы как его последние доли секунды.
   */
  seeking(now: number, video: Watched) {
    const inside = aheadOf(video) > INSIDE;
    this.seek = this.seek ? { at: this.seek.at, inside: this.seek.inside && inside } : { at: now, inside };
    this.mark = { at: now, time: video.currentTime };
    this.sound = null;
    this.audioStalled = false;
  }

  /** Очередной взгляд на `<video>` (раз в четверть секунды). */
  sample(now: number, video: Watched) {
    if (video.paused || video.ended) {
      this.still = null;
      this.going = null;
      this.mark = { at: now, time: video.currentTime };
      this.sound = null;
      this.audioStalled = false;
      /*
        Перемотка на паузе — не ожидание данных: пока стоим, плеер успевает их загрузить, а время паузы
        иначе записалось бы в «столько этот плеер ждёт после перемотки» (`resumeMs`). Комната на паузе
        10 с, кто-то перемотал, потом пуск — и следующая перемотка вдогонку целилась бы на 8 с вперёд.
      */
      this.seek = null;
      return;
    }
    // В обе стороны: перемотка назад без события `seeking` — тоже движение, а не вечное «стоит».
    const moved =
      !video.seeking && this.mark !== null && Math.abs(video.currentTime - this.mark.time) >= MOVE;
    if (this.mark === null || moved) {
      if (moved && this.seek) {
        const took = now - this.seek.at;
        this.lastResumeMs = took;
        this.resumes++;
        if (!this.seek.inside && took <= LONGEST_RESUME) {
          // Медиана последних замеров, а не среднее: одно невезучее ожидание (место на стыке двух кусков)
          // не должно уводить следующую перемотку вдогонку на секунды вперёд.
          this.waits = [...this.waits.slice(1 - RESUMES_KEPT), took];
          const sorted = [...this.waits].sort((a, b) => a - b);
          this.resumeMs = sorted[Math.floor((sorted.length - 1) / 2)]!;
        }
        this.seek = null;
      }
      if (moved && this.going === null) this.going = this.mark?.at ?? now;
      this.mark = { at: now, time: video.currentTime };
      this.still = null;
    } else {
      this.going = null;
      if (this.still === null) this.still = this.mark.at;
    }
    this.listen(video, moved);
  }

  /** Сколько позиция стоит, хотя должна идти, мс (0 — идёт или пауза). */
  stalledMs(now: number): number {
    return this.still === null ? 0 : Math.max(0, now - this.still);
  }

  /** Сколько позиция идёт без остановки, мс (0 — стоит или пауза). */
  playedMs(now: number): number {
    return this.going === null ? 0 : Math.max(0, now - this.going);
  }

  /** Перемотка, после которой картинка ещё не пошла. */
  get resuming(): boolean {
    return this.seek !== null;
  }

  private listen(video: Watched, moved: boolean) {
    const bytes = video.webkitAudioDecodedByteCount;
    if (typeof bytes !== 'number' || video.muted || video.volume <= 0) {
      this.sound = null;
      this.audioStalled = false;
      return;
    }
    if (!this.sound || bytes !== this.sound.bytes) {
      if (this.sound && bytes > this.sound.bytes) this.heard = true;
      this.sound = { bytes, time: video.currentTime };
      this.audioStalled = false;
      return;
    }
    if (moved && this.heard && video.currentTime - this.sound.time >= AUDIO_SILENT) this.audioStalled = true;
  }
}

/** Как часто сторож смотрит на `<video>`, мс. */
export const SAMPLE_MS = 250;
/** Кружок — только если позиция стоит дольше этого: короткая заминка его не стоит. */
export const SPINNER_MS = 500;

/**
 * Сторож позиции на `<video>` плеера: сам `Playhead` (его читают синхронизация и лечение) и то, что видно
 * человеку, — стоит ли картинка (`stalledMs`, с шагом в четверть секунды).
 */
export function usePlayhead(video: RefObject<HTMLVideoElement | null>) {
  const [playhead] = useState(() => new Playhead());
  const [stalledMs, setStalledMs] = useState(0);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const watched = element as unknown as Watched;
    const tick = () => {
      const now = performance.now();
      playhead.sample(now, watched);
      // Состояние — шагами: кружок и подпись «грузится медленно» меняются не чаще, чем это видно.
      const still = playhead.stalledMs(now);
      setStalledMs(still < SPINNER_MS ? 0 : Math.floor(still / 1000) * 1000 || SPINNER_MS);
    };
    const seeking = () => playhead.seeking(performance.now(), watched);
    element.addEventListener('seeking', seeking);
    const timer = setInterval(tick, SAMPLE_MS);
    return () => {
      clearInterval(timer);
      element.removeEventListener('seeking', seeking);
    };
  }, [video, playhead]);
  return { playhead, stalledMs };
}
