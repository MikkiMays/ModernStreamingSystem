// Зазоры плашки переключателей (вкладки `segmented` и `Segmented`, R123) в физических пикселях —
// по снимку с настоящим масштабом экрана, а не по модели.
//
//   node scripts/switcher-gaps.mjs --base https://cord.nikg.tech --path /kit --height 2600 --out ../backlog/screens/R108/kit
//   node scripts/switcher-gaps.mjs --base http://127.0.0.1:5199 --path /kit --dpr 1,1.25,1.5,1.75
//
// Дорожка красится в чистый зелёный, плашка — в чистый красный, фон под дорожкой — в синий, тени и
// подписи гаснут. На каждом DPR (браузер с `--force-device-scale-factor`: эмуляция Playwright рисует на
// сетке CSS-пикселей и врёт про округление, `knowledge/memory/cord-pixel-exact-ui.md`) нажимается каждый
// пункт, и по снимку считаются ряды и столбцы зелёного между краем дорожки и плашкой: сверху, снизу, у
// крайнего левого и правого пункта. Ровно — когда все четыре равны; плюс плашка светлее дорожки
// (яркость по вычисленным стилям, обе темы на `/kit`). Страница должна помещаться без прокрутки
// (`--height`): дробный сдвиг прокрутки размывает края.
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://127.0.0.1:5208');
const route = arg('path', '/kit');
const out = path.resolve(arg('out', 'shots-switchers'));
const dprs = arg('dpr', '1,1.25,1.5').split(',').map(Number);
const width = Number(arg('width', 1280));
const height = Number(arg('height', 900));
mkdirSync(out, { recursive: true });

const TRACKS = '.ui-tabs--segmented .ui-tabs__list, .ui-segmented';
const PAINT = `
  .ui-tabs--segmented .ui-tabs__list, .ui-segmented { background: rgb(0 255 0) !important; outline: none !important; }
  .ui-tabs__indicator, .ui-segmented__indicator { background: rgb(255 0 0) !important; box-shadow: none !important; }
  .ui-tabs__tab, .ui-segmented__item { color: transparent !important; background: transparent !important; }
  .ui-tabs__tab *, .ui-segmented__item * { visibility: hidden !important; }
  :has(> .ui-segmented, > .ui-tabs__list) { background: rgb(0 0 255) !important; }
`;

function luminance([r, g, b]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const report = [];
for (const dpr of dprs) {
  // Настоящий масштаб экрана, а не эмуляция Playwright (`deviceScaleFactor`): эмуляция рисует страницу
  // на сетке CSS-пикселей и растягивает, а Windows на 125 % раскладывает в физических — и округляет
  // зазоры там. Только так замер совпадает с тем, что видит владелец.
  const browser = await chromium.launch({
    args: [`--force-device-scale-factor=${dpr}`, `--window-size=${width},${height}`],
  });
  const context = await browser.newContext({
    viewport: null,
    reducedMotion: 'reduce',
    locale: 'ru-RU',
  });
  const page = await context.newPage();
  await page.goto(new URL(route, base).href, { timeout: 600000, waitUntil: 'domcontentloaded' });
  await page.locator(TRACKS).first().waitFor({ timeout: 600000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  // Цвета — до перекраски: тема берётся от ближайшего [data-theme].
  const colors = await page.evaluate((selector) => {
    const rgb = (value) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    return [...document.querySelectorAll(selector)].map((track) => {
      const indicator = track.querySelector(
        ':scope > .ui-tabs__indicator, :scope > .ui-segmented__indicator',
      );
      const theme = track.closest('[data-theme]')?.getAttribute('data-theme') ?? 'root';
      return {
        theme,
        track: rgb(getComputedStyle(track).backgroundColor),
        thumb: indicator ? rgb(getComputedStyle(indicator).backgroundColor) : null,
      };
    });
  }, TRACKS);
  await page.screenshot({ path: path.join(out, `switchers-dpr${dpr}.png`), fullPage: true });
  await page.addStyleTag({ content: PAINT });
  const count = await page.locator(TRACKS).count();
  for (let index = 0; index < count; index++) {
    const track = page.locator(TRACKS).nth(index);
    if (!(await track.isVisible())) continue;
    await track.scrollIntoViewIfNeeded();
    const items = track.locator(':scope > .ui-tabs__tab, :scope > .ui-segmented__item');
    const total = await items.count();
    for (let position = 0; position < total; position++) {
      const item = items.nth(position);
      const disabled = await item.evaluate(
        (element) =>
          element.hasAttribute('data-disabled') || element.getAttribute('aria-disabled') === 'true',
      );
      if (disabled) continue;
      await item.click();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(80);
      const geometry = await track.evaluate((element) => {
        const indicator = element.querySelector(
          ':scope > .ui-tabs__indicator, :scope > .ui-segmented__indicator',
        );
        const box = (target) => {
          const rect = target.getBoundingClientRect();
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        };
        return {
          track: box(element),
          thumb: box(indicator),
          label: element.getAttribute('aria-label') ?? '',
        };
      });
      const shot = PNG.sync.read(await page.screenshot());
      const at = (x, y) => {
        const offset = (shot.width * y + x) << 2;
        return [shot.data[offset], shot.data[offset + 1], shot.data[offset + 2]];
      };
      // Покрытие пикселя: зелёный — дорожка (зазор), красный — плашка, синий — фон под дорожкой.
      // Сглаженный край даёт доли — зазор считается в физических пикселях с дробью.
      const { track: t, thumb: h } = geometry;
      const column = Math.floor(((h.left + h.right) / 2) * dpr);
      const row = Math.floor(((h.top + h.bottom) / 2) * dpr);
      const sum = (points) => {
        let before = 0;
        let after = 0;
        let thumb = 0;
        let trackSize = 0;
        let passed = false;
        for (const [x, y] of points) {
          // С настоящим масштабом края дорожки и плашки чёткие (прижаты к физическим пикселям):
          // пиксель либо чисто зелёный, либо чисто красный, либо чужой фон вокруг.
          const [r, g, b] = at(x, y);
          const red = r > 200 && g < 60 && b < 60 ? 1 : 0;
          const green = g > 200 && r < 60 && b < 60 ? 1 : 0;
          thumb += red;
          trackSize += red + green;
          if (red > 0.5) passed = true;
          if (red <= 0.5 && !passed) before += green;
          else if (red <= 0.5 && passed) after += green;
        }
        return {
          before: +before.toFixed(2),
          after: +after.toFixed(2),
          thumb: +thumb.toFixed(2),
          size: +trackSize.toFixed(2),
        };
      };
      const vertical = [];
      for (
        let y = Math.max(0, Math.floor((t.top - 4) * dpr));
        y < Math.min(shot.height, Math.ceil((t.bottom + 4) * dpr));
        y++
      )
        vertical.push([column, y]);
      const horizontal = [];
      for (
        let x = Math.max(0, Math.floor((t.left - 4) * dpr));
        x < Math.min(shot.width, Math.ceil((t.right + 4) * dpr));
        x++
      )
        horizontal.push([x, row]);
      const v = sum(vertical);
      const hz = sum(horizontal);
      report.push({
        dpr,
        track: index,
        label: geometry.label,
        item: position,
        of: total,
        theme: colors[index]?.theme,
        trackH: v.size,
        thumbH: v.thumb,
        top: v.before,
        bottom: v.after,
        left: position === 0 ? hz.before : null,
        right: position === total - 1 ? hz.after : null,
        thumbLighter: colors[index]?.thumb && luminance(colors[index].thumb) > luminance(colors[index].track),
      });
    }
  }
  await context.close();
  await browser.close();
}
writeFileSync(path.join(out, 'switchers.json'), JSON.stringify(report, null, 1));
// Ровно — разница меньше пятой доли физического пикселя (сглаживание краёв даёт сотые).
const off = (a, b) => Math.abs(a - b) > 0.2;
const bad = report.filter(
  (row) =>
    off(row.top, row.bottom) ||
    (row.left !== null && off(row.left, row.top)) ||
    (row.right !== null && off(row.right, row.top)) ||
    !row.thumbLighter,
);
for (const row of report)
  console.log(
    `dpr ${row.dpr} #${row.track} ${row.theme} «${row.label}» ${row.item + 1}/${row.of}: дорожка ${row.trackH}, плашка ${row.thumbH}, зазор ↑${row.top} ↓${row.bottom}` +
      (row.left !== null ? ` ←${row.left}` : '') +
      (row.right !== null ? ` →${row.right}` : '') +
      (row.thumbLighter ? '' : ' · плашка НЕ светлее'),
  );
console.log(`итог: ${report.length} положений, кривых ${bad.length}`);
