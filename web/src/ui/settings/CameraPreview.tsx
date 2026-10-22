import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { VideoOff } from 'lucide-react';
import { rowDomId, rowText } from './sections';

type State = 'starting' | 'live' | 'denied' | 'failed';

/**
 * Превью камеры наверху раздела «Видео» (R100) — как у Телемоста (n09): открыл раздел — видишь
 * себя, без кнопки «Показать». Захват только для себя, ничего не публикуется даже во встрече.
 *
 * Камера держится ровно столько, сколько раздел на экране: ушли в другой раздел или закрыли окно —
 * компонент размонтирован и дорожка остановлена (индикатор камеры гаснет). Сменили камеру в списке —
 * захват перезапускается с новой. Отказ в доступе — не пустой чёрный прямоугольник, а объяснение;
 * остальной раздел работает и без превью.
 */
export function CameraPreview({ deviceId }: { deviceId?: string }) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  // Для какой камеры и чем закончился захват; другая камера в списке — снова «включается».
  const [result, setResult] = useState<{ deviceId?: string; state: State } | null>(null);
  const state: State = result && result.deviceId === deviceId ? result.state : 'starting';
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    const element = video.current;
    const media = navigator.mediaDevices;
    const finish = (next: State) => {
      if (!cancelled) setResult({ deviceId, state: next });
    };
    if (!media?.getUserMedia) {
      finish('failed');
      return;
    }
    media
      .getUserMedia({
        audio: false,
        // Выбранная камера — пожеланием, а не требованием: вынутая камера не оставляет превью пустым.
        video: { deviceId: deviceId || undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      .then((captured) => {
        if (cancelled) {
          for (const track of captured.getTracks()) track.stop();
          return;
        }
        stream = captured;
        if (element) {
          element.srcObject = captured;
          // Тот же признак, что в разговоре и на предпросмотре: задняя камера не зеркалится.
          const facing = captured.getVideoTracks()[0]?.getSettings().facingMode;
          element.style.transform = facing === 'environment' ? 'none' : 'scaleX(-1)';
        }
        finish('live');
      })
      .catch((error: unknown) => {
        const name = (error as { name?: string } | null)?.name;
        finish(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'failed');
      });
    return () => {
      cancelled = true;
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (element) element.srcObject = null;
    };
  }, [deviceId]);
  const problem =
    state === 'denied'
      ? t(($) => $.settings.video.previewDenied)
      : state === 'failed'
        ? t(($) => $.settings.voice.deviceFailed)
        : null;
  return (
    <figure className="setting-camera__preview" id={rowDomId('camera-preview')} data-state={state}>
      <video
        ref={video}
        className="setting-camera__video"
        autoPlay
        muted
        playsInline
        aria-label={t(($) => $.settings.voice.previewLabel)}
      />
      {problem && (
        <figcaption className="setting-camera__problem" role="status">
          <VideoOff aria-hidden="true" />
          <span>{problem}</span>
        </figcaption>
      )}
      <span className="setting-camera__tag">{rowText(t, 'camera-preview').hint}</span>
    </figure>
  );
}
