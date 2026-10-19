import { Check, SwitchCamera, Video } from 'lucide-react';
import { useEffect, useState } from 'react';
import { TrackEvent } from 'livekit-client';
import type { Meeting } from '../core/meeting';
import type { MediaTile } from '../media/session';
import { classifyCameras, lensesFor, readCameras, type CameraChoice } from '../media/cameras';
import { IconButton, MenuItem, MenuSeparator, MenuSubmenu } from './kit';
import { useStore } from './primitives';

/** Строки камеры — в одном месте, до слоя переводов (E14). */
const TEXT = {
  flip: 'Сменить камеру',
  camera: 'Камера',
  next: 'Следующая камера',
  numbered: (index: number) => `Камера ${index + 1}`,
  lenses: 'Линза камеры',
};

/**
 * Смена камеры на телефоне — одно нажатие, сразу другая сторона (T21).
 *
 * Здесь было меню: нажатие переворачивало камеру, а удержание открывало список линз. На деле
 * Base UI открывал список уже на касании, и человек получал и список, и перевёрнутую камеру
 * сразу. Теперь списка нет вовсе: кнопка меняет фронтальную на заднюю и обратно, а вторая линза
 * той же стороны — переключателем на своей плитке (`LensSwitch`).
 */
export function CameraFlip({ meeting, disabled }: { meeting: Meeting; disabled?: boolean }) {
  return (
    <IconButton
      tone="stage"
      size="lg"
      className="dock-button"
      label={TEXT.flip}
      disabled={disabled}
      onClick={() => void meeting.media.flipCamera()}
    >
      <SwitchCamera size={22} />
    </IconButton>
  );
}

/**
 * Выбор камеры на компьютере — подменю «Камера» в «ещё» (T21).
 *
 * Стрелки справа от кнопки камеры больше нет: она занимала место в пульте ради действия, которое
 * делают раз в жизни устройства. Список — здесь и в «Голос и видео» в настройках.
 */
export function CameraSubmenu({ meeting }: { meeting: Meeting }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const chosen = useStore(meeting.media.preferences).devices.camera;
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
  return (
    <MenuSubmenu icon={<Video />} label={TEXT.camera}>
      <MenuItem icon={<SwitchCamera />} onClick={() => void meeting.media.flipCamera()}>
        {TEXT.next}
      </MenuItem>
      {devices.length > 0 && <MenuSeparator />}
      {devices.map((device, index) => (
        <MenuItem
          key={device.deviceId || index}
          icon={device.deviceId && device.deviceId === chosen ? <Check /> : undefined}
          onClick={() => void meeting.media.switchDevice('videoinput', device.deviceId)}
        >
          {device.label || TEXT.numbered(index)}
        </MenuItem>
      ))}
    </MenuSubmenu>
  );
}

/**
 * Линзы своей стороны — на своей плитке справа внизу, как в системной камере: «0.5× / 1×» (T21).
 *
 * Только когда устройство само сообщило о второй линзе на стороне, куда камера смотрит сейчас
 * (`lensesFor`): настольная камера, фронтальная с одной линзой или телефон, не назвавший камер,
 * переключателя не получают.
 */
export function LensSwitch({ meeting, tile }: { meeting: Meeting; tile: MediaTile }) {
  const [choices, setChoices] = useState<CameraChoice[]>([]);
  const [current, setCurrent] = useState<MediaTrackSettings>({});
  useEffect(() => {
    let alive = true;
    const read = () => {
      setCurrent(tile.track.mediaStreamTrack?.getSettings() ?? {});
      void readCameras()
        .then((cameras) => alive && setChoices(classifyCameras(cameras)))
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
  }, [tile.track]);
  const lenses = lensesFor(choices, current);
  if (!lenses) return null;
  return (
    <div className="lens-switch" role="group" aria-label={TEXT.lenses}>
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
