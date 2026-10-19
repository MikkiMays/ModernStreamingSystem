/**
 * Статичная загрузка из `index.html` (`#cord-boot`) гасится отсюда, когда React нарисовал
 * первый настоящий кадр. Уход — 200 мс (или 120, если сцена ещё не успела проявиться), затем
 * узел удаляется из DOM, чтобы бесконечные анимации не крутились скрыто. Клики проходят сразу.
 *
 * Промис `Animation.finished` может не разрешиться (вкладка в фоне, анимации остановлены
 * политикой браузера), поэтому уход ограничен сроком: узел исчезает не позже чем через 400 мс
 * в любом случае. Повторный вызов во время ухода ничего не делает.
 */
let leaving: Promise<void> | null = null;

export function dismissBoot(): Promise<void> {
  if (leaving) return leaving;
  const root = document.getElementById('root');
  root?.removeAttribute('inert');
  root?.removeAttribute('aria-busy');
  const boot = document.getElementById('cord-boot');
  if (!boot) return Promise.resolve();
  boot.style.pointerEvents = 'none';
  const fade = boot.querySelector<HTMLElement>('.fl__fade');
  const shown = fade ? getComputedStyle(fade).opacity !== '0' : true;
  const duration = shown ? 200 : 120;
  const fallback = new Promise<void>((resolve) => setTimeout(resolve, duration * 2));
  let exit: Promise<unknown> = fallback;
  if (typeof boot.animate === 'function') {
    try {
      const animation = boot.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration,
        easing: 'ease-in',
        fill: 'forwards',
      });
      exit = Promise.race([animation.finished.catch(() => undefined), fallback]);
    } catch {
      // анимацию создать не удалось — уходим по сроку
    }
  }
  leaving = exit.then(() => {
    boot.remove();
    leaving = null;
  });
  return leaving;
}

/** Есть ли ещё статичная загрузка на странице. */
export const bootPending = () => !!document.getElementById('cord-boot');
