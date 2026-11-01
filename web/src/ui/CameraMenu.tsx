import { SwitchCamera } from 'lucide-react';
import { useEffect, useState } from 'react';
import { TrackEvent } from 'livekit-client';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { locale, type Translate } from '../i18n';
import type { MediaTile } from '../media/session';
import {
  classifyCameras,
  lensesFor,
  readCameras,
  readZoom,
  zoomSteps,
  type CameraChoice,
  type Zoom,
} from '../media/cameras';
import { IconButton, Segmented } from './kit';

/**
 * Смена камеры на телефоне — одно нажатие, сразу другая сторона (T21).
 *
 * Здесь было меню: нажатие переворачивало камеру, а удержание открывало список линз. На деле
 * Base UI открывал список уже на касании, и человек получал и список, и перевёрнутую камеру
 * сразу. Теперь списка нет вовсе: кнопка меняет фронтальную на заднюю и обратно, а вторая линза
 * той же стороны — переключателем на своей плитке (`LensSwitch`).
 */
export function CameraFlip({ meeting, disabled }: { meeting: Meeting; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <IconButton
      tone="stage"
      size="lg"
      className="dock-button"
      label={t(($) => $.devices.camera.flip)}
      disabled={disabled}
      onClick={() => void meeting.media.flipCamera()}
    >
      <SwitchCamera size={24} />
    </IconButton>
  );
}

const zoomLabel = (t: Translate, factor: number) =>
  t(($) => $.devices.camera.zoomStep, { value: new Intl.NumberFormat(locale(t)).format(factor) });

/**
 * Зум своей камеры на своей плитке справа внизу, как в системной камере: «0.5× · 1× · 2×» (T21,
 * R36). «0.5×» — широкоугольная линза своей стороны (`lensesFor`) или зум, который умеет отдалить;
 * «1×» и «2×» — зум дорожки. Камера, которая не умеет ни того ни другого, переключателя не
 * получает; телефон со второй линзой без понятного множителя — прежние «1 / 2» линз.
 */
export function LensSwitch({ meeting, tile }: { meeting: Meeting; tile: MediaTile }) {
  const { t } = useTranslation();
  const [choices, setChoices] = useState<CameraChoice[]>([]);
  const [current, setCurrent] = useState<MediaTrackSettings>({});
  const [zoom, setZoom] = useState<Zoom | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () => {
      const media = tile.track.mediaStreamTrack;
      setCurrent(media?.getSettings() ?? {});
      setZoom(media ? readZoom(media) : null);
      void readCameras()
        .then((cameras) => alive && setChoices(classifyCameras(t, cameras)))
        .catch(() => {});
    };
    read();
    // Смена линзы и переворот пересобирают дорожку, а не плитку: узнать об этом можно только так.
    tile.track.on(TrackEvent.Restarted, read);
    navigator.mediaDevices?.addEventListener?.('devicechange', read);
    return () => {
      alive = false;
      tile.track.off(TrackEvent.Restarted, read);
      navigator.mediaDevices?.removeEventListener?.('devicechange', read);
    };
  }, [tile.track, t]);
  const lenses = lensesFor(choices, current);
  const steps = zoomSteps({ lenses, zoom });
  if (steps.length) {
    const active = steps.find((step) => step.active);
    return (
      <Segmented<number>
        size="sm"
        className="lens-switch lens-switch--zoom"
        aria-label={t(($) => $.devices.camera.zoom)}
        // 0 — ни одной ступени: зум стоит между ними (жест, чужая настройка), плашка не горит.
        value={active?.factor ?? 0}
        options={steps.map((step) => ({ value: step.factor, label: zoomLabel(t, step.factor) }))}
        onValueChange={(factor) => {
          const step = steps.find((candidate) => candidate.factor === factor);
          if (!step) return;
          if (step.deviceId) void meeting.media.switchDevice('videoinput', step.deviceId);
          else if (step.zoom !== undefined)
            void meeting.media.applyCameraZoom(step.zoom).then(() => {
              const media = tile.track.mediaStreamTrack;
              setZoom(media ? readZoom(media) : null);
            });
        }}
      />
    );
  }
  if (!lenses) return null;
  return (
    <div className="lens-switch" role="group" aria-label={t(($) => $.devices.camera.lenses)}>
      {lenses.map((lens) => (
        <button
          key={lens.deviceId}
          type="button"
          className="lens-switch__lens"
          aria-pressed={lens.active}
          aria-label={lens.label}
          title={lens.label}
          onClick={() => {
            if (!lens.active) void meeting.media.switchDevice('videoinput', lens.deviceId);
          }}
        >
          {lens.short}
        </button>
      ))}
    </div>
  );
}
