#!/usr/bin/env node
/**
 * Облик установщика (T54, П15) из марки и токенов — без графического редактора.
 *
 * Рисует SVG по токенам `styles/tokens.css`, растрирует Chromium из Playwright (он уже стоит
 * для e2e) и складывает в `brand/installer/` в корне репозитория:
 *   sidebar.png / sidebar.bmp     164×314 — боковая картинка мастера NSIS (electron-builder
 *                                 `installerSidebar`, `uninstallerSidebar`)
 *   header.png / header.bmp       150×57  — шапка мастера (`installerHeader`)
 *   sidebar@2x.png, header@2x.png — для высокого DPI (NSIS берёт BMP 1×; 2× — для Squirrel/своих страниц)
 *   icon.ico                      16…256  — иконка установщика и ярлыка (`installerIcon`, `icon`)
 *   icon-256.png, splash.png      заставка обновления 600×400
 *
 * Запуск из `web/`: `node scripts/brand/installer-art.mjs`. Ссылок и текста на картинках нет
 * (П15): только знак, слово-рисунок и цвет.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { theme } from '../check-contrast.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = join(here, '..', '..', '..', 'brand', 'installer');
mkdirSync(out, { recursive: true });

const tokens = readFileSync(join(here, '..', '..', 'src', 'styles', 'tokens.css'), 'utf8');
const dark = theme(tokens, 'dark');
const ACCENT = dark['--palette-blue-500'];
const BG = dark['--palette-ink-900'];
const BG_2 = dark['--palette-ink-800'];
const TEXT = dark['--palette-ink-50'];
/** Контуры слова из `wordmark-paths.ts` без TypeScript: файл маленький, значения — строки. */
const { WORD_PATH, DOT_PATH } = (() => {
  const src = readFileSync(join(here, '..', '..', 'src', 'ui', 'brand', 'wordmark-paths.ts'), 'utf8');
  const pick = (name) => /'([^']+)'/.exec(src.slice(src.indexOf(`export const ${name}`)))?.[1] ?? '';
  return { WORD_PATH: pick('WORD_PATH'), DOT_PATH: pick('DOT_PATH') };
})();

const bars = (fill) => `
  <g fill="${fill}">
    <rect x="2" y="6" width="6" height="18" rx="3" transform="rotate(-15 5 15)"/>
    <rect x="12" y="0.5" width="6" height="29" rx="3" transform="rotate(-15 15 15)"/>
    <rect x="22" y="4" width="6" height="22" rx="3" transform="rotate(-15 25 15)"/>
  </g>`;

/** Знак на плите акцентного цвета — как `AppIcon`, `Cord.ico` и иконки PWA. */
const icon = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">
  <rect width="48" height="48" rx="11" fill="${ACCENT}"/>
  <g transform="translate(9 9)">${bars('#fff')}</g>
</svg>`;

/** Марка: знак и слово-рисунок одной высоты, 30 px в системе логотипа. */
const lockup = (scale, color = TEXT) => `
  <g transform="scale(${scale})">
    ${bars(ACCENT)}
    <path fill="${color}" d="${WORD_PATH}"/>
    <path fill="${ACCENT}" d="${DOT_PATH}"/>
  </g>`;

/** Боковая картинка: тёмная сцена, плита знака с мягкой тенью, марка внизу. 164×314. */
const sidebar = (w, h) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 164 314">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BG_2}"/><stop offset="1" stop-color="${BG}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.42" r="0.6">
      <stop offset="0" stop-color="${ACCENT}" stop-opacity="0.28"/><stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
    <filter id="shadow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="10"/>
      <feOffset dy="14"/><feComponentTransfer><feFuncA type="linear" slope="0.55"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="164" height="314" fill="url(#bg)"/>
  <rect width="164" height="314" fill="url(#glow)"/>
  <g transform="translate(42 92)" filter="url(#shadow)">
    <rect width="80" height="80" rx="18" fill="${ACCENT}"/>
    <g transform="translate(15 15) scale(1.6667)">${bars('#fff')}</g>
  </g>
  <g transform="translate(28 248)">${lockup(1)}</g>
</svg>`;

/** Шапка мастера: марка слева на фоне окна. 150×57. */
const header = (w, h) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 150 57">
  <rect width="150" height="57" fill="#ffffff"/>
  <g transform="translate(14 14)">${lockup(1, '#1b1f27')}</g>
</svg>`;

/** Заставка обновления: сцена как в загрузке, статичный кадр. 600×400. */
const splash = () => `
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">
  <defs>
    <radialGradient id="g2" cx="0.5" cy="0.45" r="0.55">
      <stop offset="0" stop-color="${ACCENT}" stop-opacity="0.22"/><stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
    <filter id="sh2" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="14"/><feOffset dy="20"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.5"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="600" height="400" fill="${BG}"/>
  <rect width="600" height="400" fill="url(#g2)"/>
  <g transform="translate(244 112)" filter="url(#sh2)">
    <rect width="112" height="112" rx="26" fill="${ACCENT}"/>
    <g transform="translate(21 21) scale(2.3333)">${bars('#fff')}</g>
  </g>
  <g transform="translate(246 300)">${lockup(1)}</g>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
page.setDefaultTimeout(240_000);

/** Растрирует SVG в PNG; `scale` 2 — для высокого DPI (размер в пикселях удваивается). */
async function raster(svg, width, height, scale = 1) {
  const view = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  view.setDefaultTimeout(240_000);
  await view.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`,
  );
  const png = await view.screenshot({ omitBackground: true });
  await view.close();
  return png;
}

/** Сырые пиксели RGBA для BMP: SVG рисуется через `<img>` на canvas (createImageBitmap SVG не берёт). */
async function pixels(svg, width, height) {
  await page.setViewportSize({ width, height });
  await page.setContent('<!doctype html><html><body style="margin:0"></body></html>');
  return page.evaluate(
    async ([markup, w, h]) => {
      const img = new Image(w, h);
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      return Array.from(ctx.getImageData(0, 0, w, h).data);
    },
    [svg, width, height],
  );
}

/** 24-битный BMP без сжатия: NSIS принимает только его. Строки снизу вверх, BGR, выравнивание 4. */
function bmp(rgba, width, height) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const o = (height - 1 - y) * row + x * 3;
      const a = rgba[i + 3] / 255;
      // прозрачное — на белом, как фон окна мастера
      data[o] = Math.round(rgba[i + 2] * a + 255 * (1 - a));
      data[o + 1] = Math.round(rgba[i + 1] * a + 255 * (1 - a));
      data[o + 2] = Math.round(rgba[i] * a + 255 * (1 - a));
    }
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + data.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(data.length, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);
  return Buffer.concat([header, data]);
}

/** ICO из PNG-кадров (Vista+): таблица входов и сами PNG подряд. */
function ico(frames) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  const entries = [];
  let offset = 6 + frames.length * 16;
  for (const { size, png } of frames) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([head, ...entries, ...frames.map((f) => f.png)]);
}

const write = (name, buffer) => {
  writeFileSync(join(out, name), buffer);
  console.log(`${name} ${buffer.length} байт`);
};

write('sidebar.png', await raster(sidebar(164, 314), 164, 314));
write('sidebar@2x.png', await raster(sidebar(164, 314), 164, 314, 2));
write('sidebar.bmp', bmp(await pixels(sidebar(164, 314), 164, 314), 164, 314));
write('header.png', await raster(header(150, 57), 150, 57));
write('header@2x.png', await raster(header(150, 57), 150, 57, 2));
write('header.bmp', bmp(await pixels(header(150, 57), 150, 57), 150, 57));
write('splash.png', await raster(splash(), 600, 400));
const frames = [];
for (const size of [16, 24, 32, 48, 64, 128, 256])
  frames.push({ size, png: await raster(icon(size), size, size) });
write('icon-256.png', frames.at(-1).png);
write('icon.ico', ico(frames));
await browser.close();
