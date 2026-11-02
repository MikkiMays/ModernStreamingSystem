// Пропускная способность входа в ядро (теневое): сначала PRE встреч по одному человеку (фон строк `rooms`),
// затем волна TOTAL входов (половина — создание встречи, половина — вход по приглашению в уже созданные)
// с параллельностью CONC, как «все зашли в 19:00».
//
// node joinlt.mjs PRE TOTAL CONC [label]
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = process.env.LOAD_OUT ?? fileURLToPath(new URL('../../.local/load/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const BASE = process.env.CORE ?? 'http://127.0.0.1:18080';
const [PRE, TOTAL, CONC] = process.argv.slice(2, 5).map(Number);
const LABEL = process.argv[5] ?? `join-p${PRE}-c${CONC}`;
const profile = () => randomBytes(32).toString('base64url');
async function post(path, body) {
  const t = performance.now();
  const r = await fetch(BASE + '/api/v1' + path, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Cord-Profile': profile() }, signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 80)}`);
  return { json: JSON.parse(text), ms: performance.now() - t };
}
const create = (i) => post('/rooms', { commandId: randomUUID(), name: `h${i}`, title: `j ${i}` });
const invites = [];
for (let i = 0; i < PRE; i++) {
  const c = await create(i);
  if (i % 10 === 0) invites.push({ id: c.json.roomId, invite: decodeURIComponent(new URL(c.json.inviteUrl).hash.match(/invite=([^&]+)/)[1]) });
}
const lat = [];
const errors = {};
let next = 0;
const t0 = performance.now();
async function worker() {
  while (next < TOTAL) {
    const i = next++;
    try {
      if (i % 2 === 0 || !invites.length) lat.push((await create(100000 + i)).ms);
      else {
        const r = invites[i % invites.length];
        lat.push((await post(`/rooms/${r.id}/join`, { commandId: randomUUID(), invite: r.invite, name: `j${i}` })).ms);
      }
    } catch (e) { const k = String(e.message).slice(0, 40); errors[k] = (errors[k] ?? 0) + 1; }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
const secs = (performance.now() - t0) / 1000;
const s = [...lat].sort((a, b) => a - b);
const pct = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0);
const out = { label: LABEL, pre: PRE, total: TOTAL, conc: CONC, ok: lat.length, secs: +secs.toFixed(1), per_s: +(lat.length / secs).toFixed(1), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), errors };
console.log(JSON.stringify(out));
writeFileSync(`${OUT}/${LABEL}.json`, JSON.stringify(out, null, 1));
