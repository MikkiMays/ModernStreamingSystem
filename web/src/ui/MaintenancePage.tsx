import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import { publicApi } from '../api/client';
import { formatEnd, maintenance, watchMaintenance, type ActiveMaintenance } from '../core/maintenance';
import { locale } from '../i18n';
import { CordMark, Logo } from './brand/Logo';
import { useStore } from './primitives';
import './maintenance.css';

/** Как часто страница сверяет обещанный срок с часами: «к 05:00» не должно висеть в 05:40. */
const CLOCK_MS = 15_000;

/**
 * Следит за окном технических работ (R194) и возвращает его, пока оно идёт. `onOver` — окно кончилось.
 * Один раз на вход приложения: `App` и Mini App Telegram.
 */
export function useMaintenance(onOver: () => void) {
  const state = useStore(maintenance);
  useEffect(() => watchMaintenance(() => publicApi.capabilities()), []);
  const shown = useRef(state !== null);
  useEffect(() => {
    if (shown.current && !state) onOver();
    shown.current = state !== null;
  });
  return state;
}

/**
 * Страница технических работ (R194, Р-95): браузер, клиент Windows, приложение Android и Mini App —
 * один код. Действий на ней нет: всё, что человек мог бы сделать, — подождать, и страница уйдёт сама.
 *
 * Лежит в основном бандле, а не ленивым чанком: она нужна как раз тогда, когда ядро перезапускают,
 * и у неё нет запросов к серверу, кроме опроса возможностей. Единственное украшение — дуги «Сигнала»
 * из угла, те же, что на плите «Новая встреча» главной; единственное движение — знак, который тихо
 * дышит, пока идёт работа (под `prefers-reduced-motion` стоит).
 */
export function MaintenancePage({ state }: { state: ActiveMaintenance }) {
  const { t } = useTranslation();
  const id = useId();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  const estimate =
    state.endsAt === null
      ? null
      : state.endsAt > now
        ? t(($) => $.maintenance.until, { time: formatEnd(state.endsAt, now, locale(t)) })
        : t(($) => $.maintenance.late);
  return (
    <div className="maintenance">
      <svg className="maintenance__arcs" viewBox="0 0 320 320" aria-hidden="true" focusable="false">
        <circle cx="320" cy="320" r="90" strokeOpacity="0.22" />
        <circle cx="320" cy="320" r="150" strokeOpacity="0.15" />
        <circle cx="320" cy="320" r="210" strokeOpacity="0.09" />
        <circle cx="320" cy="320" r="270" strokeOpacity="0.05" />
      </svg>
      <header className="maintenance__header">
        <Logo />
      </header>
      <main className="maintenance__main" aria-labelledby={`${id}-title`}>
        <CordMark size={56} className="maintenance__mark" />
        <h1 id={`${id}-title`}>{t(($) => $.maintenance.title)}</h1>
        <p className="maintenance__body">
          {state.endedMeeting ? t(($) => $.maintenance.endedMeeting) : t(($) => $.maintenance.body)}
        </p>
        <p className="maintenance__estimate" role="status">
          {estimate && (
            <>
              <Clock size={16} aria-hidden="true" />
              <span>{estimate}</span>
            </>
          )}
        </p>
      </main>
    </div>
  );
}
