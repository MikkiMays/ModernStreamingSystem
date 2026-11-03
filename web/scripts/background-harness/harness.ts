/*
  Стенд фона (R186): поддельная камера Chromium → конвейер → <video>. Открывается dev-сервером Vite:
  /scripts/background-harness/index.html?mode=after&bg=blur-strong[&width=640&height=360]

  mode: after — свой конвейер (`media/background/effect.ts`); before — прежний обработчик
  `@livekit/track-processors` через `LocalVideoTrack.setProcessor`, как делала встреча до R186.
  bg: none | blur-light | blur-strong | image-<встроенный> | image-custom.
  Статистика — в `#stats` и в `window.harness` (`scripts/background-probe.mjs` читает её).
*/
import type { BackgroundChoice } from '../../src/media/background-effect';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'after';
const bg = params.get('bg') ?? 'blur-strong';
const width = Number(params.get('width') ?? 640);
const height = Number(params.get('height') ?? 360);
const video = document.getElementById('out') as HTMLVideoElement;
const statsEl = document.getElementById('stats') as HTMLDivElement;

const choice = ((): BackgroundChoice => {
  if (bg === 'blur-light') return { kind: 'blur', strength: 'light' };
  if (bg === 'blur-strong') return { kind: 'blur', strength: 'strong' };
  if (bg.startsWith('image-')) return { kind: 'image', id: bg.slice(6) as never };
  return { kind: 'none' };
})();

const harness = {
  mode,
  bg,
  outputFrames: 0,
  outputFps: 0,
  /** Средняя цена кадра у обработчика, мс (своя статистика каждого пути). */
  costMs: 0,
  segmentMs: 0,
  level: 0,
  transport: '',
  ready: false,
  error: '',
};
(window as unknown as { harness: typeof harness }).harness = harness;

function countOutput() {
  let frames = 0;
  let at = performance.now();
  const tick = () => {
    frames++;
    harness.outputFrames++;
    const now = performance.now();
    if (now - at >= 1000) {
      harness.outputFps = Math.round((frames * 1000) / (now - at));
      frames = 0;
      at = now;
    }
    video.requestVideoFrameCallback(tick);
  };
  video.requestVideoFrameCallback(tick);
}

function show() {
  statsEl.textContent = JSON.stringify(harness);
}

async function main() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } },
  });
  const track = stream.getVideoTracks()[0]!;
  let output: MediaStreamTrack = track;
  if (choice.kind !== 'none' && mode === 'after') {
    const { BackgroundEffect } = await import('../../src/media/background/effect');
    const effect = BackgroundEffect.shared();
    effect.stats.subscribe(() => {
      const s = effect.stats.get();
      if (!s) return;
      harness.costMs = Math.round(s.costMs * 10) / 10;
      harness.segmentMs = Math.round(s.segmentMs * 10) / 10;
      harness.level = s.level;
      harness.transport = s.transport;
      harness.ready = s.active;
      show();
    });
    output = await effect.attach(track, choice, 'full');
  } else if (choice.kind !== 'none' && mode === 'livekit') {
    // Путь встречи без SFU: LocalVideoTrack + CameraBackground (setProcessor → init), через 5 с —
    // restartTrack, как при включении камеры и перевороте (processor.restart), затем смена выбора (update).
    const { LocalVideoTrack } = await import('livekit-client');
    const { CameraBackground } = await import('../../src/media/background/camera');
    const { captureVideoTrack } = await import('../../src/media/background/processor');
    const { BackgroundEffect } = await import('../../src/media/background/effect');
    const local = new LocalVideoTrack(track, { width, height }, false);
    const background = new CameraBackground();
    await background.apply(local, choice, 'full');
    BackgroundEffect.shared().stats.subscribe(() => {
      const s = BackgroundEffect.shared().stats.get();
      if (!s) return;
      harness.costMs = Math.round(s.costMs * 10) / 10;
      harness.level = s.level;
      harness.transport = s.transport;
      harness.ready = s.active;
    });
    const extra = harness as typeof harness & { restarted?: string; switched?: boolean; capture?: string };
    extra.capture = `${captureVideoTrack(local).getSettings().width}x${captureVideoTrack(local).getSettings().height} raw=${captureVideoTrack(local) !== local.mediaStreamTrack}`;
    setTimeout(async () => {
      await local.restartTrack({ width, height });
      extra.restarted = `${local.getProcessor()?.name ?? 'none'} ${local.mediaStreamTrack.readyState}`;
      video.srcObject = new MediaStream([local.mediaStreamTrack]);
      await background.apply(local, { kind: 'blur', strength: 'light' }, 'full');
      extra.switched = true;
      show();
    }, 5000);
    output = local.mediaStreamTrack;
  } else if (choice.kind !== 'none' && mode === 'before') {
    const { LocalVideoTrack } = await import('livekit-client');
    const { BackgroundProcessor } = await import('@livekit/track-processors');
    const { builtinBackgroundUrl, customBackgroundUrl } = await import('../../src/media/background-effect');
    const local = new LocalVideoTrack(track, undefined, false);
    let cost = 0;
    const processor = BackgroundProcessor({
      mode: 'disabled',
      assetPaths: {
        tasksVisionFileSet: `${location.origin}/mediapipe/wasm`,
        modelAssetPath: `${location.origin}/mediapipe/selfie_segmenter.tflite`,
      },
      onFrameProcessed: (stats) => {
        cost = cost ? cost * 0.8 + stats.processingTimeMs * 0.2 : stats.processingTimeMs;
        harness.costMs = Math.round(cost * 10) / 10;
        harness.segmentMs = Math.round(stats.segmentationTimeMs * 10) / 10;
        harness.ready = true;
        harness.transport = 'main';
        show();
      },
    });
    await local.setProcessor(processor);
    if (choice.kind === 'blur')
      await processor.switchTo({
        mode: 'background-blur',
        blurRadius: choice.strength === 'strong' ? 14 : 6,
      });
    else {
      const url =
        choice.id === 'custom' ? await customBackgroundUrl() : await builtinBackgroundUrl(choice.id);
      await processor.switchTo({ mode: 'virtual-background', imagePath: url! });
    }
    output = local.mediaStreamTrack;
  }
  video.srcObject = new MediaStream([output]);
  await video.play();
  countOutput();
  setInterval(show, 1000);
}

main().catch((error) => {
  harness.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  show();
  console.error(error);
});
