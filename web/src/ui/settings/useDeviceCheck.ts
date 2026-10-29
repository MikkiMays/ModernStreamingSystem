import { useEffect, useRef, useState } from 'react';
import {
  createLocalAudioTrack,
  createLocalVideoTrack,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from 'livekit-client';
import type { Preferences } from '../../core/preferences';
import { t } from '../../i18n';
import { audioCapture, CordAudioProcessor, needsAudioProcessor } from '../../media/audio';
import { touchFirst } from '../../media/profiles';

/** Сколько длится проба микрофона: запись, затем она же сразу звучит и пропадает. */
export const TEST_SECONDS = 5;

/** Что делает проба микрофона: ничего, пишет или проигрывает только что записанное. */
export type MicTest = 'idle' | 'recording' | 'playing';

/** Кто включил микрофон проверки: от этого зависит, кто его и выключит. */
type MicOwner = 'auto' | 'manual' | 'test';

/**
 * Проверка устройств только для себя: микрофон с полосой уровня и пробой, камера в превью,
 * тестовый звук в выбранные динамики. Ничего не публикуется, даже во встрече.
 *
 * Каждая проверка стоит в строке своего устройства — как у Телемоста и Discord: выбрал микрофон,
 * тут же проверил (раздел «Микрофон»); одним блоком хук рисует «Диагностика» (`DeviceCheck`). Превью
 * камеры в разделе «Видео» живёт само (`CameraPreview`). Всё захваченное отпускается, когда раздел
 * закрывается или меняется выбранное устройство.
 *
 * `auto` (R141) — микрофон слушается сам, пока раздел открыт: полоса уровня работает без кнопки
 * «Проверить» и сама поднимается снова после смены устройства или обработки. Отказ доступа сам не
 * повторяется — повтор по нажатию «Проверить».
 *
 * Проба (`test`) — запись на {@link TEST_SECONDS} с, и сразу же она звучит в выбранных динамиках и
 * пропадает: прежде под строкой оставался проигрыватель записи, убрать который было нечем (R141).
 * Нажатие во время записи или прослушивания пробу обрывает.
 */
export function useDeviceCheck(preferences: Preferences, { auto = false }: { auto?: boolean } = {}) {
  const video = useRef<HTMLVideoElement>(null);
  const audioTrack = useRef<LocalAudioTrack | null>(null);
  const videoTrack = useRef<LocalVideoTrack | null>(null);
  const context = useRef<AudioContext | null>(null);
  const meterTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const recordTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const recorder = useRef<MediaRecorder | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const recordUrl = useRef('');
  const owner = useRef<MicOwner | null>(null);
  /**
   * Микрофон уже включается: второй вызов ждёт того же, а не открывает второй захват. Включение
   * для прежнего устройства (ревизия сменилась, пока ждали `getUserMedia`) не годится — его ждут до
   * конца и включают заново, иначе шкала молча осталась бы пустой.
   */
  const starting = useRef<{ operation: number; promise: Promise<boolean> } | null>(null);
  const revision = useRef(0);
  const [test, setTest] = useState<MicTest>('idle');
  const [seconds, setSeconds] = useState(TEST_SECONDS);
  const [mic, setMic] = useState(false);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState<'microphone' | 'camera' | null>(null);
  const [level, setLevel] = useState(0);
  const [failure, setFailure] = useState<{ kind: 'microphone' | 'camera' | 'speaker'; text: string } | null>(
    null,
  );
  const fail = (kind: 'microphone' | 'camera' | 'speaker', text: string) => setFailure({ kind, text });
  /** Оборвать пробу: запись — без прослушивания, прослушивание — и забыть запись. */
  const endTest = () => {
    clearInterval(recordTimer.current);
    const rec = recorder.current;
    recorder.current = null;
    // Обработчик снимается и у уже остановленной записи: событие `stop` могло ещё стоять в очереди.
    if (rec) rec.onstop = null;
    if (rec?.state === 'recording') rec.stop();
    if (player.current) {
      player.current.onended = null;
      player.current.onerror = null;
      player.current.pause();
      player.current.removeAttribute('src');
      player.current = null;
    }
    if (recordUrl.current) URL.revokeObjectURL(recordUrl.current);
    recordUrl.current = '';
    setTest('idle');
    setSeconds(TEST_SECONDS);
  };
  const stopMic = () => {
    endTest();
    audioTrack.current?.stop();
    audioTrack.current = null;
    owner.current = null;
    clearInterval(meterTimer.current);
    setMic(false);
    setLevel(0);
    if (context.current?.state !== 'closed') void context.current?.close();
    context.current = null;
  };
  const stop = () => {
    revision.current++;
    stopMic();
    videoTrack.current?.stop();
    videoTrack.current = null;
  };
  // Обработка звука сравнивается по значению: запись настроек отдаёт новый объект на каждую правку,
  // и проверка микрофона обрывалась бы от любого соседнего ползунка.
  const audioKey = JSON.stringify(preferences.audio);
  useEffect(() => {
    setMic(false);
    setCamera(false);
    setLevel(0);
    setBusy(null);
    // Другое устройство — новая попытка: отказ прежнего к нему не относится.
    setFailure(null);
    return stop;
  }, [preferences.devices.microphone, preferences.devices.camera, audioKey]);
  /** Включить микрофон проверки; `true` — слушается. */
  const startMic = (by: MicOwner): Promise<boolean> => {
    if (audioTrack.current) return Promise.resolve(true);
    const pending = starting.current;
    if (pending)
      return pending.operation === revision.current
        ? pending.promise
        : pending.promise.then(() => startMic(by));
    const entry = { operation: revision.current, promise: acquireMic(by) };
    starting.current = entry;
    void entry.promise.finally(() => {
      if (starting.current === entry) starting.current = null;
    });
    return entry.promise;
  };
  const acquireMic = async (by: MicOwner): Promise<boolean> => {
    const operation = revision.current;
    setBusy('microphone');
    let acquired: LocalAudioTrack | undefined;
    let ctx: AudioContext | undefined;
    try {
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      context.current = ctx;
      await ctx.resume();
      const track = await createLocalAudioTrack(
        audioCapture(preferences.audio, preferences.devices.microphone),
      );
      acquired = track;
      if (operation !== revision.current) {
        track.stop();
        return false;
      }
      audioTrack.current = track;
      owner.current = by;
      track.setAudioContext(ctx);
      if (needsAudioProcessor(preferences.audio))
        await track.setProcessor(new CordAudioProcessor(preferences.audio));
      if (operation !== revision.current) {
        track.stop();
        return false;
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
      return true;
    } catch (e) {
      acquired?.stop();
      if (audioTrack.current === acquired) audioTrack.current = null;
      // Контекст отказавшего захвата — закрыть: иначе каждый повтор после отказа оставлял бы ещё один.
      if (context.current === ctx) context.current = null;
      if (ctx && ctx.state !== 'closed') void ctx.close();
      if (operation === revision.current)
        fail(
          'microphone',
          e instanceof DOMException && e.name === 'NotAllowedError'
            ? t(($) => $.settings.voice.micDenied)
            : e instanceof Error && e.message
              ? e.message
              : t(($) => $.settings.voice.deviceFailed),
        );
      return false;
    } finally {
      if (operation === revision.current) setBusy(null);
    }
  };
  // Полоса уровня сама (R141): раздел открыт — микрофон слушается; отказ ждёт нажатия «Проверить».
  useEffect(() => {
    if (auto && !mic && !busy && !failure) void startMic('auto');
    // Встреча включила свой микрофон — шкала берёт его уровень, а свой захват уходит.
    if (!auto && mic && owner.current === 'auto' && test === 'idle') stopMic();
  });
  const toggle = async (kind: 'microphone' | 'camera') => {
    if (busy) return;
    setFailure(null);
    if (kind === 'microphone') {
      if (mic) stopMic();
      else await startMic('manual');
      return;
    }
    if (camera) {
      videoTrack.current?.stop();
      videoTrack.current = null;
      setCamera(false);
      return;
    }
    const operation = revision.current;
    setBusy('camera');
    let acquired: LocalVideoTrack | undefined;
    try {
      const track = await createLocalVideoTrack({
        // Проверка — тоже включение камеры: на телефоне фронтальная, а не запомненная (Р-35).
        ...(touchFirst() ? { facingMode: 'user' } : { deviceId: preferences.devices.camera || undefined }),
        resolution: { width: 1280, height: 720 },
      });
      acquired = track;
      if (operation !== revision.current) {
        track.stop();
        return;
      }
      videoTrack.current = track;
      setCamera(true);
    } catch (e) {
      acquired?.stop();
      if (operation === revision.current)
        fail('camera', e instanceof Error ? e.message : t(($) => $.settings.voice.deviceFailed));
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
  /** Проба закончилась: микрофон, включённый только ради неё, выключается. */
  const finishTest = () => {
    const temporary = owner.current === 'test';
    endTest();
    if (temporary) stopMic();
  };
  /** Прослушать запись в выбранных динамиках и сразу забыть её. */
  const play = (url: string) => {
    const audio = new Audio(url);
    player.current = audio;
    setTest('playing');
    audio.onended = finishTest;
    audio.onerror = finishTest;
    const sink = preferences.devices.speaker;
    const routed =
      sink && 'setSinkId' in audio
        ? (audio as HTMLAudioElement & { setSinkId(id: string): Promise<void> })
            .setSinkId(sink)
            .catch(() => {})
        : Promise.resolve();
    void routed.then(() => (player.current === audio ? audio.play() : undefined)).catch(finishTest);
  };
  /** «Проверить» у микрофона: записать пробу и послушать её; повторное нажатие — оборвать. */
  const runTest = async () => {
    if (test !== 'idle') {
      finishTest();
      return;
    }
    if (busy) return;
    setFailure(null);
    if (!(await startMic('test'))) return;
    const track = audioTrack.current;
    if (!track) return;
    const operation = revision.current;
    const chunks: Blob[] = [];
    try {
      const rec = new MediaRecorder(new MediaStream([track.mediaStreamTrack]));
      recorder.current = rec;
      rec.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      rec.onstop = () => {
        clearInterval(recordTimer.current);
        recorder.current = null;
        if (operation !== revision.current) return;
        recordUrl.current = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType }));
        play(recordUrl.current);
      };
      rec.start();
      setTest('recording');
      setSeconds(TEST_SECONDS);
      let left = TEST_SECONDS;
      recordTimer.current = setInterval(() => {
        left -= 1;
        setSeconds(Math.max(left, 0));
        if (left <= 0 && rec.state === 'recording') rec.stop();
      }, 1000);
    } catch {
      finishTest();
      fail(
        'microphone',
        t(($) => $.settings.voice.recordUnsupported),
      );
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
      fail(
        'speaker',
        t(($) => $.settings.voice.toneFailed),
      );
    }
  };
  return {
    video,
    mic,
    camera,
    busy,
    level,
    /** Проба микрофона: что идёт сейчас и сколько секунд записи осталось. */
    test,
    seconds,
    /** Что не получилось и у какого устройства: ошибка показывается под его строкой. */
    failure,
    toggle,
    runTest,
    speaker,
  };
}
