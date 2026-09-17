import { Menu } from '@base-ui/react/menu';
import { ChevronDown, SwitchCamera } from 'lucide-react';
import { useRef, useState } from 'react';
import type { Meeting } from '../core/meeting';
import { classifyCameras, readCameras, type CameraChoice } from '../media/cameras';
import { IconButton, useMediaQuery } from './primitives';

/** Сколько держать палец, чтобы это считалось «открыть список», а не «перевернуть». */
const HOLD_MS = 450;

export function CameraMenu({ meeting }: { meeting: Meeting }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [choices, setChoices] = useState<CameraChoice[]>([]);
  const [open, setOpen] = useState(false);
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Touch devices have a front and a back camera and no use for a list of device names. */
  const coarse = useMediaQuery('(pointer: coarse)');

  /**
   * На телефоне нажатие — переворот, удержание — список линз.
   *
   * Переворот нужен постоянно и обязан остаться одним касанием. Широкоугольная нужна редко и
   * прячется за удержанием — жестом, который ничего не стоит тому, кто о нём не знает. Тот же
   * список продублирован пунктом в меню «⋯»: жест сам себя не объявляет.
   */
  if (coarse) {
    const cancel = () => {
      clearTimeout(timer.current);
      timer.current = undefined;
    };
    return (
      <Menu.Root open={open} onOpenChange={setOpen}>
        <Menu.Trigger
          render={
            <IconButton
              label="Перевернуть камеру. Удержание — выбрать линзу"
              onPointerDown={() => {
                held.current = false;
                void readCameras()
                  .then((cameras) => setChoices(classifyCameras(cameras)))
                  .catch(() => setChoices([]));
                timer.current = setTimeout(() => {
                  held.current = true;
                  setOpen(true);
                }, HOLD_MS);
              }}
              onPointerUp={() => {
                cancel();
                if (!held.current) void meeting.media.flipCamera();
              }}
              onPointerCancel={cancel}
              onPointerLeave={cancel}
              // Нажатие уже обработано на отпускании пальца; иначе переворот случился бы дважды.
              onClick={(event) => event.preventDefault()}
            >
              <SwitchCamera size={21} />
            </IconButton>
          }
        />
        <Menu.Portal>
          <Menu.Positioner side="top" sideOffset={12}>
            <Menu.Popup className="action-menu">
              {choices.length ? (
                choices.map((choice) => (
                  <Menu.Item
                    key={choice.deviceId}
                    onClick={() => void meeting.media.switchDevice('videoinput', choice.deviceId)}
                  >
                    {choice.label}
                  </Menu.Item>
                ))
              ) : (
                // Имена камер выдаются только после разрешения, поэтому до включения камеры
                // списка честно нет — и это лучше, чем «Камера 1, Камера 2, Камера 3».
                <Menu.Item disabled>Включите камеру, чтобы выбрать линзу</Menu.Item>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    );
  }

  return (
    <Menu.Root
      onOpenChange={(shown) => {
        if (shown)
          void navigator.mediaDevices
            .enumerateDevices()
            .then(setDevices)
            .catch((e) => meeting.media.report(e));
      }}
    >
      <Menu.Trigger className="icon-button camera-menu-trigger" aria-label="Выбрать камеру">
        <ChevronDown size={15} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" sideOffset={12}>
          <Menu.Popup className="action-menu">
            <Menu.Item onClick={() => void meeting.media.flipCamera()}>Следующая камера</Menu.Item>
            {devices
              .filter((d) => d.kind === 'videoinput')
              .map((device, index) => (
                <Menu.Item
                  key={device.deviceId || index}
                  onClick={() => void meeting.media.switchDevice('videoinput', device.deviceId)}
                >
                  {device.label || `Камера ${index + 1}`}
                </Menu.Item>
              ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * Тот же выбор линзы, но пунктами меню.
 *
 * Удержание кнопки — жест без подписи, и рассчитывать, что о нём догадаются, нельзя. Здесь он
 * назван словами, в том же меню, где остальное, что не влезло в панель телефона.
 */
export function CameraChoices({ meeting }: { meeting: Meeting }) {
  const [choices, setChoices] = useState<CameraChoice[]>([]);
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    void readCameras()
      .then((cameras) => setChoices(classifyCameras(cameras)))
      .catch(() => setChoices([]));
  }
  return (
    <>
      {choices.map((choice) => (
        <Menu.Item
          key={choice.deviceId}
          onClick={() => void meeting.media.switchDevice('videoinput', choice.deviceId)}
        >
          <SwitchCamera size={18} /> {choice.label}
        </Menu.Item>
      ))}
    </>
  );
}
