/**
 * Запуск без жеста — лестницей (R150, Р-42).
 *
 * Политика автозапуска отказывает `play()` со звуком, если у этой страницы не было свежего нажатия:
 * на iPhone почти всегда, в любом браузере — после перезагрузки или восстановления встречи. Раньше
 * отказ означал «Смотреть вместе» поверх стоящего кадра, и человек думал, что фильм не открылся или
 * нет звука. Беззвучный запуск разрешён везде, поэтому вторая ступень — тот же фильм без звука и в такт
 * с комнатой, а звук включает первое же касание (плашка «Включить звук»). Третья — прежняя кнопка: её
 * видят, только если отказали и беззвучно.
 */
export type Autoplay = 'sound' | 'muted' | 'blocked';

export async function playLadder(element: HTMLVideoElement): Promise<Autoplay> {
  try {
    await element.play();
    return element.muted ? 'muted' : 'sound';
  } catch (error) {
    if ((error as { name?: string } | null)?.name !== 'NotAllowedError') return 'blocked';
  }
  element.muted = true;
  try {
    await element.play();
    return 'muted';
  } catch {
    element.muted = false;
    return 'blocked';
  }
}
