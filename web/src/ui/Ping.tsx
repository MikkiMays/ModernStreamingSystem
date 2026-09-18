import { useEffect, useState } from 'react';
import type { Meeting } from '../core/meeting';
import { readPreferences } from '../core/preferences';
import { Store } from '../core/store';
import type { OutboundVideo } from '../media/session';
import { outboundNote } from '../media/outbound-note';
import { useStore } from './primitives';
const noPing = new Store<number | null>(null);
const noControl = new Store('closed');
const noVideo = new Store<OutboundVideo | null>(null);

/**
 * Что происходит с картинкой на самом деле.
 *
 * Плашка показывала один PING. Настройки при этом обещали 1440p и 60 кадров, а камера могла
 * отдавать 1080p и сорок — и узнать об этом было неоткуда, кроме как открыть диагностику и
 * поверить, что смотришь в нужную строку. Теперь рядом с задержкой стоят те же три числа,
 * которые человек выставлял: размер кадра, частота и мегабиты. Числа измеренные, а не
 * запрошенные; если они не сходятся с настройкой — это и есть ответ.
 */
export function Ping({ meeting }: { meeting?: Meeting | null }) {
  const [enabled, setEnabled] = useState(() => readPreferences().showPing);
  const [http, setHttp] = useState<number | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);
  const rtt = useStore(meeting?.control.ping ?? noPing);
  const control = useStore(meeting?.control.state ?? noControl);
  const video = useStore(meeting?.media.outbound ?? noVideo);
  useEffect(() => {
    const change = () => setEnabled(readPreferences().showPing);
    window.addEventListener('cord:preferences', change);
    return () => window.removeEventListener('cord:preferences', change);
  }, []);
  useEffect(() => {
    if (!enabled || meeting) return;
    let request: AbortController | undefined;
    let disposed = false;
    const measure = async () => {
      if (document.hidden || request) return;
      request = new AbortController();
      const at = performance.now();
      const timeout = setTimeout(() => request?.abort(), 1800);
      try {
        const response = await fetch('/api/v1/ping', { cache: 'no-store', signal: request.signal });
        if (!response.ok) throw new Error();
        await response.arrayBuffer();
        if (!disposed) {
          setHttp(Math.round(performance.now() - at));
          setOffline(false);
        }
      } catch {
        if (!disposed) {
          setHttp(null);
          setOffline(true);
        }
      } finally {
        clearTimeout(timeout);
        request = undefined;
      }
    };
    void measure();
    const timer = setInterval(() => void measure(), 2000);
    const visible = () => void measure();
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      clearInterval(timer);
      request?.abort();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [enabled, meeting]);
  if (!enabled) return null;
  const disconnected = meeting ? control === 'recovering' || control === 'closed' : offline;
  const value = meeting ? rtt : http;
  const note = video ? outboundNote(video) : '';
  return (
    <div
      className="ping-badge"
      role="status"
      title={
        video
          ? `Задержка управляющего канала и то, что уходит в сеть с ${video.source === 'screen' ? 'экрана' : 'камеры'}`
          : meeting
            ? 'RTT управляющего WebSocket'
            : 'Время ответа сервера /api/v1/ping'
      }
    >
      PING · {disconnected ? 'Нет связи' : value === null ? '—' : `${value} мс`}
      {video && video.width > 0 && (
        <>
          {' · '}
          {video.width}×{video.height}
          {' · '}
          {video.fps} fps
          {video.mbps > 0 && ` · ${video.mbps.toFixed(1)} Мбит/с`}
          {note && <span className="ping-limited"> · {note}</span>}
        </>
      )}
    </div>
  );
}
