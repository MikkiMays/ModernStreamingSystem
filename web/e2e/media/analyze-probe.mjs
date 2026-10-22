// Сводка по run.jsonl: по фазам и гостям — битрейт, потери, запас буфера, цель, заглушка, растяжение.
import { readFileSync } from 'node:fs';
const rows = readFileSync(process.argv[2], 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const marks = rows.filter((r) => r.who === '-');
console.log('метки:', marks.map((m) => `${m.phase}@${new Date(m.at).toISOString().slice(11, 19)}`).join(' '));
const byKey = new Map();
for (const r of rows) {
  if (r.who === '-') continue;
  const key = `${r.who}:${r.ssrc}`;
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push(r);
}
const pct = (a, b) => (b > 0 ? ((100 * a) / b).toFixed(2) + '%' : '-');
for (const [key, list] of byKey) {
  list.sort((a, b) => a.ts - b.ts);
  const phases = [...new Set(list.map((r) => r.phase))];
  console.log(`\n== ${key} (${list.length} отсчётов)`);
  for (const phase of phases) {
    const p = list.filter((r) => r.phase === phase);
    if (p.length < 2) continue;
    const a = p[0],
      b = p[p.length - 1];
    const dt = (b.ts - a.ts) / 1000;
    const kbps = ((b.bytes - a.bytes) * 8) / dt / 1000;
    const pk = b.packets - a.packets,
      lost = Math.max(0, b.lost - a.lost);
    const emitted = (b.jbEmitted ?? 0) - (a.jbEmitted ?? 0);
    const jb = emitted > 0 ? (((b.jbDelay ?? 0) - (a.jbDelay ?? 0)) / emitted) * 1000 : NaN;
    const total = (b.total ?? 0) - (a.total ?? 0);
    const conc = (b.concealed ?? 0) - (a.concealed ?? 0);
    const ev = (b.events ?? 0) - (a.events ?? 0);
    const decel = (b.decel ?? 0) - (a.decel ?? 0);
    const accel = (b.accel ?? 0) - (a.accel ?? 0);
    const disc = (b.discarded ?? 0) - (a.discarded ?? 0);
    const targets = p.map((r) => r.target).filter((v) => v !== null);
    const tmin = Math.min(...targets),
      tmax = Math.max(...targets);
    // Буфер по секундным интервалам: min/max
    const per = [];
    for (let i = 1; i < p.length; i++) {
      const e = (p[i].jbEmitted ?? 0) - (p[i - 1].jbEmitted ?? 0);
      if (e > 0) per.push((((p[i].jbDelay ?? 0) - (p[i - 1].jbDelay ?? 0)) / e) * 1000);
    }
    console.log(
      `  ${phase.padEnd(8)} ${dt.toFixed(0).padStart(4)}с  ${kbps.toFixed(0).padStart(4)} кбит/с  потери ${pct(lost, pk + lost)}  буфер ср ${jb.toFixed(0)} мс (${Math.min(...per).toFixed(0)}–${Math.max(...per).toFixed(0)})  цель ${tmin}→${tmax}  заглушка ${pct(conc, total)} (${ev} соб.)  растяж ${pct(decel, total)}  ускор ${pct(accel, total)}  выброшено ${disc}  джиттер ${(Math.max(...p.map((r) => r.jitter ?? 0)) * 1000).toFixed(0)} мс`,
    );
  }
  // Цель по времени (каждые ~10 с)
  const t0 = list[0].at;
  const line = list
    .filter((_, i) => i % 10 === 0)
    .map((r) => `${Math.round((r.at - t0) / 1000)}с→${r.target}`);
  console.log('  цель:', line.join(' '));
}
// Разброс буфера между гостями в одну секунду (A vs B vs C), по фазам
const phasesAll = [...new Set(rows.filter((r) => r.who !== '-').map((r) => r.phase))];
for (const phase of phasesAll) {
  const whos = [...new Set(rows.filter((r) => r.phase === phase && r.who !== '-').map((r) => r.who))];
  if (whos.length < 2) continue;
  const series = {};
  for (const w of whos) {
    const p = rows.filter((r) => r.phase === phase && r.who === w).sort((a, b) => a.ts - b.ts);
    const per = [];
    for (let i = 1; i < p.length; i++) {
      const e = (p[i].jbEmitted ?? 0) - (p[i - 1].jbEmitted ?? 0);
      if (e > 0) per.push({ at: p[i].at, ms: (((p[i].jbDelay ?? 0) - (p[i - 1].jbDelay ?? 0)) / e) * 1000 });
    }
    series[w] = per;
  }
  const tail = (w) => series[w].slice(-10).map((x) => x.ms);
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
  console.log(
    `\nразброс буфера (${phase}, последние 10 с):`,
    whos.map((w) => `${w}=${avg(tail(w)).toFixed(0)} мс`).join('  '),
    ' → макс разница',
    (Math.max(...whos.map((w) => avg(tail(w)))) - Math.min(...whos.map((w) => avg(tail(w))))).toFixed(0),
    'мс',
  );
}
