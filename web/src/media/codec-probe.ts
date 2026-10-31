import { supportsAV1, supportsH265, supportsVP9 } from 'livekit-client';
import { desktopShell, hasFeature, invokeDesktop } from '../core/desktop';
import {
  CODECS,
  codecMime,
  probeKey,
  type Codec,
  type GpuHint,
  type GpuVendor,
  type PolicyLevel,
  type PolicyPlatform,
  type ProbeAnswer,
  type ProbeAnswers,
  type Scalability,
} from './codec-policy';
import { currentPlatform, type Platform } from './platform';

/**
 * Что о машине нужно политике кодеков (`codec-policy.ts`) — здесь, а не там: там чистые таблицы,
 * здесь браузер, оболочка и кэш.
 */

/** Платформа для лестницы: Telegram и телефон — свои, клиент Windows на Electron — свой. */
export function policyPlatform(platform: Platform = currentPlatform()): PolicyPlatform {
  if (platform.telegram) return 'telegram';
  if (platform.mobile || platform.app) return 'mobile';
  return desktopShell() === 'electron' ? 'electron' : 'desktop';
}

/**
 * Что браузер вообще умеет отдавать — и что из этого примет LiveKit: AV1 из Safari и Firefox он
 * не публикует, VP9 — из Firefox и Safari до 16 (`supportsAV1`/`supportsVP9`), и спрашивать о них
 * кодировщик бессмысленно — опубликовано будет другое.
 */
export function sendableCodecs(): Codec[] {
  const listed = new Set(
    (globalThis.RTCRtpSender?.getCapabilities?.('video')?.codecs ?? []).map((c) => c.mimeType.toLowerCase()),
  );
  const sdk: Partial<Record<Codec, () => boolean>> = {
    av1: supportsAV1,
    vp9: supportsVP9,
    h265: supportsH265,
  };
  return CODECS.filter((codec) => {
    if (!listed.has(codecMime[codec].toLowerCase())) return false;
    try {
      return sdk[codec]?.() ?? true;
    } catch {
      return false;
    }
  });
}

/** Поставщик по PCI-коду (`0x10de`) или по строке рендерера WebGL / имени устройства. */
export function vendorOf(value: string | number): GpuVendor {
  if (typeof value === 'number') {
    return (
      (
        {
          0x10de: 'nvidia',
          0x1002: 'amd',
          0x1022: 'amd',
          0x8086: 'intel',
          0x106b: 'apple',
          0x5143: 'qualcomm',
          0x13b5: 'arm',
        } as const
      )[value] ?? 'other'
    );
  }
  const text = value.toLowerCase();
  if (/nvidia|geforce|quadro|rtx|gtx/.test(text)) return 'nvidia';
  if (/\bamd\b|radeon|\bati\b/.test(text)) return 'amd';
  if (/intel|iris|\barc\b|uhd graphics/.test(text)) return 'intel';
  if (/apple/.test(text)) return 'apple';
  if (/adreno|qualcomm/.test(text)) return 'qualcomm';
  if (/mali|\barm\b/.test(text)) return 'arm';
  return 'other';
}

/** Видеокарта от оболочки: ответ `invoke('app.gpu')` (клиент Windows 1.1+, флаг `app.gpu`). */
export interface ShellGpu extends GpuHint {
  /** Имя и драйвер — для ключа кэша и для отчёта; людям не показываются. */
  identity: string;
}

/** Ответ оболочки → подсказка; чужое или битое — `null`, и тогда — WebGL. */
export function parseShellGpu(value: unknown): ShellGpu | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { devices?: unknown; av1hw?: unknown };
  if (!Array.isArray(record.devices)) return null;
  const vendors = new Set<GpuVendor>();
  const names: string[] = [];
  for (const device of record.devices.slice(0, 8)) {
    if (!device || typeof device !== 'object') continue;
    const { vendorId, deviceId, name, driver } = device as {
      vendorId?: unknown;
      deviceId?: unknown;
      name?: unknown;
      driver?: unknown;
    };
    const label = typeof name === 'string' ? name.slice(0, 80) : '';
    const vendor = typeof vendorId === 'number' ? vendorOf(vendorId) : label ? vendorOf(label) : 'other';
    if (vendor !== 'other') vendors.add(vendor);
    const id = typeof deviceId === 'number' ? deviceId.toString(16) : '';
    names.push(`${vendor}:${id}:${label}/${typeof driver === 'string' ? driver.slice(0, 32) : ''}`);
  }
  const av1hw = (record.av1hw as { enabled?: unknown } | undefined)?.enabled === true;
  return { vendors: [...vendors], av1hw, source: 'shell', identity: names.join(';') };
}

/** Рендерер WebGL: в браузере это единственное, что говорит о видеокарте. Без окна и в тестах — нет. */
function webglRenderer(): string | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl') as WebGLRenderingContext | null;
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return renderer || null;
  } catch {
    return null;
  }
}

let gpuOnce: Promise<ShellGpu | null> | undefined;

/** Видеокарта этой машины — один раз за страницу: от оболочки, иначе по WebGL, иначе `null`. */
export function gpuHint(): Promise<ShellGpu | null> {
  gpuOnce ??= (async () => {
    if (hasFeature('app.gpu')) {
      const shell = parseShellGpu(await invokeDesktop('app.gpu').catch(() => null));
      if (shell) return shell;
    }
    const renderer = webglRenderer();
    if (!renderer) return null;
    const vendor = vendorOf(renderer);
    return { vendors: vendor === 'other' ? [] : [vendor], source: 'webgl', identity: renderer.slice(0, 160) };
  })();
  return gpuOnce;
}

/**
 * Кэш ответов кодировщика: по браузеру (User-Agent с версией Chromium) и видеокарте (имя и
 * драйвер) — обновился браузер или драйвер, ответы спрашиваются заново. Неделя — на случай, когда
 * драйвер сменился, а имя осталось (WebGL его не называет).
 */
const CACHE_KEY = 'cord:encoder-probe:v1';
const CACHE_DAYS = 7;
const CACHE_LIMIT = 200;
interface ProbeCache {
  scope: string;
  at: number;
  answers: Record<string, ProbeAnswer>;
}
const memory = new Map<string, ProbeAnswer>();
let memoryScope = '';

function readCache(scope: string): Record<string, ProbeAnswer> {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as ProbeCache | null;
    if (!cache || cache.scope !== scope || Date.now() - cache.at > CACHE_DAYS * 86_400_000) return {};
    return cache.answers ?? {};
  } catch {
    return {};
  }
}
function writeCache(scope: string, answers: Record<string, ProbeAnswer>) {
  try {
    const entries = Object.entries(answers).slice(-CACHE_LIMIT);
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ scope, at: Date.now(), answers: Object.fromEntries(entries) }),
    );
  } catch {
    /* Нет хранилища (приватный режим) — спросим ещё раз в следующий раз. */
  }
}

const levelKey = (level: PolicyLevel) => `${level.width}x${level.height}@${level.fps}:${level.bitrate}`;
const svc = (codec: Codec) => codec === 'vp9' || codec === 'av1';

/**
 * Спросить кодировщик о каждом режиме, который может уйти в сеть, — с тем же кадром, частотой и
 * битрейтом. У VP9/AV1 — с `scalabilityMode`: Chromium отвечает `powerEfficient` по списку режимов
 * аппаратного профиля, и у Media Foundation `L3T3_KEY` в нём нет. У H.264/H.265/VP8 режим не
 * публикуется вовсе (libwebrtc берёт один слой) — и не спрашивается: иначе вопрос был бы о другом.
 */
export async function probeEncoders(
  queries: readonly { codec: Codec; mode: Scalability }[],
  level: PolicyLevel,
  identity: string,
): Promise<ProbeAnswers> {
  if (typeof navigator === 'undefined' || !navigator.mediaCapabilities?.encodingInfo) return {};
  // `type: 'webrtc'` браузер не знает (старый Safari) — ответов нет вовсе, политика решит вслепую.
  if (!(await webrtcProbe())) return {};
  const scope = `${navigator.userAgent}|${identity}`;
  if (scope !== memoryScope) {
    memory.clear();
    memoryScope = scope;
    for (const [key, answer] of Object.entries(readCache(scope))) memory.set(key, answer);
  }
  const sendable = new Set(sendableCodecs());
  const result: Record<string, ProbeAnswer> = {};
  let asked = false;
  for (const { codec, mode } of queries) {
    const key = `${probeKey(codec, mode)}@${levelKey(level)}`;
    let answer = memory.get(key);
    if (!answer) {
      answer = sendable.has(codec)
        ? await ask(codec, mode, level)
        : { supported: false, smooth: false, powerEfficient: false };
      memory.set(key, answer);
      asked = true;
    }
    result[probeKey(codec, mode)] = answer;
  }
  if (asked) writeCache(scope, Object.fromEntries(memory));
  return result;
}

/** Знает ли браузер `type: 'webrtc'` — один раз на объект `mediaCapabilities`. */
const webrtcKnown = new WeakMap<MediaCapabilities, Promise<boolean>>();
function webrtcProbe(): Promise<boolean> {
  const capabilities = navigator.mediaCapabilities;
  let known = webrtcKnown.get(capabilities);
  if (!known) {
    known = capabilities
      .encodingInfo({
        type: 'webrtc',
        video: { contentType: 'video/VP8', width: 640, height: 360, bitrate: 500_000, framerate: 30 },
      } as MediaEncodingConfiguration)
      .then(
        () => true,
        () => false,
      );
    webrtcKnown.set(capabilities, known);
  }
  return known;
}

async function ask(codec: Codec, mode: Scalability, level: PolicyLevel): Promise<ProbeAnswer> {
  try {
    const info = await navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: {
        contentType: codecMime[codec],
        width: level.width,
        height: level.height,
        bitrate: level.bitrate,
        framerate: level.fps,
        ...(svc(codec) ? { scalabilityMode: mode } : {}),
      },
    } as MediaEncodingConfiguration);
    return { supported: !!info.supported, smooth: !!info.smooth, powerEfficient: !!info.powerEfficient };
  } catch {
    // Режима браузер не знает (`L3T3_KEY` в Safari) — это «не умею», а не «не спросили».
    return { supported: false, smooth: false, powerEfficient: false };
  }
}

/**
 * Тесно ли процессору — Compute Pressure (`PressureObserver`, Chromium 125+, клиент Windows): при
 * `serious`/`critical` политика не поднимает второй кодировщик и программные ступени. Нет API —
 * молчим, решают жалобы кодировщика.
 */
export function watchCpuPressure(onChange: (tight: boolean) => void): () => void {
  const Observer = (
    globalThis as {
      PressureObserver?: new (cb: (records: { state: string }[]) => void) => {
        observe(source: 'cpu', options?: { sampleInterval?: number }): Promise<void>;
        disconnect(): void;
      };
    }
  ).PressureObserver;
  if (!Observer) return () => {};
  try {
    const observer = new Observer((records) => {
      const state = records.at(-1)?.state;
      if (state) onChange(state === 'serious' || state === 'critical');
    });
    void observer.observe('cpu', { sampleInterval: 2000 }).catch(() => {});
    return () => observer.disconnect();
  } catch {
    return () => {};
  }
}
