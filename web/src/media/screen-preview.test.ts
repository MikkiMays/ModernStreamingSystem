import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodePreview,
  encodePreview,
  fitPreview,
  isFlat,
  PreviewImages,
  ScreenPreviewSource,
  PREVIEW_FIRST_MS,
  PREVIEW_HEIGHT,
  PREVIEW_INTERVAL,
  PREVIEW_WIDTH,
} from './screen-preview';

/** Кадр RGBA заданного цвета с необязательной «картинкой» в середине. */
function frame(
  width: number,
  height: number,
  base: number,
  patch?: { from: number; to: number; value: number },
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const x = i % width;
    const value = patch && x >= patch.from && x < patch.to ? patch.value : base;
    data.set([value, value, value, 255], i * 4);
  }
  return data;
}

describe('превью не отправляет пустой кадр (R07)', () => {
  it('одноцветный кадр — чёрный экран игры на загрузке — считается пустым', () => {
    expect(isFlat(frame(64, 36, 0), 64, 36)).toBe(true);
    expect(isFlat(frame(64, 36, 200), 64, 36)).toBe(true);
  });
  it('кадр с содержимым хотя бы в части экрана — не пустой', () => {
    expect(isFlat(frame(64, 36, 20, { from: 20, to: 44, value: 220 }), 64, 36)).toBe(false);
  });
  it('лёгкий шум JPEG пустым кадр не портит, а кадр без данных — пустой', () => {
    const noisy = frame(64, 36, 100);
    for (let i = 0; i < noisy.length; i += 4) noisy[i] = noisy[i + 1] = noisy[i + 2] = 100 + (i % 3);
    expect(isFlat(noisy, 64, 36)).toBe(true);
    expect(isFlat(new Uint8ClampedArray(0), 64, 36)).toBe(true);
  });
  it('первый кадр уходит почти сразу, дальше — раз в пять секунд', () => {
    expect(PREVIEW_FIRST_MS).toBeLessThanOrEqual(500);
    expect(PREVIEW_INTERVAL).toBe(5000);
  });
});

describe('вписать кадр демонстрации в превью', () => {
  it('не растягивает вертикальный телефон и сверхширокий монитор', () => {
    expect(fitPreview(1080, 1920)).toEqual({ width: 81, height: 144 });
    expect(fitPreview(5120, 1440)).toEqual({ width: 256, height: 72 });
  });

  it('вписывает обычный экран целиком по ширине', () => {
    expect(fitPreview(2560, 1440)).toEqual({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT });
  });

  it('не увеличивает источник меньше превью', () => {
    expect(fitPreview(160, 90)).toEqual({ width: 160, height: 90 });
  });

  it('переживает источник без размеров: первый кадр приходит раньше метаданных', () => {
    expect(fitPreview(0, 0)).toEqual({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT });
  });
});

describe('ссылки на присланные кадры', () => {
  const stub = () => {
    let next = 0;
    const live = new Set<string>();
    vi.stubGlobal('URL', {
      createObjectURL: () => {
        const url = `blob:preview-${next++}`;
        live.add(url);
        return url;
      },
      revokeObjectURL: (url: string) => live.delete(url),
    });
    return live;
  };

  it('отзывает прежний кадр участника, оставляя только последний', () => {
    const live = stub();
    const images = new PreviewImages();
    const first = images.accept('alice', new Uint8Array([1]));
    const second = images.accept('alice', new Uint8Array([2]));
    expect(first).not.toBe(second);
    expect([...live]).toEqual([second]);
  });

  it('ничего не оставляет после ушедшего участника и после конца встречи', () => {
    const live = stub();
    const images = new PreviewImages();
    images.accept('alice', new Uint8Array([1]));
    images.accept('bob', new Uint8Array([2]));
    images.forget('alice');
    expect(live.size).toBe(1);
    images.clear();
    expect(live.size).toBe(0);
  });
});

describe('кадр в команду и обратно', () => {
  it('base64 туда и обратно без потерь, мусор — пустой массив', () => {
    const bytes = new Uint8Array(20000).map((_, i) => (i * 7) % 256);
    expect(decodePreview(encodePreview(bytes))).toEqual(bytes);
    expect(decodePreview('не base64!').byteLength).toBe(0);
  });
});

/**
 * Источник кадров: берёт `VideoFrame` из дорожки, закрывает его, шлёт только непустой кадр;
 * `stop()` отменяет чтение, а кадр, пришедший после `stop()`/нового `start()`, не уходит.
 */
describe('источник превью', () => {
  function fakeCanvas(flat: boolean) {
    const data = new Uint8ClampedArray(256 * 144 * 4);
    if (!flat) for (let i = 0; i < data.length; i += 4) data[i] = (i / 4) % 256;
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn(), getImageData: () => ({ data }) }),
      toBlob: (resolve: (b: Blob) => void) => resolve(new Blob([new Uint8Array([1, 2, 3])])),
    };
    return canvas;
  }
  function processor(frames: Array<{ close: () => void }>) {
    let released = false;
    const reader = {
      read: () =>
        new Promise<{ value?: unknown; done: boolean }>((resolve) => {
          if (released) return resolve({ done: true });
          const value = frames.shift();
          if (value) resolve({ value, done: false });
          // Кадров нет — читатель ждёт, пока его не отменят.
          (reader as { pending?: () => void }).pending = () => resolve({ done: true });
        }),
      cancel: vi.fn(async () => {
        released = true;
        (reader as { pending?: () => void }).pending?.();
      }),
    };
    class Processor {
      readable = { getReader: () => reader };
    }
    vi.stubGlobal('MediaStreamTrackProcessor', Processor);
    return reader;
  }
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('берёт кадр из дорожки, закрывает его и шлёт картинку', async () => {
    vi.useFakeTimers();
    const canvas = fakeCanvas(false);
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLElement);
    const frame = {
      displayWidth: 1920,
      displayHeight: 1080,
      codedWidth: 1920,
      codedHeight: 1080,
      close: vi.fn(),
    };
    processor([frame]);
    const sent: Uint8Array[] = [];
    const source = new ScreenPreviewSource();
    source.start({} as MediaStreamTrack, (bytes) => sent.push(bytes));
    await vi.advanceTimersByTimeAsync(PREVIEW_FIRST_MS + 10);
    expect(frame.close).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(canvas.width).toBe(256);
    source.stop();
  });

  it('пустой кадр не отправляет, но закрывает', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'createElement').mockReturnValue(fakeCanvas(true) as unknown as HTMLElement);
    const frame = {
      displayWidth: 640,
      displayHeight: 360,
      codedWidth: 640,
      codedHeight: 360,
      close: vi.fn(),
    };
    processor([frame]);
    const sent: Uint8Array[] = [];
    const source = new ScreenPreviewSource();
    source.start({} as MediaStreamTrack, (bytes) => sent.push(bytes));
    await vi.advanceTimersByTimeAsync(PREVIEW_FIRST_MS + 10);
    expect(frame.close).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(0);
    source.stop();
  });

  it('stop() отменяет чтение, и кадр, пришедший после, не уходит и закрывается', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'createElement').mockReturnValue(fakeCanvas(false) as unknown as HTMLElement);
    const late = { displayWidth: 640, displayHeight: 360, codedWidth: 640, codedHeight: 360, close: vi.fn() };
    const frames: Array<{ close: () => void }> = [];
    const reader = processor(frames);
    const sent: Uint8Array[] = [];
    const source = new ScreenPreviewSource();
    source.start({} as MediaStreamTrack, (bytes) => sent.push(bytes));
    // Первый захват ждёт кадра; тем временем показ остановили.
    await vi.advanceTimersByTimeAsync(PREVIEW_FIRST_MS + 10);
    source.stop();
    expect(reader.cancel).toHaveBeenCalled();
    // Кадр, который всё же приехал старому захвату, принадлежит прошлому поколению.
    frames.push(late);
    await vi.advanceTimersByTimeAsync(PREVIEW_INTERVAL + 10);
    expect(sent).toHaveLength(0);
  });
});
