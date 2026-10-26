/**
 * Один физический пиксель экрана в CSS-пикселях — `--device-px` на `<html>` (R123).
 *
 * На масштабе Windows 125 % CSS-пиксель — это 1,25 физического, и зазор 2 px между дорожкой
 * переключателя и плашкой становится 2,5 физических. Chromium прижимает каждый край к физическому
 * пикселю сам по себе, и на дробной позиции дорожки сверху выходит 2 пикселя, а снизу 3 (замер R108
 * с настоящим масштабом, `--force-device-scale-factor`). Токены, которым нужна ровность до
 * пикселя, округляются к целому числу физических пикселей: `round(nearest, 2px, var(--device-px))`
 * — на 125 % это 2,4 px (3 физических), на 150 % — 2 px (3 физических). Без скрипта шаг — 1 px, как было.
 *
 * Масштаб меняется на ходу: окно перетащили на другой монитор, Ctrl + плюс в клиенте — тогда
 * срабатывает запрос `(resolution: …dppx)` текущего значения, и переменная пересчитывается.
 */
export function installDevicePixel(
  target: Window = window,
  root: HTMLElement = document.documentElement,
): () => void {
  let query: MediaQueryList | null = null;
  const update = () => {
    const ratio = target.devicePixelRatio > 0 ? target.devicePixelRatio : 1;
    root.style.setProperty('--device-px', `${1 / ratio}px`);
    query?.removeEventListener('change', update);
    query = typeof target.matchMedia === 'function' ? target.matchMedia(`(resolution: ${ratio}dppx)`) : null;
    query?.addEventListener('change', update);
  };
  update();
  return () => {
    query?.removeEventListener('change', update);
    root.style.removeProperty('--device-px');
  };
}
