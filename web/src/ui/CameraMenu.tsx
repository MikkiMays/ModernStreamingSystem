import { BackgroundSubmenu } from './BackgroundPicker';
import { Check, SwitchCamera, Video, ZoomIn } from 'lucide-react';
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
import {
  IconButton,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSubmenu,
  Segmented,
} from './kit';
import { useStore } from './primitives';

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

/**
 * Выбор камеры на компьютере — подменю «Камера» в «ещё» (T21).
 *
 * Стрелки справа от кнопки камеры больше нет: она занимала место в пульте ради действия, которое
 * делают раз в жизни устройства. Список — здесь и в «Голос и видео» в настройках. «Следующей
 * камеры» здесь нет (R35): список и так показывает все камеры, а перебор вслепую — дело кнопки
 * переворота на телефоне. Камер нет — пункт выключен и говорит об этом, а не открывает пустоту.
 */
export function CameraSubmenu({ meeting }: { meeting: Meeting }) {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const preferences = useStore(meeting.media.preferences);
  const chosen = preferences.devices.camera;
  const background = preferences.background;
  // Подменю живёт, пока открыто «ещё»: список читается при каждом открытии — камеру могли
  // подключить между ними.
  useEffect(() => {
    let alive = true;
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => alive && setDevices(all.filter((device) => device.kind === 'videoinput')))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (devices && !devices.length)
    return (
      <MenuItem icon={<Video />} disabled>
        {t(($) => $.devices.camera.none)}
      </MenuItem>
    );
  return (
    <MenuSubmenu icon={<Video />} label={t(($) => $.devices.camera.title)}>
      <MenuRadioGroup
        value={chosen}
        onValueChange={(deviceId: string) => void meeting.media.switchDevice('videoinput', deviceId)}
      >
        {(devices ?? []).map((device, index) => (
          <MenuRadioItem
            key={device.deviceId || index}
            value={device.deviceId}
            closeOnClick
            className="ui-menu__item"
          >
            <span className="ui-menu__icon" aria-hidden="true">
              {device.deviceId && device.deviceId === chosen && <Check />}
            </span>
            <span className="ui-menu__label">
              {device.label || t(($) => $.devices.camera.numbered, { n: index + 1 })}
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuZoom meeting={meeting} />
      <MenuSeparator />
      {/* Фон в видео (R153) — на лету, без переопубликации камеры. */}
      <BackgroundSubmenu
        value={background}
        onChange={(choice) => meeting.media.saveSettings({ background: choice })}
      />
    </MenuSubmenu>
  );
}

const zoomLabel = (t: Translate, factor: number) =>
  t(($) => $.devices.camera.zoomStep, { value: new Intl.NumberFormat(locale(t)).format(factor) });

/**
 * «Зум 0.5× · 1× · 2×» под списком камер (R36): сегментом из пунктов-радио меню — стрелки ходят
 * по ним, как по остальным пунктам, щелчок меню не закрывает (видно, что поменялось). Ступени —
 * только те, что камера умеет (`zoomSteps`); у камеры без зума строки нет вовсе.
 */
function MenuZoom({ meeting }: { meeting: Meeting }) {
  const { t } = useTranslation();
  const [zoom, setZoom] = useState(() => meeting.media.cameraZoom());
  const steps = zoomSteps({ lenses: null, zoom });
  if (!steps.length) return null;
  const active = steps.find((step) => step.active);
  return (
    <>
      <MenuSeparator />
      <MenuRadioGroup
        className="camera-zoom"
        aria-label={t(($) => $.devices.camera.zoom)}
        value={active ? String(active.factor) : ''}
        onValueChange={(value: string) => {
          const step = steps.find((candidate) => String(candidate.factor) === value);
          if (step?.zoom === undefined) return;
          void meeting.media.applyCameraZoom(step.zoom).then(() => setZoom(meeting.media.cameraZoom()));
        }}
      >
        <span className="camera-zoom__label" aria-hidden="true">
          <ZoomIn />
          {t(($) => $.devices.camera.zoom)}
        </span>
        <span className="camera-zoom__steps">
          {steps.map((step) => (
            <MenuRadioItem
              key={step.factor}
              value={String(step.factor)}
              closeOnClick={false}
              className="camera-zoom__step"
            >
              {zoomLabel(t, step.factor)}
            </MenuRadioItem>
          ))}
        </span>
      </MenuRadioGroup>
    </>
  );
}

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
