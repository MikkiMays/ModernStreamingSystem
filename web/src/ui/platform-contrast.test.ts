import { expect, it } from 'vitest';
import { PROVIDERS, PROVIDER_IDS } from '../core/cinema';
import { t } from '../i18n';
import { MUSIC_PLATFORMS, platformTiles } from './music-platforms';
import { BRAND, BRAND_DARKEN, contrast, mix } from '../../scripts/check-contrast.mjs';
import { BRANDS } from './brands';
import cinema from './cinema/cinema.css?raw';

/*
  Белая подпись на цвете площадки (аудит чёткости E15-B: вкладка YouTube 3,5:1, «YouTube» в кинозале
  4,2:1). Цвета живут в одном реестре брендов (`brands.ts`, R33), и кинозал с музыкой берут их оттуда
  — переменной `--brand-<id>`, а не своей копией hex. Скрипт контраста собирает свой список `BRAND`
  из того же реестра; здесь сверяется, что CSS темнит цвет так, как считает скрипт.
*/

it('площадки кинозала и музыки красятся брендом из общего реестра, а не своим hex', () => {
  for (const id of PROVIDER_IDS) expect(PROVIDERS[id].accent, id).toBe(`var(--brand-${id})`);
  for (const tile of platformTiles(t, MUSIC_PLATFORMS)) expect(BRANDS[tile.brand], tile.id).toBeDefined();
});

it('список скрипта — каждый бренд с белым знаком, из того же реестра', () => {
  const white = Object.entries(BRANDS).filter(([, brand]) => brand.ink === '#ffffff');
  expect(Object.keys(BRAND).sort()).toEqual(white.map(([id]) => id).sort());
  for (const [id, brand] of white) expect(BRAND[id], id).toBe(brand.color);
});

it('затемнённый на пятую часть цвет бренда держит AA под белой подписью', () => {
  for (const color of Object.values(BRAND))
    expect(contrast('#ffffff', mix(color, '#0a0c11', BRAND_DARKEN)), color).toBeGreaterThanOrEqual(4.5);
});

it('CSS кинозала темнит цвет площадки под подписью ровно так, как считает скрипт', () => {
  const darken = `${BRAND_DARKEN * 100}%, var(--stage-bg))`;
  expect(cinema.split(`color-mix(in srgb, var(--accent, var(--accent-fill)) ${darken}`)).toHaveLength(4);
});
