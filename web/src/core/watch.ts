import type { Watch } from '../api/types';

/**
 * Совместный просмотр: что открыто в комнате и где оно должно играть прямо сейчас.
 *
 * ПОЧЕМУ ЯКОРЬ, А НЕ ПОТОК ПОЗИЦИЙ. Комната хранит одну пару чисел: позицию и момент по часам
 * сервера, в который она была верна ({@link Watch}). Сколько прошло с тех пор, каждый считает
 * сам — поэтому в комнату ничего не шлётся, пока никто ничего не нажимает, а опоздавший и
 * переподключившийся попадают ровно в то же место, не спрашивая никого отдельно. Секунда сети
 * тут стоит секунды рассинхрона, и только в момент нажатия; ежесекундная рассылка позиций
 * стоила бы того же самого, но постоянно.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Живой эфир (`kind: 'channel'`) позиции не имеет: у Twitch каждый смотрит
 * собственный край трансляции, и догонять там нечего — синхронизируется только то, **что**
 * открыто. Попытка «подтянуть» живой поток перемоткой даёт бесконечную буферизацию.
 */
export type WatchProvider = Watch['provider'];
export type WatchKind = Watch['kind'];

/** Где ролик должен быть сейчас, по часам сервера. */
export function targetPosition(watch: Watch, serverNow: number): number {
  const elapsed = watch.paused ? 0 : Math.max(0, serverNow - watch.anchorAt);
  return Math.max(0, watch.positionMs + elapsed);
}

/** Насколько можно разойтись, прежде чем это стоит исправлять перемоткой. */
export const DRIFT_LIMIT = 1500;
/**
 * Догоняя, целимся чуть вперёд: пока перемотка доедет и плеер добуферизует, уйдёт ещё несколько
 * долей секунды, и приземление ровно в цель означает снова отставать.
 */
const CATCH_UP_LEAD = 400;

export type Correction =
  | { action: 'none' }
  | { action: 'play' }
  | { action: 'pause'; positionMs: number }
  | { action: 'seek'; positionMs: number };

/**
 * Что сделать со своим плеером, чтобы оказаться там же, где комната. Ответ считается от
 * состояния комнаты, а не от чужих сообщений: своё решение принимает каждый сам и одинаково.
 */
export function correction(input: {
  watch: Watch;
  serverNow: number;
  /** Позиция своего плеера, мс. `null` — плеер ещё не отвечает. */
  localMs: number | null;
  playing: boolean;
}): Correction {
  const { watch, serverNow, localMs, playing } = input;
  /*
    Живой эфир не двигают: общей позиции у него нет, а перемотка к «краю» — это бесконечная
    буферизация. Общим остаётся только то, какой канал открыт.

    Но играть его всё-таки нужно, и это единственное, что здесь решается. Пока этой строки не
    было, эфир вёл себя загадочно: сегменты шли, окно росло, картинка стояла — потому что
    команду `play()` не давал никто. У ролика её даёт комната, а у эфира комнате нечего
    сказать: каждый смотрит свой край трансляции.
  */
  if (watch.kind !== 'video') return playing ? { action: 'none' } : { action: 'play' };
  const target = targetPosition(watch, serverNow);
  if (watch.paused) {
    if (playing) return { action: 'pause', positionMs: target };
    if (localMs !== null && Math.abs(localMs - target) > DRIFT_LIMIT)
      return { action: 'seek', positionMs: target };
    return { action: 'none' };
  }
  if (!playing) return { action: 'play' };
  if (localMs === null) return { action: 'none' };
  const drift = localMs - target;
  if (Math.abs(drift) <= DRIFT_LIMIT) return { action: 'none' };
  return { action: 'seek', positionMs: drift < 0 ? target + CATCH_UP_LEAD : target };
}
