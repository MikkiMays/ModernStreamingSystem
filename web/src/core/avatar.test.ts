import { afterEach, expect, it, vi } from 'vitest';
import { avatarMaxLength, avatarSizes, cropRect, encodeAvatar, wholePicture } from './avatar';

it('без приближения берёт вписанный квадрат по центру', () => {
  expect(cropRect(1000, 600, wholePicture)).toEqual({ side: 600, left: 200, top: 0 });
});

it('приближение уменьшает кадр вокруг выбранной точки', () => {
  expect(cropRect(1000, 600, { zoom: 2, x: 0.25, y: 0.5 })).toEqual({ side: 300, left: 100, top: 150 });
});

it('кадр не выходит за края: угол снимка остаётся углом', () => {
  // Просят кадр за левым краем — отдаётся крайний возможный, а не отрицательный.
  expect(cropRect(1000, 600, { zoom: 2, x: 0, y: 0 })).toEqual({ side: 300, left: 0, top: 0 });
  expect(cropRect(1000, 600, { zoom: 2, x: 1, y: 1 })).toEqual({ side: 300, left: 700, top: 300 });
});

/**
 * Кодека в jsdom нет, поэтому здесь стоит его грубая модель: «байт» тем больше, чем больше
 * площадь и щедрее качество. Проверяется не сжатие, а лестница — то, из-за чего аватар и был
 * пиксельным: раньше размер был один и маленький, сколько бы места ни оставалось в бюджете.
 */
function pretendCanvas(costPerPixel: number, webp = true) {
  const tried: { size: number; quality: number }[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ clearRect: () => {}, drawImage: () => {} }),
    toDataURL(type: string, quality = 1) {
      if (!webp && type === 'image/webp') return 'data:image/png;base64,AAAA';
      if (canvas.width === 8) return `data:${type};base64,AAAA`;
      tried.push({ size: canvas.width, quality });
      const bytes = Math.round(canvas.width * canvas.width * quality * costPerPixel);
      return `data:${type};base64,${'A'.repeat(bytes)}`;
    },
  };
  vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLElement);
  return tried;
}
const picture = { width: 900, height: 700, close: () => {} } as unknown as ImageBitmap;
afterEach(() => vi.restoreAllMocks());

it('берёт самый крупный размер, который влезает в бюджет комнаты', () => {
  const tried = pretendCanvas(0.2);
  const encoded = encodeAvatar(picture, wholePicture);
  expect(encoded.length).toBeLessThanOrEqual(avatarMaxLength);
  // Начинает с самого подробного и останавливается, как только уложился.
  expect(tried[0]?.size).toBe(avatarSizes[0]);
  expect(tried.at(-1)?.size).toBe(avatarSizes[0]);
  expect(encoded.startsWith('data:image/webp')).toBe(true);
});

it('дорогому снимку уступает размером, а не отказом', () => {
  const tried = pretendCanvas(0.6);
  const encoded = encodeAvatar(picture, wholePicture);
  expect(encoded.length).toBeLessThanOrEqual(avatarMaxLength);
  const chosen = tried.at(-1)?.size ?? 0;
  expect(chosen).toBeLessThan(avatarSizes[0]);
  // Но и не до прежних 64 пикселей: место в бюджете ещё было.
  expect(chosen).toBeGreaterThan(64);
});

it('без WebP уходит в JPEG, а не отдаёт PNG сверх бюджета', () => {
  pretendCanvas(0.2, false);
  expect(encodeAvatar(picture, wholePicture).startsWith('data:image/jpeg')).toBe(true);
});
