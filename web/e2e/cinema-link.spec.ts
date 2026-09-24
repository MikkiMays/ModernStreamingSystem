import { expect, test, type Browser } from '@playwright/test';
import { UNKNOWN_LINK, combine, fixture, openCinema, routeCinema, startMeeting } from './support/cinema';
import { RUTUBE } from './support/rutube';
import { vkAnswers } from './support/vk';

/*
  Ссылки в кинозале на записанных ответах службы: ссылка площадки из каталога открывает сцену этой
  площадки сразу на своей странице — откуда бы её ни вставили, — незнакомая ссылка остаётся в сцене
  «По ссылке» с причиной словами, а недавние ссылки профиль помнит между открытиями.

  Чья ссылка, отвечает служба (`POST …/cinema/link`); здесь её грамматику для ссылок сценария
  играет перехват (`support/cinema.ts`), а страницы — записи Rutube, VK и YouTube. Ни службы, ни
  площадок сценарию не нужно — он идёт и в CI.
*/

const context = (browser: Browser) =>
  browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 960 } });

const EPISODE = fixture<{ id: string; title: string }>('rutube-details');
const SERIES = `https://rutube.ru/video/${EPISODE.id}/`;
const MASHA = fixture<{ items: { id: string; title: string }[] }>('vk-search').items[0]!;
const ROLL = fixture<{ id: string; title: string }>('youtube-details');

test('a pasted link opens the scene of its own platform on its page, wherever it was pasted', async ({
  browser,
}) => {
  const room = await context(browser);
  const page = await room.newPage();
  const cinema = await routeCinema(page, combine(RUTUBE, vkAnswers()));
  try {
    await startMeeting(page);
    const browse = await openCinema(page, 'По ссылке');
    await expect(browse.locator('.cinema-platform')).toHaveText('По ссылке');
    const field = browse.locator('.cinema-search input');
    await expect(field).toHaveAttribute('placeholder', 'Вставьте ссылку на видео');

    // Rutube — из «По ссылке»: сцена Rutube, сразу страница выпуска.
    await field.fill(SERIES);
    await expect(browse.locator('.cinema-platform')).toHaveText('Rutube');
    await expect(browse.locator('.cinema-detail h3')).toHaveText(EPISODE.title);
    await expect(browse.getByRole('button', { name: 'Все серии' })).toBeVisible();

    // VK — из поиска Rutube: сцена VK Видео, страница серии «Маши и Медведя».
    await browse.locator('.cinema-search input').fill(`https://vkvideo.ru/video${MASHA.id}`);
    await expect(browse.locator('.cinema-platform')).toHaveText('VK Видео');
    await expect(browse.locator('.cinema-detail h3')).toHaveText(MASHA.title);

    // YouTube — из поиска VK: переключатель на вкладке YouTube, страница ролика.
    await browse.locator('.cinema-search input').fill(`https://youtu.be/${ROLL.id}`);
    await expect(browse.getByRole('tab', { name: 'YouTube' })).toHaveAttribute('aria-selected', 'true');
    await expect(browse.locator('.cinema-detail h3')).toHaveText(ROLL.title);
    // Поле поиска снова пустое, а «Назад» ведёт на витрину площадки, а не к поиску по адресу.
    await expect(browse.locator('.cinema-search input')).toHaveValue('');
    await browse.getByRole('button', { name: 'Назад' }).click();
    await expect(browse.locator('.cinema-empty')).toContainText('Что включим комнате?');

    // Каждую ссылку служба узнала одним вопросом, и ни одну не искали как слова.
    expect(cinema.calls.filter((call) => call.endpoint === 'link').map((call) => call.body?.url)).toEqual([
      SERIES,
      `https://vkvideo.ru/video${MASHA.id}`,
      `https://youtu.be/${ROLL.id}`,
    ]);
    expect(
      cinema.calls.filter(
        (call) => call.endpoint === 'search' && /^https?:/.test(call.params.get('query') ?? ''),
      ),
    ).toEqual([]);
    expect(cinema.calls.map((call) => `${call.params.get('provider')}:${call.endpoint}`)).toEqual(
      expect.arrayContaining(['rutube:details', 'vk:details', 'youtube:details']),
    );
  } finally {
    await room.close();
  }
});

test('an unknown link lands in «По ссылке» with the reason', async ({ browser }) => {
  const room = await context(browser);
  const page = await room.newPage();
  await routeCinema(page);
  try {
    await startMeeting(page);
    const browse = await openCinema(page, 'YouTube');
    await browse.locator('.cinema-search input').fill('https://example.com/films/1/video.mp4');
    await expect(browse.locator('.cinema-platform')).toHaveText('По ссылке');
    await expect(browse.locator('.cinema-search input')).toHaveValue('https://example.com/films/1/video.mp4');
    await expect(browse.getByText(UNKNOWN_LINK)).toBeVisible();
    // Никуда не привела — в недавние не встала.
    await browse.locator('.cinema-search input').fill('');
    await expect(browse.getByText('Вставьте ссылку на видео')).toBeVisible();
    await expect(browse.getByRole('region', { name: 'Недавние ссылки' })).toHaveCount(0);
  } finally {
    await room.close();
  }
});

test('recent links are remembered by the profile and open again from «По ссылке»', async ({ browser }) => {
  const room = await context(browser);
  const page = await room.newPage();
  const cinema = await routeCinema(page, RUTUBE);
  try {
    await startMeeting(page);
    let browse = await openCinema(page, 'По ссылке');
    await expect(browse.getByRole('region', { name: 'Недавние ссылки' })).toHaveCount(0);
    await browse.locator('.cinema-search input').fill(SERIES);
    await expect(browse.locator('.cinema-detail h3')).toHaveText(EPISODE.title);
    await browse.getByRole('button', { name: 'Закрыть кинотеатр' }).click();
    await expect(browse).toHaveCount(0);

    // Каталог открыт заново — ссылка первой в недавних; её помнит профиль, а не открытая сцена.
    browse = await openCinema(page, 'По ссылке');
    const recent = browse.getByRole('region', { name: 'Недавние ссылки' });
    await expect(recent.getByRole('button')).toHaveText([`rutube.ru/video/${EPISODE.id}/`]);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cord:preferences:v1') ?? '{}'));
    expect(saved.cinemaLinks).toEqual([SERIES]);

    await recent.getByRole('button').click();
    await expect(browse.locator('.cinema-platform')).toHaveText('Rutube');
    await expect(browse.locator('.cinema-detail h3')).toHaveText(EPISODE.title);
    // Ответ о ссылке служба дала один раз: второе открытие — из памяти ответов.
    expect(cinema.calls.filter((call) => call.endpoint === 'link')).toHaveLength(1);
  } finally {
    await room.close();
  }
});
