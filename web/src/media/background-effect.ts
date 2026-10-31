import type { LocalVideoTrack } from 'livekit-client';
import { touchFirst } from './profiles';

/**
 * Фон в видео (R153, владелец 31.10.2026: «Фон в видео как в телемосте и других подобных»).
 *
 * Выбор принадлежит человеку и устройству (`preferences.background`): нет, размытие — лёгкое или
 * сильное, — один из встроенных фонов или своё фото. Обработка — `@livekit/track-processors`
 * (MediaPipe, сегментация человека): модель и wasm отдаёт свой сервер (`public/mediapipe/`,
 * `vite.config.ts` → `mediapipeAssets`), а не CDN — CSP их не пустила бы, и ослаблять её нельзя.
 *
 * Встроенные фоны рисуются здесь же на холсте — спокойные градиенты в тон Cord, без чужих фотографий и
 * их лицензий. Своё фото уменьшается до 1280×720 и живёт в IndexedDB этого устройства.
 *
 * Где можно: компьютер — полностью; Android — только размытие и только при «современной» обработке
 * (`supportsModernBackgroundProcessors`, иначе телефон перегревается); iPhone и Telegram — нет.
 */
export type BackgroundChoice =
  | { kind: 'none' }
  | { kind: 'blur'; strength: 'light' | 'strong' }
  | { kind: 'image'; id: BuiltinBackground | 'custom' };

export const BUILTIN_BACKGROUNDS = ['graphite', 'mist', 'dawn', 'forest', 'sea', 'sand'] as const;
export type BuiltinBackground = (typeof BUILTIN_BACKGROUNDS)[number];

export const NO_BACKGROUND: BackgroundChoice = { kind: 'none' };

/** Радиус размытия: «лёгкое» — фон читается, «сильное» — пятна цвета. */
export const BLUR_RADIUS = { light: 6, strong: 14 } as const;

/** Проверка записи из настроек: неизвестное — «без фона», а не ошибка. */
export function backgroundChoice(value: unknown): BackgroundChoice {
  const v = value as Partial<BackgroundChoice & { strength: string; id: string }> | null;
  if (v?.kind === 'blur' && (v.strength === 'light' || v.strength === 'strong'))
    return { kind: 'blur', strength: v.strength };
  if (
    v?.kind === 'image' &&
    (v.id === 'custom' || (BUILTIN_BACKGROUNDS as readonly string[]).includes(v.id ?? ''))
  )
    return { kind: 'image', id: v.id as BuiltinBackground | 'custom' };
  return NO_BACKGROUND;
}

export type BackgroundSupport = 'full' | 'blur' | 'none';

/** Что умеет это устройство: зависит от браузера и от того, телефон ли это. */
export async function backgroundSupport(): Promise<BackgroundSupport> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 'none';
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return 'none';
  if ((window as { Telegram?: unknown }).Telegram) return 'none';
  try {
    const { supportsBackgroundProcessors, supportsModernBackgroundProcessors } =
      await import('@livekit/track-processors');
    if (!supportsBackgroundProcessors()) return 'none';
    if (touchFirst()) return supportsModernBackgroundProcessors() ? 'blur' : 'none';
    return 'full';
  } catch {
    return 'none';
  }
}

/** Можно ли этот выбор на этом устройстве; нельзя — камера идёт как есть. */
export function allowed(choice: BackgroundChoice, support: BackgroundSupport): boolean {
  if (choice.kind === 'none') return true;
  if (support === 'none') return false;
  return choice.kind === 'blur' || support === 'full';
}

/** Цвета встроенных фонов: картинка рисуется из них же, плитка выбора — тоже. */
export const GRADIENTS: Record<BuiltinBackground, readonly [string, string, string]> = {
  graphite: ['#1d2129', '#2b313c', '#414a59'],
  mist: ['#dfe4ea', '#c9d1db', '#aeb8c6'],
  dawn: ['#f3d9c9', '#e7b9a6', '#b98e9e'],
  forest: ['#1f3a33', '#2f5547', '#5d7f62'],
  sea: ['#14324a', '#1f5470', '#4f8aa3'],
  sand: ['#efe4d2', '#dccbb0', '#bca88a'],
};

const urls = new Map<string, string>();

/** Встроенный фон картинкой `blob:` 1280×720 — рисуется один раз на страницу. */
export async function builtinBackgroundUrl(id: BuiltinBackground): Promise<string> {
  const cached = urls.get(id);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas');
  const [from, middle, to] = GRADIENTS[id];
  const gradient = context.createLinearGradient(0, 0, 1280, 720);
  gradient.addColorStop(0, from);
  gradient.addColorStop(0.55, middle);
  gradient.addColorStop(1, to);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1280, 720);
  // Мягкий свет сверху слева — фон не плоский, как стена комнаты, а не заливка.
  const glow = context.createRadialGradient(300, 160, 0, 300, 160, 900);
  glow.addColorStop(0, 'rgba(255,255,255,0.18)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, 1280, 720);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('blob'))), 'image/webp', 0.9),
  );
  const url = URL.createObjectURL(blob);
  urls.set(id, url);
  return url;
}

const DB = 'cord-background';
const STORE = 'images';
const CUSTOM = 'custom';

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Своё фото: уменьшить до 1280×720 (заполняя кадр) и сохранить на этом устройстве. */
export async function saveCustomBackground(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas');
  const scale = Math.max(1280 / bitmap.width, 720 / bitmap.height);
  const width = bitmap.width * scale;
  const height = bitmap.height * scale;
  context.drawImage(bitmap, (1280 - width) / 2, (720 - height) / 2, width, height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('blob'))), 'image/jpeg', 0.88),
  );
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(blob, CUSTOM);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
  const previous = urls.get(CUSTOM);
  if (previous) URL.revokeObjectURL(previous);
  const url = URL.createObjectURL(blob);
  urls.set(CUSTOM, url);
  return url;
}

/** Своё фото, если оно сохранено на этом устройстве. */
export async function customBackgroundUrl(): Promise<string | null> {
  const cached = urls.get(CUSTOM);
  if (cached) return cached;
  try {
    const db = await database();
    const blob = await new Promise<Blob | undefined>((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(CUSTOM);
      request.onsuccess = () => resolve(request.result as Blob | undefined);
      request.onerror = () => reject(request.error);
    });
    db.close();
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    urls.set(CUSTOM, url);
    return url;
  } catch {
    return null;
  }
}

type Processor = Awaited<ReturnType<typeof createProcessor>>;

async function createProcessor() {
  const { BackgroundProcessor } = await import('@livekit/track-processors');
  return BackgroundProcessor({
    mode: 'disabled',
    assetPaths: {
      tasksVisionFileSet: `${location.origin}/mediapipe/wasm`,
      modelAssetPath: `${location.origin}/mediapipe/selfie_segmenter.tflite`,
    },
  });
}

/** Что сказать обработчику под этот выбор; `null` — фото нет, остаёмся без фона. */
async function switchOptions(choice: BackgroundChoice) {
  if (choice.kind === 'blur')
    return { mode: 'background-blur' as const, blurRadius: BLUR_RADIUS[choice.strength] };
  if (choice.kind === 'image') {
    const imagePath =
      choice.id === 'custom' ? await customBackgroundUrl() : await builtinBackgroundUrl(choice.id);
    return imagePath ? { mode: 'virtual-background' as const, imagePath } : null;
  }
  return null;
}

/**
 * Фон у одной дорожки камеры: ставит обработчик при первом эффекте и переключает его на лету —
 * без переопубликации и без мигания у зрителей. «Без фона» снимает обработчик целиком: лишний
 * проход кадров через холст стоит процессора, а значит и кадров.
 */
export class CameraBackground {
  private processor: Processor | null = null;
  private track: LocalVideoTrack | null = null;
  private queue: Promise<void> = Promise.resolve();

  /** Стоит ли обработчик на дорожке сейчас. */
  get active(): boolean {
    return this.processor !== null;
  }

  /** Применить выбор к дорожке (или к новой дорожке после смены камеры/кодека). */
  apply(track: LocalVideoTrack | null | undefined, choice: BackgroundChoice): Promise<void> {
    this.queue = this.queue.catch(() => {}).then(() => this.run(track ?? null, choice));
    return this.queue;
  }

  private async run(track: LocalVideoTrack | null, choice: BackgroundChoice) {
    if (this.track && this.track !== track) {
      this.processor = null;
      this.track = null;
    }
    if (!track) return;
    const options = choice.kind === 'none' ? null : await switchOptions(choice);
    if (!options) {
      if (this.processor) await track.stopProcessor().catch(() => {});
      this.processor = null;
      this.track = track;
      return;
    }
    if (!this.processor || track.getProcessor() !== this.processor) {
      this.processor = await createProcessor();
      await track.setProcessor(this.processor);
    }
    this.track = track;
    await this.processor.switchTo(options);
  }
}
