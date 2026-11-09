// Нагрузчик: CONC параллельных keep-alive запросов к URL в течение SEC секунд, считает байты. node bench-client.mjs URL CONC SEC
import http from 'node:http'; import https from 'node:https';
const [url, conc, sec] = [process.argv[2], +process.argv[3], +process.argv[4]];
const u = new URL(url); const mod = u.protocol === 'https:' ? https : http;
const agent = new mod.Agent({ keepAlive: true, maxSockets: conc, rejectUnauthorized: false });
let bytes = 0, reqs = 0, errs = 0; const t0 = Date.now(); const end = t0 + sec * 1000;
function one(i) { return new Promise((res) => { const r = mod.get({ hostname: u.hostname, port: u.port, path: `/seg/${i}`, agent, rejectUnauthorized: false }, (resp) => { resp.on('data', (c) => (bytes += c.length)); resp.on('end', () => { reqs++; res(); }); }); r.on('error', () => { errs++; res(); }); }); }
async function worker(w) { let i = 0; while (Date.now() < end) await one(w * 100000 + i++); }
await Promise.all(Array.from({ length: conc }, (_, w) => worker(w)));
const s = (Date.now() - t0) / 1000;
console.log(JSON.stringify({ url, conc, secs: +s.toFixed(1), reqs, errs, mbps: +((bytes * 8) / s / 1e6).toFixed(0) }));
