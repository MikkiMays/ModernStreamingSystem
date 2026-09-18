/**
 * Счёт времени и предсказание нажатий для музыкальной панели — без React и без сети.
 *
 * Панель раньше держала всё это внутри одного компонента на шестьсот строк: и разметку, и
 * арифметику позиции, и правила, по которым нажатие показывается до ответа сервера. Проверить
 * можно было только глазами. Здесь остались ровно те части, которые можно спросить напрямую.
 */

import type { MusicSource, MusicState, MusicTrack } from '../core/services';

export const MUSIC_SOURCES: MusicSource[] = ['upload', 'telegram', 'yandex'];

export const MUSIC_SOURCE_LABELS: Record<MusicSource, string> = {
  upload: 'Аудиофайл',
  telegram: 'Telegram',
  yandex: 'Яндекс Музыка',
};

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

/** Яндекс по умолчанию, если он вообще есть: с него чаще всего и начинают. */
export function preferredSource(sources: MusicSource[]): MusicSource {
  return sources.includes('yandex') ? 'yandex' : (sources[0] ?? 'upload');
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

/** Где игла сейчас: последняя известная позиция плюс то, что прошло с тех пор. */
export function playbackPosition(
  anchor: { position: number; at: number },
  now: number,
  playing: boolean,
  limit: number,
) {
  const moved = playing ? Math.max(0, now - anchor.at) / 1000 : 0;
  return Math.min(limit, anchor.position + moved);
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
