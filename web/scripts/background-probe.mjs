#!/usr/bin/env node
// Проверка фона в видео (R186) настоящим Chromium с поддельной камерой из ролика:
//   node scripts/background-probe.mjs --base http://127.0.0.1:5199 --camera /path/person.y4m \
//     --out ../backlog/screens/R186/after --mode after --bg blur-strong,blur-light,image-forest [--seconds 12]
//
// Открывает стенд `scripts/background-harness/` (dev-сервер Vite), ждёт `seconds`, снимает кадр выхода
// в PNG и печатает статистику: кадров на выходе в секунду, цена кадра у обработчика, ступень сторожа.
// Ролик для камеры — Y4M (`scripts/fake-camera.mjs` или ffmpeg → PNG → Y4M); Chromium крутит его по кругу.
// На сервере без видеокарты WebGL2 — SwiftShader: цифры здесь пессимистичны, важны относительные.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://127.0.0.1:5199');
const camera = arg('camera');
const out = arg('out', '/tmp/cord-background');
const mode = arg('mode', 'after');
const seconds = Number(arg('seconds', 12));
const size = arg('size', '640x360');
const [width, height] = size.split('x').map(Number);
const backgrounds = arg('bg', 'blur-strong,blur-light,image-forest').split(',');
if (!camera) {
  console.error('нужен --camera <файл.y4m>');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-video-capture=${camera}`,
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const results = [];
for (const bg of backgrounds) {
  const page = await browser.newPage({ viewport: { width: 680, height: 420 } });
  const logs = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(
    `${base}/scripts/background-harness/index.html?mode=${mode}&bg=${bg}&width=${width}&height=${height}`,
  );
  await page.waitForTimeout(seconds * 1000);
  const harness = await page.evaluate(() => window.harness);
  const file = join(out, `${mode}-${bg}-${size}.png`);
  await page.locator('#out').screenshot({ path: file });
  results.push({ bg, file, ...harness });
  console.log(
    `${mode} ${bg}: fps=${harness.outputFps} cost=${harness.costMs}ms segment=${harness.segmentMs}ms level=${harness.level} transport=${harness.transport} ready=${harness.ready} ${harness.error}`,
  );
  const bad = logs.filter((l) => /error|warn|failed/i.test(l));
  if (bad.length) console.log('  консоль:', bad.slice(0, 8).join('\n  '));
  await page.close();
}
await browser.close();
console.log(JSON.stringify(results, null, 1));
