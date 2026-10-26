import { createContext, useContext } from 'react';
import { exitFullscreenWithin } from '../core/fullscreen';
import type { Meeting } from '../core/meeting';

/**
 * Что слой интеграции на сцене знает о выходе к участникам (R121).
 *
 * Интеграцию держит смонтированной `Stage`, и только он знает, видна ли она сейчас этому зрителю. Шапки
 * столов, пульт плеера и каталог кинозала берут отсюда кнопку «Участники» (`leave`), а клавиши стола и
 * плеера — признак `away`: ушедший смотрит сетку, и пробел, нажатый там, не должен ставить фильм на паузу
 * всей комнате, а «F» — сбрасывать его карты. Вне сцены (тесты столов, витрина) выхода нет: `leave` — `null`.
 */
export interface StageExit {
  /** Зритель ушёл к участникам: интеграция спрятана, но идёт. */
  away: boolean;
  /** Уйти к участникам; `null` — интеграция не на сцене встречи. */
  leave: (() => void) | null;
}

export const StageExitContext = createContext<StageExit>({ away: false, leave: null });

export function useStageExit(): StageExit {
  return useContext(StageExitContext);
}

/** Сочетание выхода и возврата (R121): буква без модификаторов, по месту на клавиатуре — и в русской раскладке. */
export const STAGE_KEY = 'KeyG';
/** Как сочетание называется для глаз и для `aria-keyshortcuts`. */
export const STAGE_KEY_LABEL = 'G';

/**
 * Фокус — туда, куда человек попал, после того как React нарисовал новый вид: кнопка возврата прячется
 * вместе со слоем, и без этого фокус падал бы на `<body>`, а диктор молчал бы о том, где он теперь.
 */
export function focusAfterSwitch(find: () => HTMLElement | null | undefined) {
  requestAnimationFrame(() => find()?.focus({ preventScroll: true }));
}

/**
 * Уйти к участникам (R121): кнопка «Участники», клавиша G. Полный экран внутри интеграции сворачивается —
 * спрятанный слой во весь экран оставлять нельзя; фокус — на чёлку, она и вернёт.
 */
export function leaveToPeople(meeting: Pick<Meeting, 'leaveStage'>) {
  exitFullscreenWithin(document.querySelector('[data-stage-layer]'));
  meeting.leaveStage();
  focusAfterSwitch(() => document.querySelector<HTMLElement>('[data-stage-notch]'));
}

/**
 * Вернуться в интеграцию (R121): чёлка, клавиша G. Фокус — на «Участники» в её шапке, чтобы тем же путём
 * можно было снова выйти; у открытого поверх плеера каталога — на его кнопку (она последняя в слое).
 */
export function backToStage(meeting: Pick<Meeting, 'returnToStage'>) {
  meeting.returnToStage();
  focusAfterSwitch(() => {
    const exits = document.querySelectorAll<HTMLElement>(
      '[data-stage-layer]:not([data-away]) [data-stage-exit]',
    );
    return exits[exits.length - 1];
  });
}
