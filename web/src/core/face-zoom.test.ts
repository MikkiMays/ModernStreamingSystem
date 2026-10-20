import { beforeEach, expect, it } from 'vitest';
import { t } from '../i18n';
import { FACE_ZOOMS, nextZoom, readZooms, saveZoom, zoomLabel } from './face-zoom';

beforeEach(() => localStorage.clear());

it('три ступени по кругу, максимум полтора раза', () => {
  expect(FACE_ZOOMS).toEqual([1, 1.25, 1.5]);
  expect(nextZoom(1)).toBe(1.25);
  expect(nextZoom(1.25)).toBe(1.5);
  expect(nextZoom(1.5)).toBe(1);
  // Испорченное значение из хранилища — это обычный размер, а не четвёртая ступень.
  expect(nextZoom(3)).toBe(1);
});

it('выбор свой у каждой игры и каждого человека, обычный размер не хранится', () => {
  saveZoom('poker', 'anna', 1.5);
  saveZoom('poker', 'boris', 1.25);
  saveZoom('chess', 'anna', 1.25);
  expect(readZooms('poker')).toEqual({ anna: 1.5, boris: 1.25 });
  expect(readZooms('chess')).toEqual({ anna: 1.25 });
  expect(saveZoom('poker', 'anna', 1)).toEqual({ boris: 1.25 });
  expect(readZooms('durak')).toEqual({});
});

it('чужое и испорченное в хранилище не читается', () => {
  localStorage.setItem('cord:face-zoom:durak', JSON.stringify({ anna: 9, boris: 1.5, clara: 'big' }));
  expect(readZooms('durak')).toEqual({ boris: 1.5 });
  localStorage.setItem('cord:face-zoom:durak', '{oops');
  expect(readZooms('durak')).toEqual({});
});

it('помнится не больше сорока лиц, старые уходят первыми', () => {
  for (let index = 0; index < 45; index++) saveZoom('gartic', `p${index}`, 1.25);
  const kept = readZooms('gartic');
  expect(Object.keys(kept)).toHaveLength(40);
  expect(kept.p0).toBeUndefined();
  expect(kept.p44).toBe(1.25);
});

it('подпись говорит, что кнопка сделает', () => {
  expect(zoomLabel(t, 1, 'Аня')).toBe('Увеличить лицо до 1,25×: Аня');
  expect(zoomLabel(t, 1.5, 'Аня')).toBe('Вернуть обычный размер: Аня');
});
