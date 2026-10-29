import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { VideoOff } from 'lucide-react';
import { previewConstraints, type ScreenProfile } from '../../media/profiles';
import { rowDomId, rowText } from './sections';

type State = 'starting' | 'live' | 'denied' | 'failed';

/** «720p · 30 fps» — короткая сторона и частота, которые камера отдаёт сейчас. */
export function frameLabel(track: MediaStreamTrack | null | undefined): string | null {
  const { width, height, frameRate } = track?.getSettings() ?? {};
  if (!width || !height) return null;
  return `${Math.min(width, height)}p${frameRate ? ` · ${Math.round(frameRate)} fps` : ''}`;
}

function show(
  element: HTMLVideoElement | null,
  stream: MediaStream,
  track: MediaStreamTrack,
  onDevice?: (deviceId: string) => void,
) {
  // Какая камера на самом деле снимает: фронтальную просят стороной, а не устройством.
  const { deviceId } = track.getSettings();
  if (deviceId) onDevice?.(deviceId);
  if (!element) return;
  element.srcObject = stream;
  // Тот же признак, что в разговоре и на предпросмотре: задняя камера не зеркалится.
  element.style.transform = track.getSettings().facingMode === 'environment' ? 'none' : 'scaleX(-1)';
}

/**
 * Превью камеры наверху раздела «Видео» (R100) — как у Телемоста (n09): открыл раздел — видишь
 * себя, без кнопки «Показать». Ничего не публикуется даже во встрече.
 *
 * Во встрече с включённой камерой превью — та же дорожка, что уходит собеседникам (`live`), а не
 * второй захват. Второй захват той же камеры на телефоне спорит с первым за устройство, а превью
 * показывало бы не то, что видят другие: смена качества (`setCameraProfile`) видна здесь сразу.
 *
 * Без встречи или с выключенной камерой — свой захват под выбранный уровень. Сменили уровень — тот
 * же захват меняет кадр и частоту (`applyConstraints`), без перезапуска и чёрного кадра; сменили
 * камеру — захват перезапускается с новой. Камера держится ровно столько, сколько раздел на экране.
 * Отказ в доступе — не пустой чёрный прямоугольник, а объяснение. В углу — что камера отдаёт сейчас.
 *
 * Открыть превью — тоже включить камеру: на телефоне это фронтальная (`front`, Р-35), как во встрече и
 * на предвходе, а не запомненная после «перевернуть». Какая камера вышла, превью сообщает (`onDevice`) —
 * список камер рядом показывает её.
 */
export function CameraPreview({
  deviceId,
  front = false,
  profile,
  live,
  onDevice,
}: {
  deviceId?: string;
  /** Просить фронтальную камеру, а не `deviceId`. */
  front?: boolean;
  profile: ScreenProfile;
  /** Живая дорожка камеры встречи; нет — превью захватывает камеру само. */
  live?: MediaStreamTrack | null;
  /** Какая камера показана — устройство дорожки, когда оно известно. */
  onDevice?: (deviceId: string) => void;
}) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const own = useRef<MediaStreamTrack | null>(null);
  // Уровень для захвата читается при запуске, а не держит его: смена уровня — `applyConstraints`.
  const level = useRef(profile);
  level.current = profile;
  const reported = useRef(onDevice);
  reported.current = onDevice;
  // Что просим у камеры: фронтальную или выбранное устройство (пусто — какое даст система).
  const source = front ? 'front' : (deviceId ?? '');
  // Для какой камеры и чем закончился захват; другая камера в списке — снова «включается».
  const [result, setResult] = useState<{ source: string; state: State } | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const state: State = live ? 'live' : result && result.source === source ? result.state : 'starting';

  useEffect(() => {
    if (!live) return;
    const element = video.current;
    show(element, new MediaStream([live]), live, reported.current);
    return () => {
      if (element) element.srcObject = null;
    };
  }, [live]);

  const capturing = !live;
  useEffect(() => {
    if (!capturing) return;
    let track: MediaStreamTrack | null = null;
    let cancelled = false;
    const element = video.current;
    const media = navigator.mediaDevices;
    const finish = (next: State) => {
      if (!cancelled) setResult({ source, state: next });
    };
    if (!media?.getUserMedia) {
      finish('failed');
      return;
    }
    media
      .getUserMedia({
        audio: false,
        // Выбранная камера — пожеланием, а не требованием: вынутая камера не оставляет превью пустым.
        video: {
          ...(source === 'front' ? { facingMode: 'user' } : { deviceId: source || undefined }),
          ...previewConstraints(level.current),
        },
      })
      .then((captured) => {
        if (cancelled) {
          for (const each of captured.getTracks()) each.stop();
          return;
        }
        track = captured.getVideoTracks()[0] ?? null;
        own.current = track;
        if (track) show(element, captured, track, reported.current);
        finish('live');
      })
      .catch((error: unknown) => {
        const name = (error as { name?: string } | null)?.name;
        finish(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'failed');
      });
    return () => {
      cancelled = true;
      track?.stop();
      own.current = null;
      if (element) element.srcObject = null;
    };
  }, [source, capturing]);

  const { resolution, fps } = profile;
  useEffect(() => {
    const track = own.current;
    if (!capturing || !track) return;
    // Камера, которая не умеет столько, отдаёт что может — это и покажет подпись в углу.
    void track.applyConstraints(previewConstraints({ resolution, fps })).catch(() => {});
  }, [resolution, fps, capturing]);

  // Подпись в углу: что камера отдаёт на самом деле. Захват меняет кадр не мгновенно, поэтому —
  // раз в секунду, а не по событию.
  useEffect(() => {
    const read = () => setFrame(frameLabel(live ?? own.current));
    read();
    const timer = setInterval(read, 1000);
    return () => clearInterval(timer);
  }, [live]);

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
      {frame && state === 'live' && (
        <span className="setting-camera__tag setting-camera__frame">{frame}</span>
      )}
    </figure>
  );
}
