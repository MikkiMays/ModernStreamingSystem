import { useEffect, useState } from 'react';
import type { Meeting } from '../core/meeting';
import { readPreferences } from '../core/preferences';
import { Store } from '../core/store';
import { useStore } from './primitives';
const noPing = new Store<number | null>(null);
const noControl = new Store('closed');
export function Ping({ meeting }: { meeting?: Meeting | null }) {
  const [enabled, setEnabled] = useState(() => readPreferences().showPing);
  const [http, setHttp] = useState<number | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);
  const rtt = useStore(meeting?.control.ping ?? noPing);
  const control = useStore(meeting?.control.state ?? noControl);
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
  return (
    <div
      className="ping-badge"
      role="status"
      title={meeting ? 'RTT управляющего WebSocket' : 'Время ответа сервера /api/v1/ping'}
    >
      PING · {disconnected ? 'Нет связи' : value === null ? '—' : `${value} мс`}
    </div>
  );
}
