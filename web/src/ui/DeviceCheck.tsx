import { useEffect, useState, type ReactNode } from 'react';
import { Mic, Video, VideoOff, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Preferences } from '../core/preferences';
import { Button } from './kit';
import { LevelMeter } from './settings/Row';
import { useDeviceCheck } from './settings/useDeviceCheck';
import './settings/settings.css';
import './device-check.css';

/** Сколько «звучит» карточка динамиков после нажатия — длина сигнала с запасом. */
const TONE_MS = 1200;

/**
 * Проверка своих устройств — для «Поддержки → Проверить» и «Диагностики» (R124). Три проверки одного
 * рода — три одинаковые карточки в ряд, как у Discord и Телемоста: значок и имя устройства, окно
 * проверки одной высоты (уровень микрофона, превью камеры, сигнал динамиков) и одна кнопка
 * «Проверить» / «Остановить». До нажатия окно не пустое: в нём то, что появится, приглушённо (шкала
 * уровня, камера выключена, динамик). Запись пробы микрофона и ошибки — под карточками.
 * В настройках те же проверки стоят в строках своих устройств (`settings/AudioSection`); логика у
 * них одна — `useDeviceCheck`. Ничего не публикуется, даже во встрече.
 */
export function DeviceCheck({ preferences }: { preferences: Preferences }) {
  const { t } = useTranslation();
  const check = useDeviceCheck(preferences);
  const [tone, setTone] = useState(false);
  useEffect(() => {
    if (!tone) return;
    const timer = setTimeout(() => setTone(false), TONE_MS);
    return () => clearTimeout(timer);
  }, [tone]);
  return (
    <section className="device-check" aria-label={t(($) => $.devices.check.label)}>
      <h3 className="device-check__title">{t(($) => $.devices.check.title)}</h3>
      <p className="device-check__note">{t(($) => $.devices.check.privacy)}</p>
      <div className="device-check__cards">
        <CheckCard
          icon={<Mic />}
          title={t(($) => $.devices.check.microphone)}
          live={check.mic}
          stage={
            <LevelMeter level={check.mic ? check.level : 0} label={t(($) => $.devices.check.micLevel)} />
          }
          hint={check.mic ? t(($) => $.devices.check.micSpeak) : t(($) => $.devices.check.micHint)}
          action={
            <Button
              size="sm"
              variant={check.mic ? 'primary' : 'secondary'}
              disabled={!!check.busy}
              onClick={() => void check.toggle('microphone')}
              aria-pressed={check.mic}
              aria-label={check.mic ? t(($) => $.devices.check.micStop) : t(($) => $.devices.check.micStart)}
            >
              {check.mic ? t(($) => $.devices.check.stop) : t(($) => $.devices.check.start)}
            </Button>
          }
        />
        <CheckCard
          icon={<Video />}
          title={t(($) => $.devices.check.camera)}
          live={check.camera}
          stage={
            <>
              <video
                ref={check.video}
                autoPlay
                muted
                playsInline
                className="device-check__video"
                hidden={!check.camera}
                aria-label={t(($) => $.devices.check.cameraPreview)}
              />
              {!check.camera && <VideoOff className="device-check__idle" aria-hidden="true" />}
            </>
          }
          hint={t(($) => $.devices.check.cameraHint)}
          action={
            <Button
              size="sm"
              variant={check.camera ? 'primary' : 'secondary'}
              disabled={!!check.busy}
              onClick={() => void check.toggle('camera')}
              aria-pressed={check.camera}
              aria-label={
                check.camera ? t(($) => $.devices.check.cameraStop) : t(($) => $.devices.check.cameraStart)
              }
            >
              {check.camera ? t(($) => $.devices.check.stop) : t(($) => $.devices.check.start)}
            </Button>
          }
        />
        <CheckCard
          icon={<Volume2 />}
          title={t(($) => $.devices.check.speaker)}
          live={tone}
          stage={
            <span className="device-check__wave" data-on={tone || undefined} aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
              <span />
            </span>
          }
          hint={t(($) => $.devices.check.speakerHint)}
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setTone(true);
                void check.speaker();
              }}
              aria-label={t(($) => $.devices.check.speakers)}
            >
              {t(($) => $.devices.check.start)}
            </Button>
          }
        />
      </div>
      {check.mic && (
        <div className="device-check__record">
          <Button size="sm" variant="secondary" disabled={check.recording} onClick={check.record}>
            {check.recording ? t(($) => $.devices.check.recording) : t(($) => $.devices.check.record)}
          </Button>
          {check.recorded && (
            <audio
              ref={check.playback}
              controls
              src={check.recorded}
              aria-label={t(($) => $.devices.check.recorded)}
            />
          )}
        </div>
      )}
      {check.busy && (
        <p className="device-check__status" role="status">
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

function CheckCard({
  icon,
  title,
  live,
  stage,
  hint,
  action,
}: {
  icon: ReactNode;
  title: string;
  live: boolean;
  stage: ReactNode;
  hint: string;
  action: ReactNode;
}) {
  return (
    <div className="device-check__card" data-live={live || undefined}>
      <div className="device-check__head">
        <span className="device-check__icon" aria-hidden="true">
          {icon}
        </span>
        <h4 className="device-check__name">{title}</h4>
      </div>
      <div className="device-check__stage">{stage}</div>
      <p className="device-check__hint">{hint}</p>
      {action}
    </div>
  );
}
