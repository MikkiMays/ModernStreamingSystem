import { expect, test } from '@playwright/test';
import { inviteLink, joinMeeting, openCinema, startMeeting } from './support/cinema';

/*
  Плеер страниц (задача 15c) на стенде: настоящая служба, настоящий контейнер `sniffer` и сайт-фикстура в
  своём контейнере (`services/sniffer/tests/sites.py`). Плеер hls.js этой страницы берёт адрес потока у её API
  со своей cookie, а поток сайт отдаёт только с этой cookie и с Referer страницы. yt-dlp такую страницу не
  понимает; плеер страниц её открывает, служба запоминает профиль заголовков — и комната смотрит поток через
  наш прокси, как любой другой.

  Нужен стенд с плеером страниц (`web/.local/stack.sh up --services`) и адрес сайта-фикстуры:
  `CORD_E2E_PAGES=$(cat .local/stack/pages.url)`. Без него сценарий пропускается: в CI плеера страниц нет.
*/
const PAGES = process.env.CORD_E2E_PAGES ?? '';

test.skip(!PAGES, 'нужен стенд с плеером страниц: .local/stack.sh up --services и CORD_E2E_PAGES');

/** Кто спрашивал у сайта-фикстуры поток и с чем (`/hits`). */
interface Hit {
  path: string;
  remote: string;
  agent: string;
  cookie: boolean;
  referer: boolean;
}

const position = (page: import('@playwright/test').Page) =>
  page.locator('.watch-video').evaluate((element: HTMLVideoElement) => element.currentTime);

test('a page only its own player can play opens for the room and plays in sync for two browsers', async ({
  browser,
}) => {
  // Два браузера, два входа во встречу и настоящая страница в настоящем браузере сервера.
  test.slow();
  const first = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 960 },
  });
  const second = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1280, height: 900 },
  });
  const host = await first.newPage();
  const guest = await second.newPage();
  try {
    await startMeeting(host, 'Майс');
    await joinMeeting(guest, await inviteLink(host), 'Алекс');

    const browse = await openCinema(host, 'По ссылке');
    await browse.locator('.cinema-search input').fill(`${PAGES}/pages/hls.html`);
    // yt-dlp, потом плеер страниц: карточка — с именем и ступенями качества, которые увидел браузер сервера.
    await expect(browse.locator('.cinema-detail h3')).toHaveText('Фильм страницы', { timeout: 60000 });
    await expect(browse.locator('.cinema-link-facts .cinema-link-qualities .cinema-chip')).toHaveText([
      '180p',
      '144p',
    ]);
    await browse
      .locator('.cinema-detail-actions')
      .getByRole('button', { name: /Смотреть вместе/ })
      .click();

    for (const page of [host, guest]) {
      await expect(page.locator('.watch-theater')).toBeVisible();
      await expect(page.locator('.watch-title b')).toHaveText('Фильм страницы');
      await expect.poll(() => position(page), { timeout: 30000 }).toBeGreaterThan(1);
    }
    // Пауза общая, и на паузе оба стоят в одном месте (в пределах порога синхронизации).
    await guest.locator('.watch-theater').hover();
    await guest.locator('.watch-play').click();
    await expect(host.locator('.watch-play')).toHaveAttribute('aria-label', 'Включить для всех');
    await expect
      .poll(async () => Math.abs((await position(host)) - (await position(guest))), { timeout: 10000 })
      .toBeLessThan(2.5);

    // Сайт отдавал поток только с cookie и Referer своей страницы — и служба их повторила: её запросы (не
    // браузера плеера страниц, который один спрашивал API страницы) пришли с ними и с его именем браузера.
    const hits = (await (await fetch(`${PAGES}/hits`)).json()) as Hit[];
    const sniffer = hits.find((hit) => hit.path === '/api/source')?.remote;
    expect(sniffer).toBeTruthy();
    const service = hits.filter((hit) => hit.path.startsWith('/media/') && hit.remote !== sniffer);
    expect(service.length).toBeGreaterThan(2);
    expect(service.every((hit) => hit.cookie && hit.referer && hit.agent.includes('HeadlessChrome'))).toBe(
      true,
    );
  } finally {
    await first.close();
    await second.close();
  }
});
