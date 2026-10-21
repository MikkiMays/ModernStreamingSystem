#!/usr/bin/env node
// Выгрузка SVG/PNG в Figma по адресам `upload_assets` (E15-B). Адреса отличаются только UUID —
// поэтому на вход идут UUID и страница, а не полные ссылки.
//
//   node scripts/figma-svg-upload.mjs --page 12:3 --dir ../backlog/screens/figma \
//        uuid1=home-1440-dark.svg uuid2=home-1440-light.svg …
//
// Печатает JSON: [{file, node}] — id кадра, который Figma поставила на страницу. Имя кадра — имя файла
// без расширения (multipart, поле `file`).
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
let page = opt('page');
const dir = path.resolve(opt('dir', '../backlog/screens/figma'));
const log = opt('log', path.join(dir, 'uploads.jsonl'));
let pairs = argv.filter((a) => a.includes('=') && !a.startsWith('--'));
// --uuids a,b,c --files x.svg,y.svg,z.svg — те же пары короче (по порядку).
// --latest: адреса последнего ответа `upload_assets` из журнала этой сессии агента (CLAUDE_TRANSCRIPT),
// чтобы не переписывать UUID руками. Использованные UUID помнятся в uploads.jsonl и второй раз не берутся.
let latestPage = null;
if (argv.includes('--latest')) {
  const transcript = process.env.CLAUDE_TRANSCRIPT;
  if (!transcript) throw new Error('нужен CLAUDE_TRANSCRIPT');
  const lines = readFileSync(transcript, 'utf8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('submitUrl') || !line.includes('tool_result')) continue;
    const found = [...line.matchAll(/mcp\/upload\/([0-9a-f-]{36})\/submit\?scaleMode=FILL(?:&|\\u0026)currentPageId=(\d+)%3A(\d+)/g)];
    if (!found.length) continue;
    const used = existsSync(log) ? readFileSync(log, 'utf8') : '';
    const seen = new Set();
    const fresh = found.filter((m) => !used.includes(m[1]) && !seen.has(m[1]) && seen.add(m[1]));
    if (!fresh.length) throw new Error('последние адреса уже использованы');
    latestPage = `${found[0][2]}:${found[0][3]}`;
    argv.push('--uuids', fresh.map((m) => m[1]).join(','));
    page ??= latestPage;
    break;
  }
}
if (opt('uuids')) {
  const uuids = opt('uuids').split(',');
  // --plan <страница> [--from N]: файлы по каталогу (figma-plan.mjs), N-й и дальше — сколько UUID.
  const from = Number(opt('from', 0));
  const files = opt('plan')
    ? (await import('./figma-plan.mjs')).filesFor(opt('plan')).slice(from, from + uuids.length)
    : opt('files').split(',');
  if (uuids.length !== files.length) throw new Error(`UUID ${uuids.length}, файлов ${files.length}`);
  pairs = uuids.map((u, i) => `${u}=${files[i]}`);
}
const base = 'https://mcp.figma.com/mcp/upload';

async function send([uuid, file]) {
  const url = `${base}/${uuid}/submit?scaleMode=FILL${page ? `&currentPageId=${encodeURIComponent(page)}` : ''}`;
  let bytes = readFileSync(path.join(dir, file));
  // Импорт Figma теряет stroke-opacity: у фигур без заливки она становится прозрачностью фигуры
  // (снимки, сделанные до правки dom-svg.mjs).
  if (file.endsWith('.svg'))
    bytes = Buffer.from(
      bytes
        .toString('utf8')
        .replace(/<(rect|path|circle|line|polyline|polygon|ellipse)\b([^>]*?)\/?>/g, (tag, name, attrs) =>
          /fill="none"/.test(attrs) && /stroke-opacity="([\d.]+)"/.test(attrs) && !/\sopacity="/.test(attrs)
            ? tag.replace(/stroke-opacity="([\d.]+)"/, 'opacity="$1"')
            : tag,
        ),
    );
  const type = file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), path.basename(file));
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { method: 'POST', body: form });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.success) return { file, node: body.placedOnNodeId };
      if (attempt === 3) return { file, error: `${response.status} ${JSON.stringify(body).slice(0, 200)}` };
    } catch (error) {
      if (attempt === 3) return { file, error: String(error).slice(0, 200) };
    }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
}

const results = [];
const queue = pairs.map((p) => p.split('='));
const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
  while (queue.length) {
    const item = queue.shift();
    const result = await send(item);
    results.push(result);
    appendFileSync(log, JSON.stringify({ page, ...result }) + '\n');
  }
});
await Promise.all(workers);
console.log(JSON.stringify(results));
