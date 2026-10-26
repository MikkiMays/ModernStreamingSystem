import { createContext, useContext } from 'react';

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
