import { expect, it } from 'vitest';
import { PROVIDERS, PROVIDER_IDS } from '../core/cinema';
import { t } from '../i18n';
import { MUSIC_PLATFORMS, platformTiles } from './music-platforms';
import { BRAND, BRAND_DARKEN, contrast, mix } from '../../scripts/check-contrast.mjs';
import integrations from './integrations.css?raw';
import cinema from './cinema/cinema.css?raw';

/*
  Белая подпись на цвете площадки (аудит чёткости E15-B: вкладка YouTube 3,5:1, «YouTube» в кинозале
  4,2:1). Цвета живут в реестрах, а проверяет их `scripts/check-contrast.mjs` по своему списку
  `BRAND` — здесь сверяется, что список не отстал от реестров и что CSS темнит цвет так, как считает
  скрипт.
*/
const listed = new Set(Object.values(BRAND).map((color) => color.toLowerCase()));
const literal = (color: string) => /^#[0-9a-f]{6}$/i.test(color);

it('каждый цвет площадки под белой подписью есть в списке скрипта контраста', () => {
  const colors = [
    ...PROVIDER_IDS.flatMap((id) => [PROVIDERS[id].accent, PROVIDERS[id].tile]),
    ...platformTiles(t, MUSIC_PLATFORMS)
      .filter((tile) => !tile.ink)
      .map((tile) => tile.color),
  ].filter(literal);
  expect(colors.length).toBeGreaterThan(6);
  for (const color of colors) expect(listed, color).toContain(color.toLowerCase());
});

it('затемнённый на пятую часть цвет площадки держит AA под белой подписью', () => {
  for (const color of Object.values(BRAND))
    expect(contrast('#ffffff', mix(color, '#0a0c11', BRAND_DARKEN)), color).toBeGreaterThanOrEqual(4.5);
});

it('CSS темнит цвет площадки под подписью ровно так, как считает скрипт', () => {
  const darken = `${BRAND_DARKEN * 100}%, var(--stage-bg))`;
  expect(integrations).toContain(`color-mix(in srgb, var(--platform, var(--accent-fill)) ${darken}`);
  expect(cinema.split(`color-mix(in srgb, var(--accent, var(--accent-fill)) ${darken}`)).toHaveLength(4);
});
