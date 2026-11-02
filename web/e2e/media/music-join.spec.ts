/**
 * Живой замер R182: что слышит человек, который входит во встречу посреди играющей музыки.
 *
 * Держатель встречи включает музыку (свой трек `TRACK`, «Повторять очередь»), слушатель входит посреди
 * трека и переподключается (перезагрузка, выход и вход). У слушателя записывается **то, что уходит в
 * динамик** — ответвление от каждого узла, который LiveKit подключает к `destination` своего
 * `AudioContext` (`music-probe-kit.ts`), — а рядом раз в 0,5 с `inbound-rtp` музыки: запас, растяжение,
 * сжатие, заглушка, число `<audio>` и узлов у `destination`. Разбор записи — по сигналу (развёртка слева,
 * тон справа): THD+N, темп воспроизведения, моно ли (`backlog/knowledge/memory/cord-listener-recording.md`).
 *
 * Только против стенда с SFU и только руками: `CORD_MEDIA_PROBE=1`. Встреча одна на все сценарии (стенд
 * пускает 10 новых встреч в час на адрес); `INVITATION` — войти в уже идущую встречу с музыкой.
 * Headless Chromium на загруженной машине голодает выводом звука — запускать с приоритетом:
 *
 *   ulimit -r 99; CORD_MEDIA_PROBE=1 TRACK=/path/track.flac OUT=/path/out \
 *     PLAYWRIGHT_BASE_URL=https://cord.nikg.tech nice -n -15 npx playwright test e2e/media/music-join.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harvest, pcHook, sample, tapHook, wav } from './music-probe-kit';

const TRACK = process.env.TRACK ?? '';
const OUT = process.env.OUT ?? '/tmp/music-join';
const REC_MS = Number(process.env.REC_MS ?? 30000);
const LEAD_MS = Number(process.env.LEAD_MS ?? 8000);
/** Сценарии через запятую: join, reload, rejoin. */
const SCENARIOS = (process.env.SCENARIOS ?? 'join,reload,rejoin').split(',').filter(Boolean);
/** Слушатель с включённым микрофоном и этим шумодавом (`rnnoise` — как автоподключение 1.1.3). */
const MIC = process.env.B_MIC ?? '';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.skip(!process.env.CORD_MEDIA_PROBE, 'живой замер: CORD_MEDIA_PROBE=1, TRACK=…, OUT=…');
test.setTimeout(30 * 60_000);

test('R182: музыка у вошедшего посреди трека', async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const log = (name: string, value: unknown) =>
    appendFileSync(join(OUT, `${name}.jsonl`), JSON.stringify(value) + '\n');
  const host = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const a = await host.newPage();
  let invitation = process.env.INVITATION ?? '';
  if (!invitation) {
    await a.goto('/');
    await a.getByRole('button', { name: /Новая встреча/ }).click();
    await a.getByLabel('Ваше имя').fill('Держатель');
    await a.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(a.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 120000 });
    await a.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
    invitation = await a.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
    await a.getByRole('button', { name: 'Закрыть', exact: true }).click();
    writeFileSync(join(OUT, 'invitation.txt'), invitation);
    await a.getByRole('button', { name: 'Интеграции', exact: true }).click();
    await a.getByRole('button', { name: /^Музыка YouTube/ }).click({ timeout: 15000 });
    // Музыка добавляется во встречу шагом «Добавить во встречу» (Р-55).
    const add = a.getByRole('button', { name: 'Добавить во встречу' });
    const files = a.getByRole('tab', { name: 'Свои файлы' });
    await add.or(files).first().waitFor({ timeout: 60000 });
    if (await add.isVisible()) await add.click();
    await files.click({ timeout: 60000 });
    await a.locator('input[type="file"]').setInputFiles(TRACK);
    await expect(a.locator('.music-mini[data-playing]')).toBeVisible({ timeout: 180000 });
    const repeat = a.getByRole('button', { name: 'Повторять очередь' });
    if ((await repeat.getAttribute('aria-pressed')) !== 'true') await repeat.click();
    log('marks', { at: Date.now(), mark: 'playing' });
    await pause(LEAD_MS);
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    bypassCSP: true,
    permissions: ['microphone', 'camera'],
  });
  await context.addInitScript(pcHook);
  await context.addInitScript(tapHook);
  if (MIC)
    await context.addInitScript((suppression) => {
      localStorage.setItem(
        'cord:preferences:v1',
        JSON.stringify({ audio: { suppression, suppressionChosen: true } }),
      );
    }, MIC);
  const enter = async (page: Page) => {
    await page.goto(invitation, { timeout: 240000, waitUntil: 'domcontentloaded' });
    const field = page.getByLabel('Ваше имя');
    await field.waitFor({ timeout: 60000 });
    await field.fill('Слушатель');
    await page.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(page.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 120000 });
    if (MIC) await page.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
  };
  const record = async (page: Page, tag: string) => {
    log('marks', { at: Date.now(), mark: `${tag}:record` });
    const end = Date.now() + REC_MS;
    while (Date.now() < end) {
      log(`stats-${tag}`, await sample(page).catch((e) => ({ error: String(e) })));
      await pause(500);
    }
    const taps = await harvest(page);
    taps.forEach((tap, i) => {
      if (tap.data.length > 0) wav(join(OUT, `${tag}-ctx${i}.wav`), tap.rate, tap.data);
      log('taps', { tag, i, ...tap, data: undefined, bytes: tap.data.length });
    });
  };

  let b = await context.newPage();
  try {
    for (const scenario of SCENARIOS) {
      log('marks', { at: Date.now(), mark: `${scenario}:start` });
      if (scenario === 'join') await enter(b);
      else if (scenario === 'reload') {
        await b.reload({ timeout: 240000 });
        await expect(b.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 120000 });
      } else if (scenario === 'rejoin') {
        await b.getByRole('button', { name: 'Выйти из встречи' }).click();
        await pause(2000);
        await b.close();
        b = await context.newPage();
        await enter(b);
      }
      log('marks', { at: Date.now(), mark: `${scenario}:connected` });
      await record(b, scenario);
    }
  } finally {
    await context.close().catch(() => {});
    await host.close().catch(() => {});
  }
});
