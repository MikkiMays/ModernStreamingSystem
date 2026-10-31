import type { BoardFilesPort } from './sync';

/**
 * Картинки доски (R159): байты едут не сокетом, а `PUT/GET /api/v1/rooms/{id}/board/files/{fileId}`.
 *
 * Вставивший картинку кладёт её на сервер до того, как элемент уйдёт соседям (`BoardSync` держит
 * элемент, пока `ready` не скажет «да»); сосед, к которому элемент доехал, достаёт её сам (`need`) —
 * с повторами: картинка могла ещё догружаться. Номер картинки — хэш её содержимого (так называет её
 * Excalidraw), поэтому одна и та же картинка грузится один раз.
 *
 * Ядро принимает только растровые PNG, JPEG, WebP и GIF и смотрит на сами байты: SVG и прочее здесь
 * переводится в PNG до отправки.
 */

/** Сетевая часть: положить и достать байты. */
export interface BoardFileApi {
  put(fileId: string, blob: Blob): Promise<void>;
  get(fileId: string): Promise<Blob>;
}

/** Картинки холста: что у него есть и как дать ему новую. */
export interface LocalFiles {
  get(fileId: string): { dataURL: string; mimeType: string } | undefined;
  add(files: { id: string; dataURL: string; mimeType: string; created: number }[]): void;
}

/** Какие типы ядро принимает как есть. */
export const RASTER = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** `data:`-ссылка → байты. Без `fetch`: CSP (`connect-src 'self'`) не пускает его к `data:`. */
export function dataUrlToBlob(dataURL: string): Blob {
  const comma = dataURL.indexOf(',');
  const header = dataURL.slice(0, comma);
  const body = dataURL.slice(comma + 1);
  const mime = /^data:([^;,]+)/.exec(header)?.[1] ?? 'application/octet-stream';
  if (!header.includes(';base64')) return new Blob([decodeURIComponent(body)], { type: mime });
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/** Нерастровое (SVG) — в PNG через холст браузера, не больше 2048 точек по стороне. */
async function rasterize(dataURL: string): Promise<Blob> {
  const image = new Image();
  image.decoding = 'async';
  image.src = dataURL;
  await image.decode();
  const scale = Math.min(1, 2048 / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((image.naturalWidth || 512) * scale));
  canvas.height = Math.max(1, Math.round((image.naturalHeight || 512) * scale));
  canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('png failed'))), 'image/png'),
  );
}

export class BoardFiles implements BoardFilesPort {
  private onServer = new Set<string>();
  private uploads = new Map<string, Promise<void>>();
  private fetching = new Set<string>();
  private disposed = false;

  constructor(
    private readonly api: BoardFileApi,
    private readonly local: LocalFiles,
    private readonly retries: readonly number[] = [500, 1000, 2000, 4000, 8000],
  ) {}

  ready(fileId: string): boolean {
    return this.onServer.has(fileId);
  }

  known(ids: readonly string[]) {
    for (const id of ids) this.onServer.add(id);
  }

  upload(fileId: string): Promise<void> {
    if (this.onServer.has(fileId)) return Promise.resolve();
    const running = this.uploads.get(fileId);
    if (running) return running;
    const file = this.local.get(fileId);
    if (!file) return Promise.reject(new Error('no such file'));
    const run = (async () => {
      const blob = RASTER.has(file.mimeType) ? dataUrlToBlob(file.dataURL) : await rasterize(file.dataURL);
      await this.api.put(fileId, blob);
      this.onServer.add(fileId);
    })().finally(() => this.uploads.delete(fileId));
    this.uploads.set(fileId, run);
    return run;
  }

  need(fileId: string) {
    if (this.local.get(fileId) || this.fetching.has(fileId)) return;
    this.fetching.add(fileId);
    void this.fetch(fileId, 0);
  }

  dispose() {
    this.disposed = true;
  }

  private async fetch(fileId: string, attempt: number) {
    if (this.disposed) return;
    try {
      const blob = await this.api.get(fileId);
      const dataURL = await blobToDataUrl(blob);
      if (this.disposed) return;
      this.local.add([{ id: fileId, dataURL, mimeType: blob.type || 'image/png', created: Date.now() }]);
      this.onServer.add(fileId);
      this.fetching.delete(fileId);
    } catch {
      const wait = this.retries[attempt];
      if (wait === undefined || this.disposed) {
        this.fetching.delete(fileId);
        return;
      }
      setTimeout(() => void this.fetch(fileId, attempt + 1), wait);
    }
  }
}
