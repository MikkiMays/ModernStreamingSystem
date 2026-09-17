import { Menu } from '@base-ui/react/menu';
import { ChevronDown, SwitchCamera } from 'lucide-react';
import { useState } from 'react';
import type { Meeting } from '../core/meeting';
import { IconButton, useMediaQuery } from './primitives';

export function CameraMenu({ meeting }: { meeting: Meeting }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  /** Touch devices have a front and a back camera and no use for a list of device names. */
  const coarse = useMediaQuery('(pointer: coarse)');

  // A phone gets the gesture everyone already knows instead of a menu of opaque labels.
  if (coarse)
    return (
      <IconButton label="Перевернуть камеру" onClick={() => void meeting.media.flipCamera()}>
        <SwitchCamera size={21} />
      </IconButton>
    );

  return (
    <Menu.Root
      onOpenChange={(open) => {
        if (open)
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
