import { useCallback, useEffect, useState, type RefObject } from 'react';

/**
 * Полный экран там, где он есть, и его замена там, где его нет.
 *
 * ПОЧЕМУ ЗАМЕНА. На iPhone полноэкранного режима для обычных элементов нет вовсе: Safari (а
 * значит, и всякий браузер на этом телефоне) умеет разворачивать только собственный плеер
 * `<video>` и ничего больше. `requestFullscreen` там либо отсутствует, либо отказывает — и
 * кнопка «развернуть» превращалась в кнопку, которая не делает ничего. Со стороны это и
 * читается как «полноэкранный режим недоступен».
 *
 * Разворачивать средствами самого телефона нечего, но то, ради чего кнопку и нажимают —
 * кадр во весь экран без чужих полей, — достижимо и без него: элемент раскладывается на всё
 * окно поверх страницы. Полоса адреса браузера при этом остаётся; убрать её со страницы
 * нельзя ничем, и обещать этого не стоит.
 *
 * Разворачивать **свой** плеер, а не `<video>`, важно: родной полный экран телефона рисует
 * собственные кнопки и собственные субтитры, а у нас и те, и другие свои — общая пауза на
 * всю комнату и дорожка текста, которую мы рисуем сами.
 */
export function fullscreenAvailable(): boolean {
  return typeof document !== 'undefined' && document.fullscreenEnabled === true;
}

/**
 * Состояние «развёрнуто» и переключатель к нему.
 *
 * Снаружи разницы между настоящим полным экраном и его заменой нет: один флаг, одна кнопка.
 * Внутри — `data-full` на самом элементе, по которому замена и раскладывается; у настоящего
 * полного экрана тот же атрибут ничего не меняет, потому что браузер уже всё сделал сам.
 */
export function useFullscreen(target: RefObject<HTMLElement | null>): {
  full: boolean;
  toggle: () => void;
} {
  const [full, setFull] = useState(false);
  useEffect(() => {
    const changed = () =>
      setFull(!!document.fullscreenElement && document.fullscreenElement === target.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, [target]);
  // Выход из замены по Escape: настоящий полный экран закрывается им сам, и вести себя
  // иначе было бы неожиданностью там, где всё остальное одинаково.
  useEffect(() => {
    if (!full || fullscreenAvailable()) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [full]);
  const toggle = useCallback(() => {
    if (!fullscreenAvailable()) {
      setFull((current) => !current);
      return;
    }
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else
      void target.current?.requestFullscreen().catch(() => {
        // Разрешение бывает и там, где режим объявлен: тогда остаётся та же замена.
        setFull(true);
      });
  }, [target]);
  return { full, toggle };
}
