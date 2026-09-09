import { Menu } from '@base-ui/react/menu';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import type { Meeting } from '../core/meeting';
export function CameraMenu({ meeting }: { meeting: Meeting }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
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
            <Menu.Item onClick={() => void meeting.media.flipCamera()}>
              Переключить фронтальную / заднюю
            </Menu.Item>
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
