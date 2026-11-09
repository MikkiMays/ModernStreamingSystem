import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { readPreferences } from '../core/preferences';
import { Store } from '../core/store';
import type { OutboundVideo } from '../media/session';
import { outboundNote } from '../media/outbound-note';
import { useStore } from './primitives';
import { useServerLoad } from '../core/server-load';
import { LoadBars } from './kit/LoadBars';
import { manualNode } from '../core/node-choice';
import { unknownLink, type LinkState } from '../media/link-quality';
import { nodeProbe } from '../media/node-probe';
import { locale } from '../i18n';
const noControl = new Store('closed');
const noVideo = new Store<OutboundVideo | null>(null);
const noLink = new Store<LinkState>(unknownLink);

/**
 * До какого узла мерить на главной: тот, через который пойдёт новая встреча, — выбранный руками или последний
 * выбор замера (`nodeProbe`). Узел один или ещё не выбран — `null`: меряется сам сервер.
 */
function nextNode() {
  const nodes = nodeProbe.known();
  if (nodes.length <= 1) return null;
  const id = manualNode.get() ?? nodeProbe.last()?.node ?? null;
  return nodes.find((node) => node.id === id) ?? null;
}

/** Один запрос и его время; `null` — не ответил за `budgetMs` или страница ушла (`outer`). */
async function timed(
  url: string,
  outer: AbortSignal,
  budgetMs: number,
  cors: boolean,
): Promise<number | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outer.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, budgetMs);
  const at = performance.now();
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      ...(cors ? { mode: 'cors' as const, credentials: 'omit' as const } : {}),
    });
    if (!response.ok) return null;
    await response.arrayBuffer();
    return Math.round(performance.now() - at);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', abort);
  }
}

/**
 * PING и что происходит с картинкой на самом деле — строкой в потоке (R20): на главной — в подвале,
 * во встрече — в строке о встрече рядом с кодом. Раньше это была плашка `fixed` в левом верхнем углу,
 * и на главной она лежала поверх марки.
 *
 *
 * ЧТО ЗНАЧИТ ЧИСЛО (владелец 09.11: «я в Москве, нода московская, а пинг 50»). Во встрече — оборот до медиаузла
 * встречи по WebRTC (`media.link`, выбранная пара ICE): звук и видео идут прямо на узел, а не через ядро, и
 * задержку разговора определяет именно он. Управляющий канал до ядра (`control.ping`) задержку разговора не
 * меняет — ядро стоит в одном месте, и его число не менялось бы ни от узла, ни от переезда встречи; от него
 * осталось только «Нет связи». На главной — время ответа узла, через который пойдёт новая встреча; узел не
 * ответил или он один — самого сервера, как раньше.
 *
 * Плашка показывала один PING. Настройки при этом обещали 1440p и 60 кадров, а камера могла
 * отдавать 1080p и сорок — и узнать об этом было неоткуда, кроме как открыть диагностику и
 * поверить, что смотришь в нужную строку. Теперь рядом с задержкой стоят те же три числа,
 * которые человек выставлял: размер кадра, частота и мегабиты. Числа измеренные, а не
 * запрошенные; если они не сходятся с настройкой — это и есть ответ.
 */
export function Ping({ meeting }: { meeting?: Meeting | null }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(() => readPreferences().showPing);
  const [http, setHttp] = useState<number | null>(null);
  /** Узел, до которого намерено `http`; `null` — намерен сам сервер. */
  const [measured, setMeasured] = useState<string | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);
  const link = useStore(meeting?.media.link ?? noLink);
  const control = useStore(meeting?.control.state ?? noControl);
  const video = useStore(meeting?.media.outbound ?? noVideo);
  const load = useServerLoad(enabled && !meeting);
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
      const current = (request = new AbortController());
      try {
        const node = nextNode();
        const url = node ? `${node.probeUrl.replace(/\/+$/, '')}/api/v1/ping` : null;
        let ms = url ? await timed(url, current.signal, 900, true) : null;
        const target = ms === null ? null : node!.id;
        if (ms === null && !current.signal.aborted)
          ms = await timed('/api/v1/ping', current.signal, 1800, false);
        if (disposed) return;
        setHttp(ms);
        setMeasured(target);
        setOffline(ms === null);
      } finally {
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
  const value = meeting ? (link.rttMs === null ? null : Math.round(link.rttMs)) : http;
  const note = video ? outboundNote(t, video) : '';
  return (
    <div
      className="ping-badge"
      role="status"
      title={
        video
          ? video.source === 'screen'
            ? t(($) => $.media.ping.screenTitle)
            : t(($) => $.media.ping.cameraTitle)
          : meeting
            ? t(($) => $.media.ping.controlTitle)
            : measured
              ? t(($) => $.media.ping.nodeTitle, { node: nodeProbe.title(measured, locale(t)) })
              : t(($) => $.media.ping.httpTitle)
      }
    >
      PING ·{' '}
      {disconnected
        ? t(($) => $.media.ping.offline)
        : value === null
          ? '—'
          : t(($) => $.media.ping.ms, { value })}
      {/* Загрузка сервера (R143) — на главной, рядом с пингом; во встрече она ничего не меняет. */}
      {/* Разделитель — стилем (`.ping-load::before`): текст пинга остаётся прежним для чтения и тестов. */}
      {!meeting && load && !disconnected && (
        <LoadBars className="ping-load" level={load.level} state={load.state} />
      )}
      {video && video.width > 0 && (
        <>
          {' · '}
          {video.width}×{video.height}
          {' · '}
          {video.fps} fps
          {video.mbps > 0 && ` · ${t(($) => $.media.ping.mbps, { value: video.mbps.toFixed(1) })}`}
          {note && <span className="ping-limited"> · {note}</span>}
        </>
      )}
    </div>
  );
}
