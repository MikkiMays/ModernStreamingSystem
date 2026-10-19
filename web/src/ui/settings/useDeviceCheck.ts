import { useEffect, useRef, useState } from 'react';
import {
  createLocalAudioTrack,
  createLocalVideoTrack,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from 'livekit-client';
import type { Preferences } from '../../core/preferences';
import { audioCapture, CordAudioProcessor, needsAudioProcessor } from '../../media/audio';

/**
 * Проверка устройств только для себя: микрофон с полосой уровня и записью пробы, камера в
 * превью, тестовый звук в выбранные динамики. Ничего не публикуется, даже во встрече.
 *
 * Раньше это был отдельный блок «Проверьте себя» внизу вкладок «Звук» и «Видео». Теперь каждая
 * проверка стоит в строке своего устройства — как у FACEIT и Discord: выбрал микрофон, тут же
 * проверил. Блок стал хуком, а разметку рисуют строки раздела «Голос и видео». Всё захваченное
 * отпускается, когда раздел закрывается или меняется выбранное устройство.
 */
export function useDeviceCheck(preferences: Preferences) {
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
  const [failure, setFailure] = useState<{ kind: 'microphone' | 'camera' | 'speaker'; text: string } | null>(
    null,
  );
  const fail = (kind: 'microphone' | 'camera' | 'speaker', text: string) => setFailure({ kind, text });
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
    setFailure(null);
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
        setCamera(true);
      }
    } catch (e) {
      acquired?.stop();
      if (operation === revision.current)
        fail(kind, e instanceof Error ? e.message : 'Не удалось включить устройство');
    } finally {
      if (operation === revision.current) setBusy(null);
    }
  };
  // Превью рисуется после того, как элемент появился в разметке: строка показывает его только
  // при включённой проверке камеры.
  useEffect(() => {
    const track = videoTrack.current;
    const element = video.current;
    if (!camera || !track || !element) return;
    track.attach(element);
    // Тот же признак, что в разговоре и на предпросмотре: задняя камера не зеркалится.
    const facing = track.mediaStreamTrack.getSettings().facingMode;
    element.style.transform = facing === 'environment' ? 'none' : 'scaleX(-1)';
    return () => {
      track.detach(element);
    };
  }, [camera]);
  const record = () => {
    const track = audioTrack.current;
    if (!track || recording) return;
    setFailure(null);
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
      fail('microphone', 'Запись пробы не поддерживается этим браузером. Полоса уровня работает.');
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
      fail('speaker', 'Не удалось воспроизвести тестовый звук');
    }
  };
  return {
    video,
    playback,
    mic,
    camera,
    busy,
    level,
    recording,
    recorded,
    /** Что не получилось и у какого устройства: ошибка показывается под его строкой. */
    failure,
    toggle,
    record,
    speaker,
  };
}
