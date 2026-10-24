// Разбор замера речи (R107): что услышал человек и что говорит NetEq.
//
// Огибающая приходит блоками по 384 отсчёта (8 мс при 48 кГц): `{ t, db }`, t — стенные часы начала блока (мс). Фраза —
// подряд звучащие блоки (паузы короче MERGE_MS считаются частью фразы: это и есть обрыв внутри
// неё). Обрыв — ≥ 2 блоков подряд на CUT_DB ниже местной медианы фразы: слоги «речи» из
// `gen-voice.mjs` проседают максимум на 7 дБ, так что 12 дБ — это уже не слог, а дыра.
import { PHRASES } from './gen-voice.mjs';

export const BLOCK_MS = 8;
const MERGE_MS = 250;
const CUT_DB = 12;
const EDGE_MS = 40;

const median = (values) => {
  if (!values.length) return -Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

/** Фразы и обрывы внутри них. */
export function phrases(blocks, { floorDb } = {}) {
  if (blocks.length < 2) return [];
  // Длина блока — по самим меткам: при 44,1 кГц те же 384 отсчёта длятся 8,7 мс.
  const step = (blocks[blocks.length - 1].t - blocks[0].t) / (blocks.length - 1);
  const loud = quantile(
    blocks.map((b) => b.db),
    0.9,
  );
  const on = floorDb ?? loud - 30;
  const found = [];
  let current = null;
  let quietSince = null;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const active = b.db > on;
    if (active) {
      if (!current) current = { first: i, last: i };
      current.last = i;
      quietSince = null;
    } else if (current) {
      quietSince ??= b.t;
      if (b.t - quietSince >= MERGE_MS) {
        found.push(current);
        current = null;
        quietSince = null;
      }
    }
  }
  if (current) found.push(current);
  return found
    .map(({ first, last }) => {
      const slice = blocks.slice(first, last + 1);
      const start = slice[0].t;
      const end = slice[slice.length - 1].t + step;
      const cuts = [];
      let run = null;
      for (let i = 0; i < slice.length; i++) {
        const b = slice[i];
        const inner = b.t - start >= EDGE_MS && end - b.t >= EDGE_MS;
        const window = slice
          .slice(Math.max(0, i - 25), i + 26)
          .map((x) => x.db)
          .filter((db) => db > on);
        const low = inner && b.db < median(window) - CUT_DB;
        if (low) {
          run ??= { start: b.t, blocks: 0 };
          run.blocks += 1;
        } else if (run) {
          if (run.blocks >= 2) cuts.push({ start: run.start, ms: Math.round(run.blocks * step) });
          run = null;
        }
      }
      if (run && run.blocks >= 2) cuts.push({ start: run.start, ms: Math.round(run.blocks * step) });
      const len = (end - start) / 1000;
      const sent = PHRASES.map(([l]) => l).reduce((best, l) =>
        Math.abs(l - len) < Math.abs(best - len) ? l : best,
      );
      return { start, end, len, sent, shortMs: Math.round((sent - len) * 1000), cuts };
    })
    .filter((p) => p.len >= 0.3);
}

/** Задержка «рот → ухо»: начало каждой услышанной фразы против начала той же фразы у говорящего. */
export function latency(sent, heard) {
  const out = [];
  for (const h of heard) {
    const match = sent
      .filter((s) => s.sent === h.sent && h.start - s.start >= 0 && h.start - s.start < 1500)
      .sort((a, b) => b.start - a.start)[0];
    if (match) out.push(h.start - match.start);
  }
  return out;
}

/** Итог по огибающей. */
export function heardSummary(list) {
  const cuts = list.flatMap((p) => p.cuts);
  const speechMs = list.reduce((sum, p) => sum + (p.end - p.start), 0);
  const short = list.map((p) => p.shortMs);
  return {
    phrases: list.length,
    speechSec: Math.round(speechMs / 100) / 10,
    cuts: cuts.length,
    cutsPerMin: speechMs ? Math.round((cuts.length / (speechMs / 60000)) * 10) / 10 : 0,
    cutMsTotal: cuts.reduce((s, c) => s + c.ms, 0),
    cutMax: cuts.reduce((m, c) => Math.max(m, c.ms), 0),
    cutsOver60: cuts.filter((c) => c.ms > 60).length,
    shortMedianMs: quantile(short, 0.5),
    shortP90Ms: quantile(short, 0.9),
  };
}

/** Итог по getStats слушателя за окно: разница первого и последнего отчёта одной дорожки. */
export function statsSummary(rows) {
  if (rows.length < 2) return null;
  const a = rows[0];
  const b = rows[rows.length - 1];
  const d = (k) => (b[k] ?? 0) - (a[k] ?? 0);
  const total = d('total');
  const concealed = d('concealed') - d('silentConcealed');
  const events = d('events');
  const emitted = d('jbEmitted');
  const lost = d('lost');
  const received = d('packets');
  // Самое плохое окно в 1 с: столько заглушки человек услышал подряд в худший момент.
  let worstSecondMs = 0;
  for (let i = 1; i < rows.length; i++) {
    const c =
      (rows[i].concealed ?? 0) -
      (rows[i - 1].concealed ?? 0) -
      ((rows[i].silentConcealed ?? 0) - (rows[i - 1].silentConcealed ?? 0));
    worstSecondMs = Math.max(worstSecondMs, (c / 48000) * 1000);
  }
  const pct = (x) => Math.round(x * 10000) / 100;
  return {
    seconds: Math.round((b.ts - a.ts) / 1000),
    codec: b.codec ?? null,
    concealPct: total > 0 ? pct(concealed / total) : null,
    events,
    eventsPerMin: Math.round((events / ((b.ts - a.ts) / 60000)) * 10) / 10,
    eventMs: events > 0 ? Math.round((concealed / events / 48000) * 1000) : 0,
    worstSecondMs: Math.round(worstSecondMs),
    lossPct: received + lost > 0 ? pct(lost / (received + lost)) : null,
    jbDelayMs: emitted > 0 ? Math.round((d('jbDelay') / emitted) * 1000) : null,
    jbTargetMs: emitted > 0 ? Math.round((d('jbTargetDelay') / emitted) * 1000) : null,
    jbMinimumMs: emitted > 0 ? Math.round((d('jbMinDelay') / emitted) * 1000) : null,
    accelPct: total > 0 ? pct(d('accel') / total) : null,
    decelPct: total > 0 ? pct(d('decel') / total) : null,
    discarded: d('discarded'),
    fec: d('fec'),
    nacks: d('nacks'),
    retransmitted: d('retransmitted'),
    target: b.target ?? null,
  };
}
