import { Mic, Video, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Preferences } from '../core/preferences';
import { Button } from './kit';
import { useDeviceCheck } from './settings/useDeviceCheck';

/**
 * Проверка устройств одним блоком — для «Диагностики». В настройках те же проверки стоят в строках
 * своих устройств (`settings/AudioSection`); логика у них одна — `useDeviceCheck`.
 * Private capture only: no call to publishTrack, even when opened during a meeting.
 */
export function DeviceCheck({ preferences }: { preferences: Preferences }) {
  const { t } = useTranslation();
  const check = useDeviceCheck(preferences);
  return (
    <section className="device-check" aria-label={t(($) => $.devices.check.label)}>
      <h3 className="device-check__title">{t(($) => $.devices.check.title)}</h3>
      <p className="device-check__note">{t(($) => $.devices.check.privacy)}</p>
      <div className="check-actions">
        <Button
          size="sm"
          icon={<Mic />}
          disabled={!!check.busy}
          onClick={() => void check.toggle('microphone')}
          aria-pressed={check.mic}
        >
          {check.mic ? t(($) => $.devices.check.micStop) : t(($) => $.devices.check.micStart)}
        </Button>
        <Button
          size="sm"
          icon={<Video />}
          disabled={!!check.busy}
          onClick={() => void check.toggle('camera')}
          aria-pressed={check.camera}
        >
          {check.camera ? t(($) => $.devices.check.cameraStop) : t(($) => $.devices.check.cameraStart)}
        </Button>
        <Button size="sm" variant="quiet" icon={<Volume2 />} onClick={() => void check.speaker()}>
          {t(($) => $.devices.check.speakers)}
        </Button>
      </div>
      {check.mic && (
        <div className="mic-test">
          <label>
            {t(($) => $.devices.check.micLevel)}
            <meter
              min="0"
              max="100"
              low={15}
              high={90}
              optimum={60}
              value={check.level}
              aria-label={t(($) => $.devices.check.micLevel)}
            />
          </label>
          <Button size="sm" disabled={check.recording} onClick={check.record}>
            {check.recording ? t(($) => $.devices.check.recording) : t(($) => $.devices.check.record)}
          </Button>
        </div>
      )}
      {check.recorded && (
        <audio
          ref={check.playback}
          controls
          src={check.recorded}
          aria-label={t(($) => $.devices.check.recorded)}
        />
      )}
      <video
        ref={check.video}
        autoPlay
        muted
        playsInline
        className={`device-check-video ${check.camera ? '' : 'hidden'}`}
        aria-label={t(($) => $.devices.check.cameraPreview)}
      />
      {check.busy && (
        <p role="status">
          {check.busy === 'camera'
            ? t(($) => $.devices.check.startingCamera)
            : t(($) => $.devices.check.startingMic)}
        </p>
      )}
      {check.failure && (
        <p className="form-error" role="alert">
          {check.failure.text}
        </p>
      )}
    </section>
  );
}
