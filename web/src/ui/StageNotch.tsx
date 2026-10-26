import { useEffect, useRef, useState } from 'react';
import { Pause } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { knownProvider } from '../core/cinema/link';
import { targetPosition } from '../core/watch';
import { theaterVideo } from './cinema/theater/live-frame';
import { useMediaQuery, useStore } from './primitives';
import { integrationName, notchState } from './notch-state';
import { backToStage, STAGE_KEY_LABEL } from './stage-context';
import { ICONS } from './StageOverlay';
import { TurnRing } from './TurnRing';
import { useStageView } from './useStageView';
import './stage-notch.css';

/** Сколько раз в секунду обновляется кадр фильма в чёлке; под `reduce` — раз в две секунды. */
const FRAME_MS = 250;
const FRAME_CALM_MS = 2000;

/**
 * Чёлка (R121): интеграция, от которой зритель ушёл к участникам, — сверху по центру сцены.
 *
 * Владелец 25.10: «будет сверху как раз челка с активным плеером или текущей активной интеграцией, на
 * которую можно всегда зайти». Видна, пока интеграция идёт, а зритель не в ней: в сетке, в «Говорящем» и
 * поверх чужого экрана. Одна строка — имя и живое состояние (кинозал — кадр, название и время; игра —
 * сколько за столом или «Ваш ход» с кольцом хода; рисование — кто рисует). Нажатие — назад в интеграцию,
 * фокус — на «Участники» в её шапке, чтобы тем же путём можно было снова выйти.
 *
 * Свисает от верхнего края сцены, как вырез: в разговоре над плитками, а не поверх них.
 */
export function StageNotch({ meeting }: { meeting: Meeting }) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const catalog = useStore(meeting.cinema);
  const video = useStore(theaterVideo);
  const { occupant, view } = useStageView(meeting);
  const shown = !!occupant && view === 'people';
  const watch = snapshot.watch;
  // Время фильма идёт — чёлка перерисовывается раз в секунду, и только пока она видна и фильм не стоит.
  const ticking = shown && !!watch && !watch.paused && watch.kind !== 'channel';
  const [, tick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  if (!shown || !occupant) return null;
  // Свой плеер знает конец ролика; якорь комнаты — запасной, пока плеер не готов.
  const position =
    video && video.readyState > 0 && Number.isFinite(video.currentTime)
      ? video.currentTime * 1000
      : watch
        ? targetPosition(watch, meeting.serverNow())
        : 0;
  const state = notchState(
    t,
    snapshot,
    meeting.admission.participantId,
    position,
    !!catalog && knownProvider(catalog),
  );
  if (!state) return null;
  const integration = integrationName(t, state.kind);
  const spoken = [
    state.name === integration ? null : state.name,
    state.status,
    state.paused ? t(($) => $.stage.notch.paused) : null,
  ]
    .filter(Boolean)
    .join(', ');
  const Icon = ICONS[state.kind];
  return (
    <button
      type="button"
      className="stage-notch media-stage"
      data-stage-notch=""
      data-kind={state.kind}
      data-turn={state.turn ? 'true' : undefined}
      aria-label={
        spoken
          ? t(($) => $.stage.notch.back, { integration, state: spoken })
          : t(($) => $.stage.notch.backPlain, { integration })
      }
      aria-keyshortcuts={STAGE_KEY_LABEL}
      title={t(($) => $.stage.notch.title, { key: STAGE_KEY_LABEL })}
      onClick={() => backToStage(meeting)}
    >
      {state.film && video ? (
        <NotchFrame video={video} />
      ) : (
        <span className="stage-notch__mark" aria-hidden="true">
          <Icon />
          {state.ring && (
            <TurnRing meeting={meeting} actionAt={state.ring.actionAt} deadline={state.ring.deadline} />
          )}
        </span>
      )}
      <span className="stage-notch__text" aria-hidden="true">
        <b className="stage-notch__name">{state.name}</b>
        {state.status && (
          <span className="stage-notch__status">
            {state.paused && <Pause className="stage-notch__paused" />}
            {state.live && <i className="stage-notch__live" />}
            {state.status}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * Живой кадр фильма — тот же `<video>`, что идёт спрятанным, перерисованный в холст 56×32. Второй поток
 * не нужен: кадры декодирует уже идущий плеер, холст лишь копирует его несколько раз в секунду.
 */
function NotchFrame({ video }: { video: HTMLVideoElement }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const calm = useMediaQuery('(prefers-reduced-motion: reduce)');
  useEffect(() => {
    const node = canvas.current;
    const context = node?.getContext('2d');
    if (!node || !context) return;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    node.width = Math.round(node.clientWidth * scale) || 112;
    node.height = Math.round(node.clientHeight * scale) || 64;
    const draw = () => {
      if (document.hidden || video.readyState < 2 || !video.videoWidth) return;
      // Вписать с обрезкой по краям, как `object-fit: cover`: кадр любой формы — во всю плашку.
      const fit = Math.max(node.width / video.videoWidth, node.height / video.videoHeight);
      const width = node.width / fit;
      const height = node.height / fit;
      try {
        context.drawImage(
          video,
          (video.videoWidth - width) / 2,
          (video.videoHeight - height) / 2,
          width,
          height,
          0,
          0,
          node.width,
          node.height,
        );
      } catch {
        // Кадра ещё нет (смена потока) — останется прежний.
      }
    };
    draw();
    const timer = setInterval(draw, calm ? FRAME_CALM_MS : FRAME_MS);
    return () => clearInterval(timer);
  }, [video, calm]);
  return <canvas ref={canvas} className="stage-notch__frame" aria-hidden="true" />;
}
