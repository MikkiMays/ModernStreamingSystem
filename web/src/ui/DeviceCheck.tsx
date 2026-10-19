import { Mic, Video, Volume2 } from 'lucide-react';
import type { Preferences } from '../core/preferences';
import { useDeviceCheck } from './settings/useDeviceCheck';

/**
 * Проверка устройств одним блоком — для «Диагностики». В настройках те же проверки стоят в строках
 * своих устройств (`settings/VoiceSection`); логика у них одна — `useDeviceCheck`.
 * Private capture only: no call to publishTrack, even when opened during a meeting.
 */
export function DeviceCheck({ preferences }: { preferences: Preferences }) {
  const check = useDeviceCheck(preferences);
  return (
    <section className="device-check" aria-label="Проверка устройств">
      <h3>Проверьте себя</h3>
      <p className="muted">
        Предпросмотр и запись слышны и видны только вам. Проверка остановится при закрытии окна.
      </p>
      <div className="check-actions">
        <button
          className="button secondary"
          disabled={!!check.busy}
          onClick={() => void check.toggle('microphone')}
          aria-pressed={check.mic}
        >
          <Mic size={18} />
          {check.mic ? 'Остановить проверку микрофона' : 'Проверить микрофон'}
        </button>
        <button
          className="button secondary"
          disabled={!!check.busy}
          onClick={() => void check.toggle('camera')}
          aria-pressed={check.camera}
        >
          <Video size={18} />
          {check.camera ? 'Остановить проверку камеры' : 'Проверить камеру'}
        </button>
        <button className="button ghost" onClick={() => void check.speaker()}>
          <Volume2 size={18} />
          Проверить динамики
        </button>
      </div>
      {check.mic && (
        <div className="mic-test">
          <label>
            Уровень микрофона
            <meter
              min="0"
              max="100"
              low={15}
              high={90}
              optimum={60}
              value={check.level}
              aria-label="Уровень микрофона"
            />
          </label>
          <button className="button secondary" disabled={check.recording} onClick={check.record}>
            {check.recording ? 'Записываем 5 секунд…' : 'Записать 5 секунд и послушать'}
          </button>
        </div>
      )}
      {check.recorded && (
        <audio ref={check.playback} controls src={check.recorded} aria-label="Ваша тестовая запись" />
      )}
      <video
        ref={check.video}
        autoPlay
        muted
        playsInline
        className={`device-check-video ${check.camera ? '' : 'hidden'}`}
        aria-label="Тест камеры только для вас"
      />
      {check.busy && <p role="status">Включаем {check.busy === 'camera' ? 'камеру' : 'микрофон'}…</p>}
      {check.failure && (
        <p className="form-error" role="alert">
          {check.failure.text}
        </p>
      )}
    </section>
  );
}
