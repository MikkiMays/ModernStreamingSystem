// Нагрузка на доску (теневое ядро): R встреч по N человек, доска открыта, у каждого сокет доски; курсор —
// каждые PRESENCE_MS (браузер — не чаще 33 мс, пока мышь движется), правка (новый прямоугольник) — каждые OPS_MS.
// Меряет задержку курсора и правок у соседей, пропускную способность, закрытия сокетов.
//
// node boardlt.mjs ROOMS MEMBERS PRESENCE_MS OPS_MS DURATION_S [label]
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = process.env.LOAD_OUT ?? fileURLToPath(new URL('../../.local/load/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const BASE = process.env.CORE ?? 'http://127.0.0.1:18080';
const [ROOMS, MEMBERS, PRESENCE_MS, OPS_MS, DURATION] = process.argv.slice(2, 7).map(Number);
const LABEL = process.argv[7] ?? `board-r${ROOMS}n${MEMBERS}`;
const st = { presLat: [], opsLat: [], presIn: 0, opsIn: 0, presOut: 0, opsOut: 0, closes: {}, errors: {} };
const err = (k) => (st.errors[k] = (st.errors[k] ?? 0) + 1);
const profile = () => randomBytes(32).toString('base64url');

async function api(path, { method = 'GET', body, credential, headers = {} } = {}) {
  const r = await fetch(BASE + '/api/v1' + path, {
    method, body: body && JSON.stringify(body),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...headers },
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

function rect(i) {
  return { id: randomUUID(), type: 'rectangle', version: 1, versionNonce: Math.floor(Math.random() * 2 ** 31), isDeleted: false,
    x: (i % 50) * 30, y: Math.floor(i / 50) * 30, width: 20, height: 20, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null,
    seed: Math.floor(Math.random() * 2 ** 31), boundElements: null, updated: Date.now(), link: null, locked: false, index: null };
}

const peers = [];
for (let r = 0; r < ROOMS; r++) {
  try {
    const c = await api('/rooms', { method: 'POST', body: { commandId: randomUUID(), name: `host${r}`, title: `board ${r}` }, headers: { 'X-Cord-Profile': profile() } });
    await api(`/rooms/${c.roomId}/commands`, { method: 'POST', body: { commandId: randomUUID(), type: 'board.open' }, credential: c.credential });
    const room = [c];
    const invite = decodeURIComponent(new URL(c.inviteUrl).hash.match(/invite=([^&]+)/)[1]);
    for (let i = 1; i < MEMBERS; i++)
      room.push(await api(`/rooms/${c.roomId}/join`, { method: 'POST', body: { commandId: randomUUID(), invite, name: `m${i}` }, headers: { 'X-Cord-Profile': profile() } }));
    peers.push(...room);
  } catch (e) { err('join:' + String(e.message).slice(0, 80)); }
}
let n = 0;
const sockets = await Promise.all(peers.map((a) => new Promise((resolve) => {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/api/v1/board');
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', roomId: a.roomId, credential: a.credential, epoch: 0, since: 0 }));
  ws.onmessage = (m) => {
    const p = JSON.parse(String(m.data));
    if (p.type === 'hello') resolve(ws);
    else if (p.type === 'presence') { st.presIn++; if (p.t) st.presLat.push(Date.now() - p.t); }
    else if (p.type === 'ops' && !p.replay) { st.opsIn++; if (p.t) st.opsLat.push(Date.now() - p.t); }
    else if (p.type === 'error') err('srv:' + p.code);
  };
  ws.onclose = (e) => { st.closes[e.code] = (st.closes[e.code] ?? 0) + 1; resolve(ws); };
  ws.onerror = () => err('ws-error');
})));
console.error(`board sockets: ${sockets.filter((s) => s.readyState === 1).length}/${peers.length}`);
const timers = [];
const start = Date.now();
for (const ws of sockets) {
  let k = Math.random() * 1000;
  timers.push(setInterval(() => {
    if (ws.readyState !== 1) return;
    k += 7;
    ws.send(JSON.stringify({ type: 'presence', x: 500 + 300 * Math.sin(k / 100), y: 400 + 200 * Math.cos(k / 130), tool: 'pointer', button: 'up', t: Date.now() }));
    st.presOut++;
  }, PRESENCE_MS));
  if (OPS_MS > 0)
    timers.push(setInterval(() => {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: 'ops', els: [rect(n++)], t: Date.now() }));
      st.opsOut++;
    }, OPS_MS));
}
await new Promise((r) => setTimeout(r, DURATION * 1000));
timers.forEach(clearInterval);
sockets.forEach((s) => s.close());
const secs = (Date.now() - start) / 1000;
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
const out = { label: LABEL, rooms: ROOMS, members: MEMBERS, people: peers.length, presenceMs: PRESENCE_MS, opsMs: OPS_MS,
  pres_out_per_s: Math.round(st.presOut / secs), pres_in_per_s: Math.round(st.presIn / secs), ops_out_per_s: +(st.opsOut / secs).toFixed(1), ops_in_per_s: Math.round(st.opsIn / secs),
  pres_ms_p50: pct(st.presLat, 0.5), pres_ms_p95: pct(st.presLat, 0.95), pres_ms_p99: pct(st.presLat, 0.99),
  ops_ms_p50: pct(st.opsLat, 0.5), ops_ms_p95: pct(st.opsLat, 0.95), ops_ms_p99: pct(st.opsLat, 0.99), closes: st.closes, errors: st.errors };
console.log(JSON.stringify(out));
writeFileSync(`${OUT}/${LABEL}.json`, JSON.stringify(out, null, 1));
process.exit(0);
