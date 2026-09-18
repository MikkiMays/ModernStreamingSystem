import { expect, it } from 'vitest';
import { cropRect, wholePicture } from './avatar';

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
