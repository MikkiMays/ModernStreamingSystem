import { useEffect, useRef, useState } from 'react';
import {
  createLocalAudioTrack,
  createLocalVideoTrack,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from 'livekit-client';
import { Mic, Video, Volume2 } from 'lucide-react';
import type { Preferences } from '../core/preferences';
import { audioCapture, CordAudioProcessor, needsAudioProcessor } from '../media/audio';

/** Private capture only: no call to publishTrack, even when opened during a meeting. */
export function DeviceCheck({ preferences }: { preferences: Preferences }) {
  const video = useRef<HTMLVideoElement>(null);
  const playback = useRef<HTMLAudioElement>(null);
  const audioTrack = useRef<LocalAudioTrack | null>(null);
  const videoTrack = useRef<LocalVideoTrack | null>(null);
  const context = useRef<AudioContext | null>(null);
  const meterTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const recordTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const recorder = useRef<MediaRecorder | null>(null);
  const revision = useRef(0);
  const recordUrl = useRef('');
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState('');
  const [mic, setMic] = useState(false);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState<'microphone' | 'camera' | null>(null);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const stop = () => {
    revision.current++;
    clearInterval(meterTimer.current);
    clearTimeout(recordTimer.current);
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = null;
    audioTrack.current?.stop();
    videoTrack.current?.stop();
    audioTrack.current = null;
    videoTrack.current = null;
    if (context.current?.state !== 'closed') void context.current?.close();
    context.current = null;
    if (recordUrl.current) URL.revokeObjectURL(recordUrl.current);
    recordUrl.current = '';
  };
  useEffect(() => {
    setMic(false);
    setCamera(false);
    setLevel(0);
    setBusy(null);
    setRecorded('');
    setRecording(false);
    return stop;
  }, [preferences.devices.microphone, preferences.devices.camera, preferences.audio]);
  useEffect(() => {
    const element = playback.current;
    if (element && 'setSinkId' in element)
      void (element as HTMLAudioElement & { setSinkId(id: string): Promise<void> })
        .setSinkId(preferences.devices.speaker ?? '')
        .catch(() => {});
  }, [recorded, preferences.devices.speaker]);
  const toggle = async (kind: 'microphone' | 'camera') => {
    if (busy) return;
    setError('');
    if (kind === 'microphone' && mic) {
      if (recorder.current?.state === 'recording') recorder.current.stop();
      audioTrack.current?.stop();
      audioTrack.current = null;
      clearInterval(meterTimer.current);
      setMic(false);
      setLevel(0);
      if (context.current?.state !== 'closed') void context.current?.close();
      context.current = null;
      return;
    }
    if (kind === 'camera' && camera) {
      videoTrack.current?.stop();
      videoTrack.current = null;
      setCamera(false);
      return;
    }
    const operation = revision.current;
    setBusy(kind);
    let acquired: LocalAudioTrack | LocalVideoTrack | undefined;
    try {
      if (kind === 'microphone') {
        const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
        context.current = ctx;
        await ctx.resume();
        const track = await createLocalAudioTrack(
          audioCapture(preferences.audio, preferences.devices.microphone),
        );
        acquired = track;
        if (operation !== revision.current) {
          track.stop();
          return;
        }
        audioTrack.current = track;
        track.setAudioContext(ctx);
        if (needsAudioProcessor(preferences.audio))
          await track.setProcessor(new CordAudioProcessor(preferences.audio));
        if (operation !== revision.current) {
          track.stop();
          return;
        }
        const source = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        meterTimer.current = setInterval(() => {
          analyser.getFloatTimeDomainData(data);
          const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
          const db = 20 * Math.log10(Math.max(rms, 0.000001));
          setLevel(Math.round(Math.max(0, Math.min(100, ((db + 60) / 60) * 100))));
        }, 100);
        setMic(true);
      } else {
        const track = await createLocalVideoTrack({
          deviceId: preferences.devices.camera || undefined,
          resolution: { width: 1280, height: 720 },
        });
        acquired = track;
        if (operation !== revision.current) {
          track.stop();
          return;
        }
        videoTrack.current = track;
        if (video.current) track.attach(video.current);
        setCamera(true);
      }
    } catch (e) {
      acquired?.stop();
      if (operation === revision.current)
        setError(e instanceof Error ? e.message : 'Не удалось включить устройство');
    } finally {
      if (operation === revision.current) setBusy(null);
    }
  };
  const record = () => {
    const track = audioTrack.current;
    if (!track || recording) return;
    setError('');
    const operation = revision.current;
    const chunks: Blob[] = [];
    try {
      const rec = new MediaRecorder(new MediaStream([track.mediaStreamTrack]));
      recorder.current = rec;
      rec.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      rec.onstop = () => {
        clearTimeout(recordTimer.current);
        if (operation !== revision.current) return;
        setRecording(false);
        if (recordUrl.current) URL.revokeObjectURL(recordUrl.current);
        recordUrl.current = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType }));
        setRecorded(recordUrl.current);
      };
      rec.start();
      setRecording(true);
      recordTimer.current = setTimeout(() => {
        if (rec.state === 'recording') rec.stop();
      }, 5000);
    } catch {
      setError('Запись пробы не поддерживается этим браузером. Индикатор микрофона работает.');
    }
  };
  const speaker = async () => {
    const ctx = new AudioContext();
    try {
      if (preferences.devices.speaker && 'setSinkId' in ctx)
        await (ctx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(
          preferences.devices.speaker,
        );
      await ctx.resume();
      const tone = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 0.04);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
      tone.frequency.value = 440;
      tone.connect(gain).connect(ctx.destination);
      tone.onended = () => {
        void ctx.close();
      };
      tone.start();
      tone.stop(ctx.currentTime + 0.65);
    } catch {
      if (ctx.state !== 'closed') await ctx.close();
      setError('Не удалось воспроизвести тестовый звук');
    }
  };
  return (
    <section className="device-check" aria-label="Проверка устройств">
      <h3>Проверьте себя</h3>
      <p className="muted">
        Предпросмотр и запись слышны и видны только вам. Проверка остановится при закрытии окна.
      </p>
      <div className="check-actions">
        <button
          className="button secondary"
          disabled={!!busy}
          onClick={() => void toggle('microphone')}
          aria-pressed={mic}
        >
          <Mic size={18} />
          {mic ? 'Остановить проверку микрофона' : 'Проверить микрофон'}
        </button>
        <button
          className="button secondary"
          disabled={!!busy}
          onClick={() => void toggle('camera')}
          aria-pressed={camera}
        >
          <Video size={18} />
          {camera ? 'Остановить проверку камеры' : 'Проверить камеру'}
        </button>
        <button className="button ghost" onClick={() => void speaker()}>
          <Volume2 size={18} />
          Проверить динамики
        </button>
      </div>
      {mic && (
        <div className="mic-test">
          <label>
            Уровень микрофона
            <meter
              min="0"
              max="100"
              low={15}
              high={90}
              optimum={60}
              value={level}
              aria-label="Уровень микрофона"
            />
          </label>
          <button className="button secondary" disabled={recording} onClick={record}>
            {recording ? 'Записываем 5 секунд…' : 'Записать 5 секунд и послушать'}
          </button>
        </div>
      )}
      {recorded && <audio ref={playback} controls src={recorded} aria-label="Ваша тестовая запись" />}
      <video
        ref={video}
        autoPlay
        muted
        playsInline
        className={`device-check-video ${camera ? '' : 'hidden'}`}
        aria-label="Тест камеры только для вас"
      />
      {busy && <p role="status">Включаем {busy === 'camera' ? 'камеру' : 'микрофон'}…</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
