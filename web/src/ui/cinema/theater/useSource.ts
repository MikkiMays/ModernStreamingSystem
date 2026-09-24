import { useCallback, useEffect, useRef, useState } from 'react';
import type { Watch } from '../../../api/types';
import type { CinemaApi, CinemaSource } from '../../../core/cinema';
import type { Echo } from './useRoomSync';

export type Status = 'loading' | 'ready' | 'blocked' | 'failed';

/** Что открыто в комнате, одной строкой: сменилась она — значит, открыли другое. */
export const contentOf = (watch: Watch) => `${watch.provider}:${watch.kind}:${watch.contentId}`;

/**
 * Адрес потока: откуда его взять, когда обновить и что делать, когда он перестал открываться.
 *
 * Адрес подписан и живёт часы; за минуту до конца подписи он обновляется сам. Если отказали
 * раньше — HLS ответил 403/410, DASH споткнулся, файл не открылся, — адрес обновляется по отказу,
 * но не бесконечно: попытки считаются одним счётчиком на открытое видео, и у каждого пути свой
 * предел.
 *
 * `renewed` — что сбросить вместе с новым адресом, в той же отрисовке, что и сам адрес. Он обязан
 * быть стабильным: от него зависит обновление, а от обновления — таймер конца подписи.
 */
export function useSource(api: CinemaApi, watch: Watch, echo: Echo, renewed: () => void) {
  const [source, setSource] = useState<CinemaSource | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState('');
  const refreshing = useRef(false);
  const sourceGeneration = useRef(0);
  const renewals = useRef(0);
  const latest = useRef(watch);
  latest.current = watch;

  // Адрес потока спрашиваем у своего сервера — он единственный, кто ходит к площадке.
  const content = contentOf(watch);
  useEffect(() => {
    let alive = true;
    sourceGeneration.current++;
    renewals.current = 0;
    refreshing.current = false;
    setStatus('loading');
    setError('');
    setSource(null);
    const current = latest.current;
    void api
      .resolve(current.provider, current.contentId, current.kind)
      .then((resolved) => {
        if (alive) setSource(resolved);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setStatus('failed');
        setError((e as Error).message || 'Не удалось открыть видео');
      });
    return () => {
      alive = false;
      sourceGeneration.current++;
    };
  }, [api, content]);

  const renewSource = useCallback(
    async (adaptive = true) => {
      if (refreshing.current) return;
      refreshing.current = true;
      const generation = sourceGeneration.current;
      const current = latest.current;
      try {
        const resolved = await api.resolve(current.provider, current.contentId, current.kind, {
          adaptive,
          refresh: true,
        });
        if (generation !== sourceGeneration.current) return;
        echo.suppress();
        renewed();
        setStatus('loading');
        setSource(resolved);
      } catch (e) {
        if (generation === sourceGeneration.current) {
          setStatus('failed');
          setError((e as Error).message || 'Не удалось обновить поток');
        }
      } finally {
        if (generation === sourceGeneration.current) refreshing.current = false;
      }
    },
    [api, echo, renewed],
  );

  useEffect(() => {
    if (!source?.expiresAt) return;
    const timer = setTimeout(
      () => void renewSource(source.kind === 'dash'),
      Math.max(1000, source.expiresAt - Date.now() - 60000),
    );
    return () => clearTimeout(timer);
  }, [source, renewSource]);

  /** HLS: 403/410 — подпись протухла. Обновить, пока таких попыток не больше двух. */
  const expired = () => {
    if (renewals.current++ < 2) {
      void renewSource();
      return true;
    }
    return false;
  };

  /** DASH споткнулся. */
  const dashFailed = () => {
    if (refreshing.current) return;
    // Retry signed sources once, then use the compatible file rather than a retry loop.
    const adaptive = renewals.current++ === 0;
    void renewSource(adaptive);
  };

  /**
   * Готовый файл не открылся: один раз — с новой подписью, дальше — честный отказ.
   *
   * Подпись адреса меняется вместе со службой, и после её обновления старый адрес отвечает 403:
   * уже открытый файл так и стоял бы на «Поток не открылся» до перезагрузки страницы. HLS и
   * DASH переживали это и раньше — у них отказ приходит от движка. Попытка одна и только
   * первая: сломанный файл новая подпись не починит, а файл, до которого дошли после отказов
   * DASH, подписан только что. Вид адреса тот же (`adaptive: false`), что и у планового
   * обновления подписи файла.
   */
  const fileFailed = () => {
    if (renewals.current++ > 0) return false;
    void renewSource(false);
    return true;
  };

  return { source, status, setStatus, error, setError, renew: renewSource, expired, dashFailed, fileFailed };
}
