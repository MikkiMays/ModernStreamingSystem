import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { ChannelTab, CinemaAt, CinemaItem, ProviderId } from '../../../core/cinema';
import { linkCard } from '../../../core/cinema/link';

/**
 * Что открыто прямо сейчас. Всё, кроме `home`, — это страница, на которую зашли.
 *
 * `series` — сериал с открытым сезоном (пусто — тот, что площадка открывает первым), `title` и
 * `poster` — с карточки, по которой вошли: шапка сериала не ждёт ответа, чтобы назваться.
 * `shelf` — полка витрины, открытая целиком («Все эфиры»). `linked` у ролика — страница открыта по
 * ссылке: карточка знает только номер, и имя для комнаты берётся со страницы ролика.
 */
export type View =
  | { at: 'home' }
  | { at: 'channel'; id: string; tab: ChannelTab }
  | { at: 'playlist'; id: string }
  | { at: 'category'; id: string; title: string }
  | { at: 'item'; item: CinemaItem; linked?: boolean }
  | { at: 'series'; id: string; season: string; title: string; poster: string | null }
  | { at: 'shelf'; id: string; title: string };

/**
 * Страница, на которую ведёт ссылка, — как её вид в стопке. Ролик и эфир — карточка с одним номером
 * (`linkCard`): имя, кадр и всё остальное приезжают со страницы ролика. `link` — не страница
 * площадки, её показывает только сцена «По ссылке».
 */
export function viewOf(provider: ProviderId, at: CinemaAt): View | null {
  if (at.page === 'item') return { at: 'item', item: linkCard(provider, at), linked: true };
  if (at.page === 'channel') return { at: 'channel', id: at.id, tab: 'videos' };
  if (at.page === 'playlist') return { at: 'playlist', id: at.id };
  if (at.page === 'series') return { at: 'series', id: at.id, season: '', title: '', poster: null };
  return null;
}

/** Одна и та же страница: тот же вид и тот же номер (у ролика — и та же площадка). */
function same(a: View | undefined, b: View): boolean {
  if (!a || a.at !== b.at) return false;
  if (a.at === 'item' && b.at === 'item')
    return a.item.provider === b.item.provider && a.item.kind === b.item.kind && a.item.id === b.item.id;
  return 'id' in a && 'id' in b && a.id === b.id;
}

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
 *
 * Сеттер принадлежит одному визиту ключа (`visit`), а не ключу: запоздавший вызов — таймер, ответ
 * сети — от прежней площадки не пишет ни в новую, ни в следующий визит той же самой. Визит, а не
 * сам ключ, — потому что YouTube → Twitch → YouTube снова даёт ключ `youtube`, а открытое на
 * первом заходе ко второму не относится.
 */
export function useKeyed<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState({ key, visit: 0, value: initial });
  const fresh = state.key === key ? state : { key, visit: state.visit + 1, value: initial };
  if (fresh !== state) setState(fresh);
  const { visit } = fresh;
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) =>
      setState((current) => {
        if (current.visit !== visit) return current;
        const value = typeof next === 'function' ? (next as (value: T) => T)(current.value) : next;
        // То же значение — то же состояние: React тогда не рисует заново, как и с обычным useState.
        return Object.is(value, current.value) ? current : { ...current, value };
      }),
    [visit],
  );
  return [fresh.value, set];
}

/**
 * Как ходят по каталогу — стопкой.
 *
 * Каждый переход кладётся сверху, «назад» снимает верхнее. Поэтому из плейлиста возвращаются на
 * канал, с канала — в поиск, и ни один переход не уводит из каталога насовсем. Вкладки канала
 * стопку не растят — они меняют верхнее: пять нажатий по вкладкам не должны превращаться в пять
 * нажатий «назад». Стопка принадлежит площадке (`owner`): новая площадка начинается с главной.
 *
 * ССЫЛКА — ТОЖЕ ПЕРЕХОД. Страница, на которую ведёт вставленная ссылка (`at`), кладётся сверху — и
 * когда сцена открывается по ссылке, и когда ссылку вставили в уже открытую сцену: «назад» с неё
 * возвращает туда, где её вставили. Смена ссылки узнаётся по самому объекту (`Meeting.cinemaAt`
 * даёт новый на каждое открытие), а та же страница, что уже сверху, второй раз не кладётся.
 * Переход — в рендере, как у `useKeyed`: страница видна с первого же кадра сцены, без витрины на
 * кадр раньше.
 */
export function useStack(owner: ProviderId, at: CinemaAt | null = null) {
  const [kept, setStack] = useKeyed<View[]>(owner, HOME);
  const [seen, setSeen] = useState<CinemaAt | null>(null);
  let stack = kept;
  if (at !== seen) {
    setSeen(at);
    const next = at ? viewOf(owner, at) : null;
    // Новая стопка — уже в этом рендере: ни один кадр, даже промежуточный, не видит витрину.
    if (next && !same(kept[kept.length - 1], next)) {
      stack = [...kept, next];
      setStack(stack);
    }
  }
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
  /** Сезон сериала — как вкладка канала: меняет открытое, а не кладётся сверху. */
  const switchSeason = (season: string) =>
    setStack((current) =>
      current.map((entry, index) =>
        index === current.length - 1 && entry.at === 'series' ? { ...entry, season } : entry,
      ),
    );
  /** Набранный поиск уводит на главную: результаты поиска живут там. */
  const home = () => setStack(HOME);
  return { stack, view, go, back, switchTab, switchSeason, toChannel, home };
}
