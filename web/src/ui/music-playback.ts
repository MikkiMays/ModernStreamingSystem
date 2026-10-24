/**
 * Счёт времени и предсказание нажатий для музыкальной панели — без React и без сети.
 *
 * Панель раньше держала всё это внутри одного компонента на шестьсот строк: и разметку, и
 * арифметику позиции, и правила, по которым нажатие показывается до ответа сервера. Проверить
 * можно было только глазами. Здесь остались ровно те части, которые можно спросить напрямую.
 */

import type { MusicSource, MusicState, MusicTrack } from '../core/services';

export const MUSIC_SOURCES: MusicSource[] = ['upload', 'telegram', 'yandex', 'youtube', 'soundcloud'];

/** Минуты и секунды. Отрицательное и дробное приводится к тому, что можно показать. */
export function formatDuration(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Источники, которые сервер и правда предлагает, в порядке, понятном человеку. */
export function offeredSources(offered: string[] | undefined): MusicSource[] {
  const known = (offered ?? MUSIC_SOURCES).filter((value): value is MusicSource =>
    (MUSIC_SOURCES as string[]).includes(value),
  );
  return MUSIC_SOURCES.filter((source) => known.includes(source));
}

/**
 * Что показывать: ответ сервера или ещё не подтверждённое нажатие.
 *
 * Каждое состояние несёт номер ревизии, поэтому таймеры не нужны. Предсказание живёт ровно
 * до первого состояния новее того, из которого оно было построено, — им может оказаться и
 * ответ на саму команду, и очередной опрос.
 */
export interface Foresight {
  base: number;
  patch: Partial<MusicState>;
}

export function foresee(served: MusicState | undefined, foresight: Foresight | null) {
  if (!served) return undefined;
  if (!foresight || served.revision > foresight.base) return served;
  return { ...served, ...foresight.patch };
}

export function foresightSpent(served: MusicState | undefined, foresight: Foresight | null) {
  return !!foresight && !!served && served.revision > foresight.base;
}

/**
 * Где игла сейчас: последняя известная позиция плюс то, что прошло с тех пор.
 *
 * `behindMs` — на сколько мы слышим музыку позже, чем её отправил издатель (запас буфера приёма,
 * `MediaSession.musicPlayoutMs`, R03): позиция службы — время отправки, а игла должна совпадать со
 * звуком у этого человека. На паузе звука нет — вычитать нечего; раньше нуля игла не уходит.
 */
export function playbackPosition(
  anchor: { position: number; at: number },
  now: number,
  playing: boolean,
  limit: number,
  behindMs = 0,
) {
  if (!playing) return Math.min(limit, anchor.position);
  const moved = Math.max(0, now - anchor.at) / 1000;
  return Math.min(limit, Math.max(0, anchor.position + moved - behindMs / 1000));
}

/** После скольких секунд трека «назад» начинает его сначала, а не возвращает предыдущий. */
export const RESTART_AFTER = 3;

/**
 * Предсказание «назад» (R44, DECISIONS Р-14): дольше трёх секунд — тот же трек с начала. Иначе служба
 * вернёт предыдущий из своей истории, а какой он — знает только она: ждём её ответа.
 */
export function afterPrevious(position: number): Partial<MusicState> | undefined {
  return position > RESTART_AFTER ? { position: 0 } : undefined;
}

/** Очередь после «следующий трек»: с повтором он уходит в конец, без — насовсем. */
export function afterSkip(state: MusicState): Partial<MusicState> {
  return {
    queue: state.repeat ? [...state.queue.slice(1), ...state.queue.slice(0, 1)] : state.queue.slice(1),
    position: 0,
  };
}

/** Очередь после «поставить следующим»: трек встаёт сразу за тем, что играет. */
export function afterPromote(state: MusicState, track: MusicTrack): Partial<MusicState> {
  const rest = state.queue.filter((t) => t.id !== track.id);
  return { queue: [...rest.slice(0, 1), track, ...rest.slice(1)] };
}

/** Очередь после «убрать трек». Позиция обнуляется, только если убрали текущий. */
export function afterRemove(state: MusicState, trackId: string): Partial<MusicState> {
  return {
    queue: state.queue.filter((t) => t.id !== trackId),
    position: state.queue[0]?.id === trackId ? 0 : state.position,
  };
}

/**
 * Очередь после «переставить» (перетаскивание, стрелки на ручке): трек встаёт на место `index`.
 * Первое место — играющий трек, поэтому не раньше второго; дальше конца — в конец. Так же считает
 * служба (`music.py`, команда `move`), и предсказание совпадает с ответом.
 */
export function afterMove(state: MusicState, trackId: string, index: number): Partial<MusicState> {
  const from = state.queue.findIndex((t) => t.id === trackId);
  if (from < 1) return {};
  const rest = state.queue.filter((t) => t.id !== trackId);
  const to = Math.min(Math.max(1, index), rest.length);
  return { queue: [...rest.slice(0, to), state.queue[from]!, ...rest.slice(to)] };
}

/**
 * Куда встанет перетаскиваемый трек: сколько строк очереди (кроме него самого) выше указателя.
 * `middles` — середины этих строк по вертикали, сверху вниз; первая — играющий трек.
 */
export function dropIndex(middles: number[], y: number): number {
  return Math.max(1, middles.filter((middle) => middle < y).length);
}

/** Что в поле «Найти трек или вставить ссылку»: запрос, ссылка площадки или чужая ссылка. */
export type MusicQuery =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'link'; source: 'youtube' | 'soundcloud' | 'yandex'; url: string }
  | { kind: 'foreign' };

const LINK_SOURCES: [RegExp, 'youtube' | 'soundcloud' | 'yandex'][] = [
  [/^(?:(?:www|m|music)\.)?youtube\.com$|^(?:www\.)?youtu\.be$/, 'youtube'],
  [/^(?:(?:www|m)\.)?soundcloud\.com$/, 'soundcloud'],
  [/^music\.yandex\.(?:ru|com|kz|by|uz)$/, 'yandex'],
];

/**
 * Подсказка интерфейсу, а не проверка: какую ссылку открыть каким путём, решает служба. Здесь — только
 * чтобы ссылка не уходила в поиск как текст, а чужая ссылка получала ответ сразу, без запроса.
 */
export function classifyQuery(value: string): MusicQuery {
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) return { kind: 'empty' };
  if (!/^https?:\/\//i.test(text)) return { kind: 'text', text };
  let host: string;
  try {
    host = new URL(text).hostname.toLowerCase();
  } catch {
    return { kind: 'foreign' };
  }
  const found = LINK_SOURCES.find(([pattern]) => pattern.test(host));
  return found ? { kind: 'link', source: found[1], url: text } : { kind: 'foreign' };
}
