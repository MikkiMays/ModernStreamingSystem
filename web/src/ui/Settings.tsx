import { useEffect, useState } from 'react';
import { Camera, MonitorUp } from 'lucide-react';
import type { Meeting } from '../core/meeting';
import { automaticProfile } from '../core/preferences';
import type { ScreenProfile, FrameRate, Resolution } from '../media/profiles';
import { Modal, useStore } from './primitives';

export function QualityFields({
  kind,
  profile,
  change,
}: {
  kind: 'screen' | 'camera';
  profile: ScreenProfile;
  change: (next: ScreenProfile) => void;
}) {
  const title = kind === 'screen' ? 'Демонстрация экрана' : 'Видео с камеры';
  const label = kind === 'screen' ? 'Экран' : 'Камера';
  return (
    <section className="quality-section" aria-label={title}>
      <h3>
        {kind === 'screen' ? <MonitorUp size={19} /> : <Camera size={19} />}
        {title}
      </h3>
      <div className="settings-row">
        <label>
          Качество
          <select
            aria-label={label + ': качество'}
            value={profile.automatic ? 'auto' : profile.resolution}
            onChange={(e) =>
              change({
                ...profile,
                resolution:
                  e.target.value === 'auto'
                    ? automaticProfile(kind).resolution
                    : (Number(e.target.value) as Resolution),
                automatic: e.target.value === 'auto',
              })
            }
          >
            <option value="auto">Авто</option>
            <option value="720">720p · HD</option>
            <option value="1080">1080p · Full HD</option>
            <option value="1440">1440p · QHD</option>
          </select>
        </label>
        <label>
          Плавность
          <select
            aria-label={label + ': частота кадров'}
            value={profile.automaticFps !== false ? 'auto' : profile.fps}
            onChange={(e) =>
              change({
                ...profile,
                fps: e.target.value === 'auto' ? 30 : (Number(e.target.value) as FrameRate),
                automaticFps: e.target.value === 'auto',
              })
            }
          >
            <option value="auto">Авто · до 30 fps</option>
            <option value="15">15 fps</option>
            <option value="30">30 fps</option>
            <option value="60">60 fps · плавнее</option>
          </select>
        </label>
      </div>
      {kind === 'screen' && (
        <fieldset className="mode-selector">
          <legend>Что показываете?</legend>
          {(['text', 'motion'] as const).map((mode) => (
            <label key={mode} data-active={profile.mode === mode}>
              <input
                type="radio"
                name="screen-mode"
                checked={profile.mode === mode}
                onChange={() => change({ ...profile, mode })}
              />
              <strong>{mode === 'text' ? 'Текст и работа' : 'Видео и движение'}</strong>
              <span>{mode === 'text' ? 'Чёткие детали' : 'Плавная картинка'}</span>
            </label>
          ))}
        </fieldset>
      )}
      <p className="form-footnote">
        {!profile.automatic
          ? `Запрошено ${profile.resolution}p. Фактическое качество зависит от источника и сети.`
          : kind === 'screen'
            ? 'Авто ограничивает экран до 1080p; сеть может снижать качество.'
            : 'Авто начинает с 720p и адаптируется к сети.'}
      </p>
    </section>
  );
}
export function Settings({
  meeting,
  open,
  onOpenChange,
}: {
  meeting: Meeting;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const preferences = useStore(meeting.media.preferences);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (!open) return;
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
  }, [open]);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Настроить под себя"
      description="Настройки сохраняются на этом устройстве и применяются к следующим встречам."
    >
      <div className="settings-form">
        <QualityFields
          kind="camera"
          profile={preferences.camera}
          change={(p) => void meeting.media.setCameraProfile(p)}
        />
        <QualityFields
          kind="screen"
          profile={preferences.screen}
          change={(p) => void meeting.media.setProfile(p)}
        />
        <h3>Устройства</h3>
        {(['audioinput', 'videoinput', 'audiooutput'] as const).map((kind) => (
          <label key={kind}>
            {kind === 'audioinput' ? 'Микрофон' : kind === 'videoinput' ? 'Камера' : 'Вывод звука'}
            <select
              value={
                preferences.devices[
                  kind === 'audioinput' ? 'microphone' : kind === 'videoinput' ? 'camera' : 'speaker'
                ] ?? ''
              }
              disabled={kind === 'audiooutput' && !('setSinkId' in HTMLMediaElement.prototype)}
              onChange={(e) => void meeting.media.switchDevice(kind, e.target.value)}
            >
              <option value="">По умолчанию</option>
              {devices
                .filter((d) => d.kind === kind && d.deviceId)
                .map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Устройство ' + (i + 1)}
                  </option>
                ))}
            </select>
          </label>
        ))}
        <p className="form-footnote">
          1440p и 60 fps доступны в пределах возможностей камеры, браузера и сети. Фактические параметры — в
          диагностике.
        </p>
      </div>
    </Modal>
  );
}
