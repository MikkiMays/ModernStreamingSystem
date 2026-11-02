// Грубый предпросмотр файла доски: SVG из элементов → PNG через Chromium (проверить раскладку на глаз).
// node preview.mjs board.json out.png [scale] [x0 y0 x1 y1]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const [file, out, scaleArg, ...crop] = process.argv.slice(2);
const doc = JSON.parse(readFileSync(file, 'utf8'));
const els = doc.elements;
const minX = Math.min(...els.map((e) => e.x)) - 40, minY = Math.min(...els.map((e) => e.y)) - 40;
const maxX = Math.max(...els.map((e) => e.x + e.width)) + 40, maxY = Math.max(...els.map((e) => e.y + e.height)) + 40;
const [vx0, vy0, vx1, vy1] = crop.length === 4 ? crop.map(Number) : [minX, minY, maxX, maxY];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
let svg = '';
for (const e of els) {
  const dash = e.strokeStyle === 'dashed' ? 'stroke-dasharray="8 6"' : '';
  const fill = e.backgroundColor === 'transparent' ? 'none' : e.backgroundColor;
  if (e.type === 'frame') {
    svg += `<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" rx="8" fill="#fafafa" stroke="${e.strokeColor}" stroke-width="1.5"/>`;
    svg += `<text x="${e.x}" y="${e.y - 8}" font-size="22" font-family="Nunito, sans-serif" fill="#555">${esc(e.name)}</text>`;
  } else if (e.type === 'rectangle') svg += `<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" rx="${e.roundness ? 12 : 0}" fill="${fill}" stroke="${e.strokeColor}" stroke-width="${e.strokeWidth}" ${dash}/>`;
  else if (e.type === 'ellipse') svg += `<ellipse cx="${e.x + e.width / 2}" cy="${e.y + e.height / 2}" rx="${e.width / 2}" ry="${e.height / 2}" fill="${fill}" stroke="${e.strokeColor}" stroke-width="2"/>`;
  else if (e.type === 'arrow') {
    const [p0, p1] = [e.points[0], e.points.at(-1)];
    svg += `<line x1="${e.x + p0[0]}" y1="${e.y + p0[1]}" x2="${e.x + p1[0]}" y2="${e.y + p1[1]}" stroke="${e.strokeColor}" stroke-width="${e.strokeWidth}" ${dash} marker-end="url(#a)"/>`;
  }
}
for (const e of els.filter((x) => x.type === 'text')) {
  const lines = e.text.split('\n');
  const lh = e.fontSize * 1.25;
  let cx = e.x + e.width / 2, anchor = 'middle', y0 = e.y + e.height / 2 - (lines.length * lh) / 2 + e.fontSize;
  if (e.containerId) {
    const c = els.find((x) => x.id === e.containerId);
    if (c.type === 'arrow') { const p = c.points.at(-1); cx = c.x + p[0] / 2; y0 = c.y + p[1] / 2 - (lines.length * lh) / 2 + e.fontSize; }
    else { cx = c.x + c.width / 2; y0 = c.y + c.height / 2 - (lines.length * lh) / 2 + e.fontSize; }
    if (e.textAlign === 'left') { anchor = 'start'; cx = c.x + 12; }
  } else if (e.textAlign === 'left') { anchor = 'start'; cx = e.x; y0 = e.y + e.fontSize; }
  const bg = e.containerId && els.find((x) => x.id === e.containerId)?.type === 'arrow';
  if (bg) { const w = Math.max(...lines.map((l) => l.length)) * e.fontSize * 0.56; svg += `<rect x="${cx - w / 2}" y="${y0 - e.fontSize}" width="${w}" height="${lines.length * lh}" fill="#fff" opacity="0.85"/>`; }
  svg += `<text x="${cx}" y="${y0}" font-size="${e.fontSize}" font-family="Nunito, DejaVu Sans, sans-serif" fill="${e.strokeColor}" text-anchor="${anchor}">${lines.map((l, i) => `<tspan x="${cx}" dy="${i ? lh : 0}">${esc(l)}</tspan>`).join('')}</text>`;
}
const W = vx1 - vx0, H = vy1 - vy0;
const scale = Number(scaleArg ?? 0.5);
const html = `<html><body style="margin:0;background:#fff"><svg xmlns="http://www.w3.org/2000/svg" width="${W * scale}" height="${H * scale}" viewBox="${vx0} ${vy0} ${W} ${H}"><defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#555"/></marker></defs>${svg}</svg></body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Math.ceil(W * scale), height: Math.ceil(H * scale) } });
await page.setContent(html);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log('ok', Math.round(W), Math.round(H));
