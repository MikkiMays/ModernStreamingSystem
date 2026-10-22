// Плавность ползунка настроек (R14, Ц10): три секунды перетаскивания «Громкости собеседников»
// мышью — сколько записей настроек в `localStorage` приходится на кадр, сколько кадров длиннее 50 мс
// и сколько длинных задач. Отчёт — JSON и картинка времён кадров рядом.
//
//   node scripts/slider-perf.mjs --base http://127.0.0.1:5201 --out ../backlog/screens/R103/W2/after
//   node scripts/slider-perf.mjs --base https://cord.nikg.tech --out ../backlog/screens/R103/W2/before
//
// Ищет раздел «Звук» (до R100 — «Голос и видео»). Скрипт лежит внутри web/: `@playwright/test`
// резолвится от файла.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const base = args.base ?? 'https://cord.nikg.tech';
const out = path.resolve(args.out ?? 'shots');
const seconds = Number(args.seconds ?? 3);
// Для разбора: свой CSS поверх страницы (`--style '.settings-backdrop{backdrop-filter:none}'`).
const style = args.style;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
await context.addInitScript(() => {
  // Записи настроек и кадры — с отметкой времени; кадр — промежуток между двумя rAF.
  const probe = { writes: [], frames: [], long: [] };
  window.__probe = probe;
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (key === 'cord:preferences:v1') probe.writes.push(performance.now());
    return setItem.call(this, key, value);
  };
  const tick = (time) => {
    probe.frames.push(time);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        probe.long.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* без longtask — только кадры */
  }
});
const page = await context.newPage();
await page.goto(base);
if (style) await page.addStyleTag({ content: style });
await page.getByRole('button', { name: /Новая встреча/ }).waitFor({ timeout: 30000 });
await page.getByRole('button', { name: 'Настройки', exact: true }).filter({ visible: true }).first().click();
const nav = page.getByRole('navigation', { name: 'Разделы настроек' });
const audio = nav.getByRole('button', { name: 'Звук', exact: true });
await (
  (await audio.count()) ? audio : nav.getByRole('button', { name: 'Голос и видео', exact: true })
).click();
const slider = page.getByRole('slider', { name: 'Громкость собеседников' });
await slider.scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
const box = await slider.boundingBox();
const y = box.y + box.height / 2;
const steps = Math.round(seconds * 60);
const started = await page.evaluate(() => performance.now());
await page.mouse.move(box.x + box.width - 4, y);
await page.mouse.down();
// Туда и обратно по всей дорожке, шаг — кадр.
for (let i = 0; i <= steps; i++) {
  const phase = i / steps;
  const along = phase < 0.5 ? 1 - phase * 2 : (phase - 0.5) * 2;
  await page.mouse.move(box.x + 4 + along * (box.width - 8), y);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.waitForTimeout(300);
const probe = await page.evaluate((from) => {
  const p = window.__probe;
  const frames = p.frames.filter((time) => time >= from);
  const deltas = frames.slice(1).map((time, index) => time - frames[index]);
  // Записей на кадр: сколько записей легло между соседними кадрами.
  let worst = 0;
  for (let i = 1; i < frames.length; i++) {
    const count = p.writes.filter((time) => time >= frames[i - 1] && time < frames[i]).length;
    worst = Math.max(worst, count);
  }
  return {
    frames: deltas.length,
    framesOver50ms: deltas.filter((delta) => delta > 50).length,
    worstFrameMs: Math.round(Math.max(0, ...deltas)),
    writes: p.writes.filter((time) => time >= from).length,
    maxWritesPerFrame: worst,
    longTasks: p.long.filter((entry) => entry.start >= from).map((entry) => Math.round(entry.duration)),
    deltas: deltas.map((delta) => Math.round(delta * 10) / 10),
  };
}, started);
const step = await slider.getAttribute('step');
const report = { base, step, seconds, ...(style ? { style } : {}), ...probe, deltas: undefined };
const name = args.name ?? 'slider-perf';
writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ ...report, deltas: probe.deltas }, null, 2));
// Картинка: столбик на кадр, красная линия — 50 мс.
const chart = await browser.newPage({ viewport: { width: 900, height: 320 } });
await chart.setContent(`<canvas id="c" width="900" height="320"></canvas><script>
  const d = ${JSON.stringify(probe.deltas)}; const c = document.getElementById('c').getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, 900, 320); const w = 880 / Math.max(1, d.length);
  for (let i = 0; i < d.length; i++) { const h = Math.min(260, d[i] * 3); c.fillStyle = d[i] > 50 ? '#d33' : '#2b6cff'; c.fillRect(10 + i * w, 280 - h, Math.max(1, w - 1), h); }
  c.strokeStyle = '#d33'; c.beginPath(); c.moveTo(10, 280 - 150); c.lineTo(890, 280 - 150); c.stroke();
  c.fillStyle = '#111'; c.font = '14px sans-serif';
  c.fillText(${JSON.stringify(`Кадры при перетаскивании ${seconds} с (${base}): шаг ${step}, записей ${probe.writes}, max/кадр ${probe.maxWritesPerFrame}, кадров > 50 мс ${probe.framesOver50ms}, худший ${probe.worstFrameMs} мс`)}, 10, 20);
  c.fillText('линия — 50 мс', 10, 300);
</script>`);
await chart.screenshot({ path: path.join(out, `${name}.png`) });
await browser.close();
console.log(JSON.stringify(report));
