import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { useTranslation } from 'react-i18next';
import { inMeeting } from '../core/live-meetings';
import { Button } from './kit';
import './lazy-part.css';

/**
 * Часть Cord, которая грузится по требованию (раздел, кинозал, игра, диагностика), и что делать, если её
 * модуль не загрузился.
 *
 * ЗАЧЕМ (владелец 10.11.2026: «раздел поддержки перестал открываться в вебе»). Имена модулей несут хеш
 * сборки, и после выкатки прежних на сервере нет. Вкладка, открытая до выкатки, просит модуль по старому
 * имени — и `React.lazy` бросает: без границы ошибок React снимает всё дерево, человек видит пустой экран
 * или раздел, который не открывается. Поэтому:
 *
 * - не во встрече — страница один раз перезагружается сама и получает новую сборку (не чаще раза в
 *   {@link RELOAD_GAP_MS}: если модуль не грузится и в новой сборке, круга перезагрузок не будет);
 * - во встрече перезагрузка оборвала бы разговор — на месте части встаёт короткая надпись с кнопкой
 *   «Обновить страницу», а встреча идёт дальше.
 *
 * Тот же ответ — на `vite:preloadError` (`main.tsx`): так ведут себя и динамические импорты вне
 * `lazyPart`.
 */

export const RELOAD_GAP_MS = 30_000;
const RELOADED_AT = 'cord:reloaded-for-build';

let reloading = false;

/** Чем перезагружать страницу; тесты подменяют (в jsdom `location.reload` не подменить). */
export const page = { reload: () => location.reload() };

/** Перезагрузить страницу ради новой сборки; `false` — нельзя (идёт встреча) или только что перезагружали. */
export function reloadForNewBuild(
  now = Date.now(),
  reload: () => void = () => page.reload(),
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof sessionStorage === 'undefined'
    ? null
    : sessionStorage,
): boolean {
  if (reloading) return true;
  if (inMeeting() || !storage) return false;
  try {
    const last = Number(storage.getItem(RELOADED_AT) ?? 0);
    if (now - last < RELOAD_GAP_MS) return false;
    storage.setItem(RELOADED_AT, String(now));
  } catch {
    // Хранилище закрыто (приватное окно): без отметки защиты от круга нет — не перезагружаем.
    return false;
  }
  reloading = true;
  reload();
  return true;
}

/** Только для тестов: забыть, что перезагрузка уже началась. */
export function resetReloadForTests() {
  reloading = false;
}

function StalePart() {
  const { t } = useTranslation();
  return (
    <div className="stale-part" role="status">
      <p>{t(($) => $.app.stale.text)}</p>
      <Button size="sm" onClick={() => page.reload()}>
        {t(($) => $.app.stale.reload)}
      </Button>
    </div>
  );
}

/** `React.lazy`, который не роняет экран, если модуль части не загрузился (см. выше). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- та же граница типов, что у React.lazy
export function lazyPart<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      return await load();
    } catch (error) {
      // Страница уже перезагружается — держим заглушку Suspense, а не мигаем надписью.
      if (reloadForNewBuild()) return new Promise<never>(() => {});
      console.warn('[cord] lazy part failed to load', error);
      return { default: StalePart as unknown as T };
    }
  });
}
