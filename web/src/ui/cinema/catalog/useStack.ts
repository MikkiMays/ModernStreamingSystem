import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { ChannelTab, CinemaItem } from '../../../core/cinema';

/** Что открыто прямо сейчас. Всё, кроме `home`, — это страница, на которую зашли. */
export type View =
  | { at: 'home' }
  | { at: 'channel'; id: string; tab: ChannelTab }
  | { at: 'playlist'; id: string }
  | { at: 'category'; id: string; title: string }
  | { at: 'item'; item: CinemaItem };

const HOME: View[] = [{ at: 'home' }];

/**
 * Состояние, которое принадлежит ключу: сменился ключ — в том же кадре вернулось начальное.
 *
 * ЗАЧЕМ, ЕСЛИ ЕСТЬ `key`. Каталог сбрасывал всё открытое эффектом при смене площадки, то есть
 * на кадр позже: первый кадр Twitch ещё видел поиск и канал YouTube и успевал спросить службу о
 * них под именем Twitch. Ремоунт по `key` сбросил бы вовремя, но пересоздал бы и шапку — а в
 * ней нажатая вкладка (фокус с неё уехал бы в поле поиска с `autoFocus`, на телефоне — вместе с
 * клавиатурой) и само поле. Поэтому ключ стоит на самом состоянии: оно помнит, чьё оно, и чужое
 * не показывает ни одного кадра, а элементы на экране остаются теми же.
 *
 * Чужое переписывается прямо в рендере, а не эффектом: React тут же повторяет рендер, не
 * показывая промежуточного, — и возврат на прежнюю площадку тоже начинается с чистого листа.
 */
export function useKeyed<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState({ key, value: initial });
  if (state.key !== key) setState({ key, value: initial });
  const value = state.key === key ? state.value : initial;
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) =>
      setState((current) => {
        const value = typeof next === 'function' ? (next as (value: T) => T)(current.value) : next;
        // То же значение — то же состояние: React тогда не рисует заново, как и с обычным useState.
        return Object.is(value, current.value) ? current : { key: current.key, value };
      }),
    [],
  );
  return [value, set];
}

/**
 * Как ходят по каталогу — стопкой.
 *
 * Каждый переход кладётся сверху, «назад» снимает верхнее. Поэтому из плейлиста возвращаются на
 * канал, с канала — в поиск, и ни один переход не уводит из каталога насовсем. Вкладки канала
 * стопку не растят — они меняют верхнее: пять нажатий по вкладкам не должны превращаться в пять
 * нажатий «назад». Стопка принадлежит площадке (`owner`): новая площадка начинается с главной.
 */
export function useStack(owner: string) {
  const [stack, setStack] = useKeyed<View[]>(owner, HOME);
  const view: View = stack[stack.length - 1] ?? { at: 'home' };
  const go = (next: View) => setStack((current) => [...current, next]);
  const back = () => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
  /** Вкладка канала меняет открытое, а не кладётся сверху. */
  const switchTab = (tab: ChannelTab) =>
    setStack((current) =>
      current.map((entry, index) =>
        index === current.length - 1 && entry.at === 'channel' ? { ...entry, tab } : entry,
      ),
    );
  const toChannel = (id: string) => setStack((current) => [...current, { at: 'channel', id, tab: 'videos' }]);
  /** Набранный поиск уводит на главную: результаты поиска живут там. */
  const home = () => setStack(HOME);
  return { stack, view, go, back, switchTab, toChannel, home };
}
