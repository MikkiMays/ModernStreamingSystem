import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../../core/meeting';
import type { Preferences } from '../../core/preferences';

type Change = (patch: Partial<Preferences>) => Promise<void>;

/** Устройства, которые видит браузер, — и снова, когда что-то подключили или вынули. */
export function useMediaDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then((list) => {
          if (active) setDevices(list);
        })
        .catch(() => {});
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener('devicechange', refresh);
    };
  }, []);
  return devices;
}

const DEVICE_KEY = { audioinput: 'microphone', videoinput: 'camera', audiooutput: 'speaker' } as const;

/**
 * Выбор устройства. Во встрече — сразу переключение захвата (`switchDevice`), вне встречи — запись
 * в профиль устройства. Вывод звука в браузере без `setSinkId` выбрать нельзя — список выключен и
 * объясняет почему.
 *
 * `shown` — устройство, которое работает на самом деле, если оно не то, что записано: превью камеры на
 * телефоне открывается фронтальной, а не запомненной (Р-35), и список не должен говорить другое.
 */
export function DeviceSelect({
  kind,
  label,
  devices,
  preferences,
  change,
  meeting,
  className,
  shown,
  onPick,
}: {
  kind: MediaDeviceKind;
  label: string;
  devices: MediaDeviceInfo[];
  preferences: Preferences;
  change: Change;
  meeting?: Meeting;
  className?: string;
  shown?: string;
  /** Устройство выбрали в списке руками. */
  onPick?: (deviceId: string) => void;
}) {
  const { t } = useTranslation();
  const key = DEVICE_KEY[kind];
  const unsupported = kind === 'audiooutput' && !('setSinkId' in HTMLMediaElement.prototype);
  return (
    <select
      className={`ui-input ui-select setting-select${className ? ` ${className}` : ''}`}
      aria-label={label}
      value={shown ?? preferences.devices[key] ?? ''}
      disabled={unsupported}
      title={unsupported ? t(($) => $.settings.voice.systemOutputOnly) : undefined}
      onChange={(e) => {
        onPick?.(e.target.value);
        if (meeting) void meeting.media.switchDevice(kind, e.target.value);
        else void change({ devices: { ...preferences.devices, [key]: e.target.value } });
      }}
    >
      <option value="">{t(($) => $.settings.voice.defaultDevice)}</option>
      {devices
        .filter((device) => device.kind === kind && device.deviceId)
        .map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || t(($) => $.settings.voice.device, { number: index + 1 })}
          </option>
        ))}
    </select>
  );
}
