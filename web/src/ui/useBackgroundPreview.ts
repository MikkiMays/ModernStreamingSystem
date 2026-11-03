import { useEffect, useState } from 'react';
import { allowed, backgroundSupport, type BackgroundChoice } from '../media/background-effect';

let supported: Promise<Awaited<ReturnType<typeof backgroundSupport>>> | null = null;

/**
 * Обработанная дорожка для превью (R186): предвход и «Видео» в настройках показывают выбранный фон
 * вживую на своём захвате, как Meet и Телемост, — а не «во встрече увидите». Движок — общий для страницы
 * (`BackgroundEffect.shared()`): тот же, что потом возьмёт встреча, модель грузится один раз.
 *
 * Без выбора, без дорожки или где фон нельзя — `null`: показывать сырую дорожку. Смена выбора при той же
 * дорожке переключает фон на лету, не пересобирая потоки (снятие — ленивое, через такт).
 */
export function useBackgroundPreview(
  track: MediaStreamTrack | null | undefined,
  choice: BackgroundChoice,
): MediaStreamTrack | null {
  const [processed, setProcessed] = useState<{ source: MediaStreamTrack; output: MediaStreamTrack } | null>(
    null,
  );
  const key = JSON.stringify(choice);
  useEffect(() => {
    if (!track || choice.kind === 'none') {
      setProcessed(null);
      return;
    }
    let alive = true;
    const effect = import('../media/background/effect').then((m) => m.BackgroundEffect.shared());
    void (async () => {
      supported ??= backgroundSupport();
      const support = await supported;
      if (!alive || !allowed(choice, support)) return;
      const engine = await effect;
      if (!alive) return;
      engine.onReplaced = (source, output) => alive && source === track && setProcessed({ source, output });
      const output = await engine.attach(track, choice, support);
      if (alive) setProcessed({ source: track, output });
    })().catch((error) => console.warn('[cord] background preview failed', error));
    return () => {
      alive = false;
      void effect.then((engine) => engine.detach(track, true));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- выбор сравнивается по содержимому (`key`)
  }, [track, key]);
  return processed && processed.source === track ? processed.output : null;
}
