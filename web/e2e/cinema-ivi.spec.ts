import { expect, test, type Browser } from '@playwright/test';
import { fixture, openCinema, routeCinema, startMeeting } from './support/cinema';
import { IVI, type Feed } from './support/ivi';

/*
  Кинозал ivi на записанных ответах службы: три вкладки постерами 2:3, сериал с сезоном, поиск —
  и «Смотреть вместе» открывает плеер у двух браузеров, и роликом, и серией.

  Формы ответов — те же, что строит `cord_services/cinema/providers/ivi.py` по настоящим полям
  площадки (`services/tests/fixtures/ivi/`, сняты 25.09.2026); картинка — общая серая заглушка,
  поток — общий записанный HLS. Ни службы, ни площадки сценарию не нужно — он идёт и в CI.
*/

const context = (browser: Browser, width: number, height: number) =>
  browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width, height } });

test('the ivi catalogue is walked on recorded answers: tabs, a movie and a series with a season', async ({
  browser,
}) => {
  const room = await context(browser, 1440, 960);
  const page = await room.newPage();
  const cinema = await routeCinema(page, IVI);
  try {
    await startMeeting(page);
    const browse = await openCinema(page, 'ivi');
    await expect(browse.locator('.cinema-platform')).toHaveText('ivi');
    await expect(browse.locator('.cinema-search input')).toHaveAttribute(
      'placeholder',
      'Фильм, сериал или мультфильм',
    );

    // Открывается вкладкой «Фильмы» — постером 2:3, рейтингом и жанром с годом на плитке.
    const tabs = browse.getByRole('tablist', { name: 'Разделы ivi' });
    await expect(tabs.getByRole('tab', { name: 'Фильмы', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const movies = fixture<Feed>('ivi-category-movies');
    const tile = browse.locator('.cinema-tile-tall').first();
    await expect(tile).toHaveCount(1);
    await expect(tile.locator('.cinema-tile-title')).toHaveText(movies.items[0]!.title);
    await expect(tile.locator('.cinema-chip')).toHaveText([
      movies.items[0]!.badge!,
      movies.items[0]!.category!,
    ]);
    expect(
      cinema.calls.filter((call) => call.params.get('provider') === 'ivi').map((c) => c.endpoint),
    ).toEqual(expect.arrayContaining(['categories', 'category']));

    // «Сериалы» меняет сетку на месте — ряд вкладок остаётся, а не открывает новую страницу.
    await tabs.getByRole('tab', { name: 'Сериалы' }).click();
    const shows = fixture<Feed>('ivi-category-shows');
    await expect(browse.locator('.cinema-tile-title')).toHaveText(shows.items[0]!.title);
    expect(cinema.calls.some((call) => call.endpoint === 'category' && call.params.get('id') === '15')).toBe(
      true,
    );

    // Сериал — своя страница: шапка, сезон (один — без ряда вкладок), серии.
    await browse.locator('.cinema-open').first().click();
    const series = fixture<{ series: { title: string; description: string } }>('ivi-series');
    await expect(browse.locator('.cinema-detail-tall h3')).toHaveText(series.series.title);
    await expect(browse.getByText(series.series.description)).toBeVisible();
    await expect(browse.getByRole('tablist', { name: 'Сезоны' })).toHaveCount(0);
    const episode = fixture<Feed>('ivi-series').items[0]!;
    await expect(browse.locator('.cinema-tile:not(.cinema-tile-tall) .cinema-tile-title')).toHaveText(
      episode.title,
    );
    await expect(browse.locator('.cinema-chip')).toHaveText(episode.badge!);

    await browse.getByRole('button', { name: 'Назад' }).click();
    await expect(tabs.getByRole('tab', { name: 'Сериалы' })).toHaveAttribute('aria-selected', 'true');

    // Фильм открывается страницей ролика — и «Смотреть вместе» включает плеер обеим сторонам.
    await tabs.getByRole('tab', { name: 'Фильмы', exact: true }).click();
    await browse.locator('.cinema-open').first().click();
    await expect(browse.locator('.cinema-detail h3')).toHaveText(movies.items[0]!.title);
    await browse.getByRole('button', { name: /Смотреть вместе/ }).click();
    await expect(page.locator('.watch-theater')).toBeVisible();
    await expect(page.locator('.watch-title b')).toHaveText(movies.items[0]!.title);
  } finally {
    await room.close();
  }
});

test('search finds a free title, and a pasted ivi link opens its page without searching', async ({
  browser,
}) => {
  const room = await context(browser, 1440, 960);
  const page = await room.newPage();
  await routeCinema(page, IVI);
  try {
    await startMeeting(page);
    const browse = await openCinema(page, 'ivi');
    const field = browse.locator('.cinema-search input');
    await field.fill('Иван');
    const found = fixture<Feed>('ivi-search');
    await expect(browse.locator('.cinema-tile-title')).toHaveText(found.items[0]!.title);
    await expect(browse.getByRole('tablist', { name: 'Разделы ivi' })).toHaveCount(0);

    await field.fill('');
    await field.focus();
    await field.evaluate((element) => {
      element.dispatchEvent(new Event('paste', { bubbles: true }));
    });
    await field.fill('https://www.ivi.ru/watch/53141');
    await expect(browse.locator('.cinema-detail h3')).toHaveText(found.items[0]!.title);
    await expect(field).toHaveValue('');
  } finally {
    await room.close();
  }
});
