#!/usr/bin/env node
// Кладёт PNG снимков в кадры Figma (E15-A). На входе два JSON:
//   --uploads  ответ `upload_assets` (uploads: [{ submitUrl, targetNodeId }])
//   --nodes    карта «узел → файл» из ответа `use_figma` на код `figma-build.mjs`,
//   или --plan (порядок файлов из `figma-build.mjs --plan`) и --offset (с какого файла эта пачка)
//
//   node scripts/figma-upload.mjs --uploads /tmp/up.json --nodes /tmp/nodes.json
//   node scripts/figma-upload.mjs --uploads /tmp/up.json --plan /tmp/plan.json --offset 60
//
// Каждая ссылка одноразовая и живёт 10 минут; загрузка идёт по четыре параллельно.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const dir = path.resolve(args.dir ?? '../backlog/screens/figma');
// --uploads: ответ upload_assets (JSON) или просто uuid ссылок по строке — адрес собирается сам.
const raw = readFileSync(args.uploads, 'utf8').trim();
const page = encodeURIComponent(args.page ?? '0:1');
const uploads =
  raw.startsWith('{') || raw.startsWith('[')
    ? JSON.parse(raw)
    : raw.split(/\s+/).map((id) => ({
        submitUrl: `https://mcp.figma.com/mcp/upload/${id}/submit?scaleMode=FILL&currentPageId=${page}`,
      }));
// Файл для ссылки: по карте «узел → файл» (--nodes) или по номеру в плане figma-build (--plan, --offset).
const nodes = args.nodes ? JSON.parse(readFileSync(args.nodes, 'utf8')) : null;
const plan = args.plan ? JSON.parse(readFileSync(args.plan, 'utf8')) : null;
const offset = Number(args.offset ?? 0);
const list = (uploads.uploads ?? uploads).map((u, i) => ({
  url: u.submitUrl ?? u,
  node: u.targetNodeId ?? '',
  file: nodes ? nodes[u.targetNodeId] : plan[offset + i],
}));

let failed = 0;
const queue = [...list];
async function worker() {
  for (let job = queue.shift(); job; job = queue.shift()) {
    if (!job.file) {
      console.log(`✗ ${job.node}: нет файла в карте`);
      failed++;
      continue;
    }
    const form = new FormData();
    form.append('file', new Blob([readFileSync(path.join(dir, job.file))], { type: 'image/png' }), job.file);
    const response = await fetch(job.url, { method: 'POST', body: form });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.success) console.log(`✓ ${job.file} → ${body.placedOnNodeId}`);
    else {
      failed++;
      console.log(`✗ ${job.file}: ${response.status} ${JSON.stringify(body).slice(0, 200)}`);
    }
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
console.log(`${list.length - failed} из ${list.length}`);
process.exit(failed ? 1 : 0);
