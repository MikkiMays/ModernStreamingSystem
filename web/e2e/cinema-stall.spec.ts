import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { fixture, openCinema, routeCinema, startMeeting } from './support/cinema';

/**
 * Перемотка на +15 с на слабом канале — настоящим браузером и настоящим hls.js (R216).
 *
 * Жалоба владельца с телевизора 09.11.2026: после перемотки видео грузилось плохо, потом зависло, а
 * кружок крутился посреди идущей картинки. Здесь — те же условия: поток идёт со скоростью чуть выше
 * просмотра (кусок в 2 с отдаётся за 1,8 с), поэтому впереди почти ничего не загружено и +15 с — это
 * место за краем загруженного; первый кусок нового места приходит через 4 с, как у телевизора. До R216
 * комната уходила вперёд, пока плеер ждал данные, и плеер гнался за ней перемотками на 0,4 с вперёд,
 * каждая из которых снова ждала 4 с; теперь — одно ожидание, честный кружок, и комната встаёт туда,
 * где зритель.
 *
 * Поток — шестьдесят секунд: те же шесть кусков фикстуры (`fixtures/hls/180p_*.m2ts`) пять раз подряд,
 * через `EXT-X-DISCONTINUITY`.
 */

const LOOPS = 5;
const PIECES = 6;
/** Сколько отдаётся кусок в 2 с: канал в 1,1 раза быстрее просмотра. */
const PIECE_MS = 1800;
/** Первый кусок нового места (не следующий по порядку) — столько, как у телевизора после перемотки. */
const JUMP_MS = 4000;

function playlist(): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let loop = 0; loop < LOOPS; loop++) {
    if (loop) lines.push('#EXT-X-DISCONTINUITY');
    for (let piece = 0; piece < PIECES; piece++)
      lines.push('#EXTINF:2.000000,', `seg/${loop * PIECES + piece}.m2ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

async function slowStream(page: Page) {
  let last = -1;
  await page.route(
    (url) => url.pathname.startsWith('/fixtures/long/'),
    async (route) => {
      const name = new URL(route.request().url()).pathname.slice('/fixtures/long/'.length);
      if (name === 'master.m3u8')
        return route.fulfill({
          contentType: 'application/vnd.apple.mpegurl',
          body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=92400,RESOLUTION=320x180,CODECS="avc1.4d4015,mp4a.40.2"\n180p.m3u8\n',
        });
      if (name === '180p.m3u8')
        return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: playlist() });
      const index = Number(/^seg\/(\d+)\.m2ts$/.exec(name)?.[1] ?? -1);
      if (index < 0) return route.fulfill({ status: 404 });
      const wait = index > last + 1 ? JUMP_MS : PIECE_MS;
      last = index;
      await new Promise((resolve) => setTimeout(resolve, wait));
      const file = fileURLToPath(new URL(`./fixtures/hls/180p_${index % PIECES}.m2ts`, import.meta.url));
      // Плеер мог бросить вопрос (перемотка): ответ тогда уже некому.
      await route.fulfill({ contentType: 'video/mp2t', path: file }).catch(() => {});
    },
  );
}

/** Позиция, кружок и число перемоток `<video>` (`seeking`) с начала наблюдения. */
async function observe(page: Page) {
  return page.locator('.watch-video').evaluate((video: HTMLVideoElement) => {
    const w = window as unknown as { __seeks?: number };
    if (w.__seeks === undefined) {
      w.__seeks = 0;
      video.addEventListener('seeking', () => {
        w.__seeks = (w.__seeks ?? 0) + 1;
      });
    }
    return {
      time: video.currentTime,
      seeks: w.__seeks,
      spinner: !!document.querySelector('.watch-buffering'),
    };
  });
}

test('перемотка +15 с на слабом канале: одно честное ожидание и ни одной перемотки вдогонку', async ({
  page,
}) => {
  test.slow();
  await routeCinema(page, {
    resolve: ({ body }) => ({
      ...fixture<Record<string, unknown>>('youtube-resolve'),
      contentId: String(body?.contentId ?? ''),
      duration: LOOPS * PIECES * 2,
      captions: [],
      url: '/fixtures/long/master.m3u8',
      expiresAt: Date.now() + 3600_000,
    }),
  });
  await slowStream(page);
  await startMeeting(page, 'Майс');
  const browse = await openCinema(page, 'YouTube');
  const video = fixture<{ items: { title: string }[] }>('youtube-search-never-gonna-give-you-up').items[0]!;
  await browse.locator('.cinema-search input').fill('never gonna give you up');
  await browse.getByRole('button', { name: `Подробнее: ${video.title}`, exact: true }).click();
  await browse.getByRole('button', { name: /Смотреть вместе/ }).click();
  await expect(page.locator('.watch-theater')).toBeVisible();

  // Открывший включает сам; ждём, пока картинка пойдёт и наберёт несколько секунд.
  await expect.poll(async () => (await observe(page)).time, { timeout: 30_000 }).toBeGreaterThan(6);
  const before = await observe(page);

  await page.locator('.watch-theater').hover();
  await page.getByRole('button', { name: 'Вперёд на 15 секунд для всех' }).click();
  const landed = before.time + 15;

  // Место за краем загруженного: пока данных нет — кружок.
  await expect(page.locator('.watch-buffering')).toBeVisible({ timeout: 5_000 });
  // Данные пришли — картинка идёт с того места, куда перемотали, а кружок уходит.
  await expect.poll(async () => (await observe(page)).time, { timeout: 20_000 }).toBeGreaterThan(landed + 1);
  await expect(page.locator('.watch-buffering')).toHaveCount(0);
  const resumed = await observe(page);

  // Десять секунд дальше: ни одной перемотки вдогонку (до R216 — очередь перемоток и ожиданий).
  await page.waitForTimeout(10_000);
  const after = await observe(page);
  expect(after.seeks - resumed.seeks).toBe(0);
  expect(after.time - resumed.time).toBeGreaterThan(8);
  // Перемоток всего: своя и, может быть, одна поправка движка внутри загруженного.
  expect(after.seeks - before.seeks).toBeLessThanOrEqual(2);
});
