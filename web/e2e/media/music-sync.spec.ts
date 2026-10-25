/**
 * Живой замер музыки (Ц1, MEDIA-DIAGNOSIS §7): три слушателя, запас буфера у всех в одной секунде,
 * заморозка одного слушателя не оставляет его в тишине, опоздавший входит с тем же запасом.
 *
 * Долгий (≈4 мин) и требует стенд с SFU: в CI не идёт — включается `CORD_MEDIA_PROBE=1`.
 * Трек: `TRACK` (wav/mp3 ≥ 4 мин; `node e2e/media/gen-wav.mjs /tmp/track.wav`), сырые отсчёты — в `OUT`.
 */
import { chromium, expect, test } from '@playwright/test';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

interface Row {
  phase: string;
  who: string;
  target: number | null;
  jbDelay?: number;
  jbEmitted?: number;
  total?: number;
  decel?: number;
  discarded?: number;
}
import { resolve } from 'node:path';

const TRACK = process.env.TRACK ?? '';
const OUT = process.env.OUT ?? '/tmp/music-probe.jsonl';
const FREEZE_MS = Number(process.env.FREEZE_MS ?? 12000);
const BEFORE_MS = Number(process.env.BEFORE_MS ?? 45000);
const AFTER_MS = Number(process.env.AFTER_MS ?? 150000);

const hook = () => {
  const Native = window.RTCPeerConnection;
  if (!Native) return;
  (window as any).__pcs = [];
  class Wrapped extends Native {
    constructor(...a: any[]) {
      super(...a);
      (window as any).__pcs.push(this);
    }
  }
  window.RTCPeerConnection = Wrapped as any;
};

async function sample(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const out: any[] = [];
    for (const pc of (window as any).__pcs as RTCPeerConnection[]) {
      if (pc.connectionState === 'closed') continue;
      const targets = new Map<string, number | null>();
      for (const r of pc.getReceivers())
        if (r.track?.kind === 'audio') targets.set(r.track.id, (r as any).jitterBufferTarget ?? null);
      const report = await pc.getStats();
      report.forEach((s: any) => {
        if (s.type !== 'inbound-rtp' || s.kind !== 'audio') return;
        out.push({
          ssrc: s.ssrc,
          target: targets.get(s.trackIdentifier) ?? null,
          ts: s.timestamp,
          bytes: s.bytesReceived,
          packets: s.packetsReceived,
          lost: s.packetsLost,
          jitter: s.jitter,
          jbDelay: s.jitterBufferDelay,
          jbEmitted: s.jitterBufferEmittedCount,
          jbTargetDelay: s.jitterBufferTargetDelay,
          jbMinDelay: s.jitterBufferMinimumDelay,
          total: s.totalSamplesReceived,
          concealed: s.concealedSamples,
          silentConcealed: s.silentConcealedSamples,
          events: s.concealmentEvents,
          decel: s.insertedSamplesForDeceleration,
          accel: s.removedSamplesForAcceleration,
          discarded: s.packetsDiscarded,
          level: s.audioLevel,
          energy: s.totalAudioEnergy,
        });
      });
    }
    return out;
  });
}

const args = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];

test.skip(!process.env.CORD_MEDIA_PROBE, 'живой замер: CORD_MEDIA_PROBE=1, TRACK=…, OUT=…');
// Замер идёт BEFORE_MS + FREEZE_MS + AFTER_MS (≈ 3,5 мин) плюс загрузка трека — общий срок конфига (45 с) ему мал.
test.setTimeout(10 * 60_000);

test('музыка: запас в одной секунде у всех, заморозка слушателя и опоздавший', async ({
  browser,
  baseURL,
}) => {
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ viewport: { width: 1280, height: 860 } })),
  );
  // Гость A — отдельный процесс, чтобы заморозить только его.
  const server = await chromium.launchServer({ args });
  const other = await chromium.connect(server.wsEndpoint());
  const contextA = await other.newContext({
    viewport: { width: 1280, height: 860 },
    locale: 'ru-RU',
    baseURL: baseURL!,
    storageState: resolve(process.cwd(), '.local/e2e/returning.json'),
  });
  for (const c of [...contexts, contextA]) await c.addInitScript(hook);
  const [host, guestB] = await Promise.all(contexts.map((c) => c.newPage()));
  const guestA = await contextA.newPage();
  writeFileSync(OUT, '');
  const log = (phase: string, who: string, rows: any[]) => {
    for (const row of rows)
      appendFileSync(OUT, JSON.stringify({ at: Date.now(), phase, who, ...row }) + '\n');
  };
  const mark = (phase: string) =>
    appendFileSync(OUT, JSON.stringify({ at: Date.now(), phase, who: '-' }) + '\n');
  try {
    await host!.goto('/');
    await host!.getByRole('button', { name: /Новая встреча/ }).click();
    await host!.getByLabel('Ваше имя').fill('Хост');
    await host!.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(host!.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 90000 });
    await host!.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
    const invitation = await host!.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
    await host!.getByRole('button', { name: 'Закрыть', exact: true }).click();
    for (const [i, page] of [guestA, guestB!].entries()) {
      await page.goto(invitation);
      await page.getByLabel('Ваше имя').fill(`Гость ${i + 1}`);
      await page.getByRole('button', { name: 'Войти во встречу' }).click();
      await expect(page.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 90000 });
    }
    await host!.getByRole('button', { name: 'Интеграции', exact: true }).click();
    await host!.getByRole('button', { name: /^Музыка/ }).click({ timeout: 15000 });
    // Вход в музыку — сразу плеер, площадки вкладками (R44): «Свои файлы» — вкладка, не кнопка.
    await host!.getByRole('tab', { name: 'Свои файлы' }).click({ timeout: 30000 });
    await expect(host!.locator('input[type="file"]')).toBeAttached({ timeout: 60000 });
    await host!.locator('input[type="file"]').setInputFiles(TRACK);
    // Признак «играет» — мини-плеер в слое над сценой (R31) с `data-playing`, а не строка панели.
    await expect(host!.locator('.music-mini[data-playing]')).toBeVisible({ timeout: 90000 });
    console.log('music playing at', new Date().toISOString());
    mark('playing');

    const pollUntil = async (
      phase: string,
      ms: number,
      pages: [string, import('@playwright/test').Page][],
    ) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const rows = await Promise.all(pages.map(([, p]) => sample(p).catch(() => [])));
        rows.forEach((r, i) => log(phase, pages[i]![0], r));
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
    await pollUntil('before', BEFORE_MS, [
      ['A', guestA],
      ['B', guestB!],
    ]);
    const pid = server.process().pid!;
    console.log('freezing guest A browser pid', pid, 'for', FREEZE_MS, 'ms at', new Date().toISOString());
    mark('freeze-start');
    process.kill(pid, 'SIGSTOP');
    await pollUntil('frozen', FREEZE_MS, [['B', guestB!]]);
    process.kill(pid, 'SIGCONT');
    mark('freeze-end');
    console.log('resumed at', new Date().toISOString());
    await pollUntil('after', AFTER_MS, [
      ['A', guestA],
      ['B', guestB!],
    ]);
    // Гость, вошедший позже всех: с каким запасом живёт он рядом с теми, кто давно в комнате.
    const late = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await late.addInitScript(hook);
    const latePage = await late.newPage();
    await latePage.goto(invitation);
    await latePage.getByLabel('Ваше имя').fill('Опоздавший');
    await latePage.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(latePage.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 90000 });
    mark('late-joined');
    await pollUntil('late', 40000, [
      ['A', guestA],
      ['B', guestB!],
      ['C', latePage],
    ]);
    await late.close();
    // Пороги §7: цель буфера музыки у всех ∈ [500, 1000]; разброс фактического буфера ≤ 500 мс;
    // растяжение < 0,5 %; выброшенных пакетов нет (после заморозки — в том числе).
    const rows = readFileSync(OUT, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Row);
    const late20 = rows.filter((r) => r.phase === 'late' && r.who !== '-');
    for (const who of ['A', 'B', 'C']) {
      const mine = late20.filter((r) => r.who === who);
      expect(mine.length, `у слушателя ${who} есть отсчёты`).toBeGreaterThan(5);
      for (const r of mine.slice(-5)) if (r.target !== null) expect(r.target).toBeGreaterThanOrEqual(500);
      for (const r of mine.slice(-5)) if (r.target !== null) expect(r.target).toBeLessThanOrEqual(1000);
    }
    const buffer = (who: string) => {
      const mine = late20.filter((r) => r.who === who);
      const a = mine[Math.max(0, mine.length - 11)]!;
      const b = mine[mine.length - 1]!;
      const emitted = (b.jbEmitted ?? 0) - (a.jbEmitted ?? 0);
      return emitted > 0 ? (((b.jbDelay ?? 0) - (a.jbDelay ?? 0)) / emitted) * 1000 : NaN;
    };
    const buffers = ['A', 'B', 'C'].map(buffer).filter((v) => Number.isFinite(v));
    expect(Math.max(...buffers) - Math.min(...buffers)).toBeLessThanOrEqual(500);
    const after = rows.filter((r) => r.phase === 'after' && r.who === 'A');
    const first = after[0]!;
    const last = after[after.length - 1]!;
    const total = (last.total ?? 0) - (first.total ?? 0);
    expect(((last.decel ?? 0) - (first.decel ?? 0)) / Math.max(1, total)).toBeLessThan(0.005);
    expect((last.discarded ?? 0) - (first.discarded ?? 0)).toBe(0);
  } finally {
    await contextA.close().catch(() => {});
    await other.close().catch(() => {});
    await server.close().catch(() => {});
    await Promise.all(contexts.map((c) => c.close()));
  }
});
