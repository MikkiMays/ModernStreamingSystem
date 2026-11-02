// Нагрузка на ядро Cord (теневое, 127.0.0.1:18080): R встреч по N человек, сокет событий у каждого, как у
// браузера: ping раз в 2 с, на каждое новое событие — перечитать снимок (с той же склейкой, что meeting.ts),
// сообщение в чат раз в CHAT_MS у каждого. Меряет задержку «отправил → событие у соседей», «событие → снимок
// с сообщением», размер снимка, ошибки.
//
// node corelt.mjs ROOMS MEMBERS CHAT_MS DURATION_S [label]
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = process.env.LOAD_OUT ?? fileURLToPath(new URL('../../.local/load/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const BASE = process.env.CORE ?? 'http://127.0.0.1:18080';
const [ROOMS, MEMBERS, CHAT_MS, DURATION] = process.argv.slice(2, 6).map(Number);
const LABEL = process.argv[7] ?? process.argv[6] ?? `r${ROOMS}n${MEMBERS}`;
const stats = { eventLat: [], snapLat: [], snapBytes: [], msgVisible: [], errors: {}, sent: 0, events: 0, snaps: 0, joins: [] };
const err = (k) => (stats.errors[k] = (stats.errors[k] ?? 0) + 1);
const profile = () => randomBytes(32).toString('base64url');

async function api(path, { method = 'GET', body, credential, headers = {} } = {}) {
  const t = performance.now();
  const r = await fetch(BASE + '/api/v1' + path, {
    method,
    body: body && JSON.stringify(body),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...headers },
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${text.slice(0, 120)}`);
  return { json: text ? JSON.parse(text) : null, bytes: text.length, ms: performance.now() - t };
}

class Member {
  constructor(admission) {
    this.a = admission;
    this.seq = 0;
    this.snapSeq = admission.snapshot.sequence;
    this.known = 0;
    this.refreshing = false;
    this.again = false;
    this.pending = new Map(); // текст → время отправки
  }
  open() {
    return new Promise((resolve) => {
      const ws = new WebSocket(BASE.replace('http', 'ws') + '/api/v1/events');
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', roomId: this.a.roomId, credential: this.a.credential, after: this.snapSeq }));
      ws.onmessage = (m) => {
        const p = JSON.parse(String(m.data));
        if (p.type === 'authenticated') {
          this.ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping', requestId: randomUUID() })), 2000);
          resolve();
        } else if (p.type === 'event') {
          stats.events++;
          const text = p.event.payload?.text ?? p.event.payload?.message?.text;
          if (p.event.type === 'message.created' && typeof text === 'string' && text.startsWith('lt:')) {
            stats.eventLat.push(Date.now() - Number(text.split(':')[1]));
          }
          this.known = Math.max(this.known, p.event.sequence);
          if (p.event.sequence > this.snapSeq) this.refresh();
        }
      };
      ws.onerror = () => err('ws-error');
      ws.onclose = () => { clearInterval(this.ping); if (!this.stopped) err('ws-closed'); resolve(); };
    });
  }
  async refresh() {
    if (this.refreshing) { this.again = true; return; }
    this.refreshing = true;
    do {
      this.again = false;
      try {
        const r = await api(`/rooms/${this.a.roomId}`, { credential: this.a.credential });
        stats.snaps++;
        stats.snapLat.push(r.ms);
        stats.snapBytes.push(r.bytes);
        this.snapSeq = Math.max(this.snapSeq, r.json.sequence);
        const now = Date.now();
        for (const msg of r.json.messages ?? []) {
          const t = typeof msg.text === 'string' && msg.text.startsWith('lt:') ? Number(msg.text.split(':')[1]) : 0;
          const key = msg.id ?? msg.messageId;
          if (t && !this.seen?.has(key)) { (this.seen ??= new Set()).add(key); stats.msgVisible.push(now - t); }
        }
      } catch (e) { err('snapshot:' + String(e.message).slice(0, 40)); }
    } while (this.again);
    this.refreshing = false;
  }
  chat() {
    if (this.ws?.readyState !== 1) return;
    const text = `lt:${Date.now()}:${randomBytes(4).toString('hex')}`;
    this.ws.send(JSON.stringify({ type: 'command', command: { commandId: randomUUID(), type: 'message.send', text } }));
    stats.sent++;
  }
  close() { this.stopped = true; clearInterval(this.ping); clearInterval(this.timer); this.ws?.close(); }
}

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
const members = [];
const t0 = Date.now();
for (let r = 0; r < ROOMS; r++) {
  try {
    const c = await api('/rooms', { method: 'POST', body: { commandId: randomUUID(), name: `host${r}`, title: `lt ${r}` }, headers: { 'X-Cord-Profile': profile() } });
    stats.joins.push(c.ms);
    const room = [new Member(c.json)];
    const invite = new URL(c.json.inviteUrl).hash.match(/invite=([^&]+)/)[1];
    for (let i = 1; i < MEMBERS; i++) {
      const j = await api(`/rooms/${c.json.roomId}/join`, { method: 'POST', body: { commandId: randomUUID(), invite: decodeURIComponent(invite), name: `m${i}` }, headers: { 'X-Cord-Profile': profile() } });
      stats.joins.push(j.ms);
      room.push(new Member(j.json));
    }
    members.push(...room);
  } catch (e) { err('join:' + String(e.message).slice(0, 60)); }
}
const joinedAt = Date.now();
await Promise.all(members.map((m) => m.open()));
console.error(`joined ${members.length} in ${(joinedAt - t0) / 1000}s, sockets in ${(Date.now() - joinedAt) / 1000}s`);
stats.eventLat = []; stats.snapLat = []; stats.snapBytes = []; stats.msgVisible = []; stats.events = 0; stats.snaps = 0;
const start = Date.now();
if (CHAT_MS > 0) for (const m of members) setTimeout(() => { m.chat(); m.timer = setInterval(() => m.chat(), CHAT_MS); }, Math.random() * CHAT_MS);
await new Promise((r) => setTimeout(r, DURATION * 1000));
for (const m of members) m.close();
const secs = (Date.now() - start) / 1000;
const out = {
  label: LABEL, rooms: ROOMS, members: MEMBERS, chatMs: CHAT_MS, duration: secs, people: members.length,
  join_ms_p50: pct(stats.joins, 0.5), join_ms_p95: pct(stats.joins, 0.95), join_ms_last: Math.round(stats.joins.at(-1) ?? 0),
  sent_per_s: +(stats.sent / secs).toFixed(1), events_per_s: +(stats.events / secs).toFixed(1), snaps_per_s: +(stats.snaps / secs).toFixed(1),
  event_ms_p50: pct(stats.eventLat, 0.5), event_ms_p95: pct(stats.eventLat, 0.95), event_ms_p99: pct(stats.eventLat, 0.99),
  visible_ms_p50: pct(stats.msgVisible, 0.5), visible_ms_p95: pct(stats.msgVisible, 0.95), visible_ms_p99: pct(stats.msgVisible, 0.99),
  snap_ms_p50: pct(stats.snapLat, 0.5), snap_ms_p95: pct(stats.snapLat, 0.95),
  snap_kb_avg: stats.snapBytes.length ? +(stats.snapBytes.reduce((a, b) => a + b, 0) / stats.snapBytes.length / 1024).toFixed(1) : null,
  snap_mbps: +((stats.snapBytes.reduce((a, b) => a + b, 0) * 8) / secs / 1e6).toFixed(1),
  errors: stats.errors,
};
console.log(JSON.stringify(out));
writeFileSync(`${OUT}/core-${LABEL}.json`, JSON.stringify(out, null, 1));
process.exit(0);
