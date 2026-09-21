import { expect, test } from '@playwright/test';

/**
 * Кинотеатр в двух настоящих браузерах.
 *
 * Проверяется путь целиком — панель, каталог на сцене, поиск, страница видео, открытие на всех,
 * общая пауза, — но без ожидания настоящих кадров: за ними стоит чужая площадка, и прогон не
 * должен падать из-за её настроения. Что видео действительно идёт синхронно, меряется живьём
 * против прода и записано в `docs/INTEGRATIONS.md`.
 */
test('the cinema opens for the whole room from the catalogue, and anyone may stop it', async ({
  browser,
  request,
  baseURL,
}) => {
  /*
    Кинозал живёт в контейнере служб, а локальный стенд поднимает только ядро, LiveKit и tusd:
    искать там не у кого. Поэтому прогон сначала спрашивает, есть ли службы вообще, и молча
    пропускает сценарий, если их нет, — вместо падения, которое означало бы «сломано», хотя
    сломан здесь только стенд. Против прода этот же прогон идёт целиком.
  */
  const catalog = await request.get(`${baseURL}/api/v1/services/catalog`).catch(() => null);
  test.skip(!catalog?.ok(), 'Службы не подняты: кинозалу не у кого спрашивать');
  // Два браузера, два входа во встречу и три похода к площадке: обычного срока тут мало.
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
    await host.goto('/');
    await host.getByRole('button', { name: /Новая встреча/ }).click();
    await host.getByLabel('Ваше имя').fill('Майс');
    await host.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(host.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 20000 });
    await host.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
    const invitation = await host.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await guest.goto(invitation);
    await guest.getByLabel('Ваше имя').fill('Алекс');
    await guest.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(guest.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 20000 });

    // Панель интеграций — выключатель: площадку выбирают в ней, а каталог открывается на сцене.
    await host.getByRole('button', { name: 'Интеграции', exact: true }).click();
    // Пока сцена свободна, в неё можно принести что угодно — в том числе покерный стол.
    await expect(host.getByRole('button', { name: /Игры/ })).toBeEnabled();
    await host.getByRole('button', { name: /Кинозал/ }).click();
    await host.getByRole('button', { name: /YouTube/ }).click();
    const browse = host.locator('.cinema-browser');
    await expect(browse).toBeVisible();
    // Каталог личный: у гостя на сцене по-прежнему разговор.
    await expect(guest.locator('.cinema-browser')).toHaveCount(0);

    await browse.locator('.cinema-search input').fill('big buck bunny');
    // Ролик, а не канал: поиск теперь отвечает и каналами, и они стоят полкой выше сетки.
    const result = browse.locator('.cinema-tile:not(.cinema-tile-face)').first();
    await expect(result).toBeVisible({ timeout: 30000 });
    const title = (await result.locator('.cinema-tile-title').textContent())?.trim() ?? '';
    // Сетка ведёт на страницу видео, а оттуда — в комнату.
    await result.locator('.cinema-open').click();
    await expect(browse.locator('.cinema-detail')).toBeVisible({ timeout: 30000 });
    await browse.getByRole('button', { name: /Смотреть вместе/ }).click();

    // Кинозал открывается у обоих, люди переезжают в ленту под плеером, каталог уходит.
    for (const page of [host, guest]) {
      await expect(page.locator('.watch-theater')).toBeVisible({ timeout: 30000 });
      await expect(page.locator('.people-strip .person-tile')).toHaveCount(2);
    }
    await expect(host.locator('.cinema-browser')).toHaveCount(0);
    await expect(host.locator('.watch-title b')).toContainText(title.slice(0, 12));

    // Ролик открывается на паузе и включается, когда плеер принёсшего готов.
    await expect(host.locator('.watch-play')).toHaveAttribute('aria-label', 'Пауза для всех', {
      timeout: 30000,
    });
    // Пауза общая: её жмёт и тот, кто ничего не приносил, и видят это все.
    //
    // Пульт уходит с кадра через пару секунд без движения мыши, и «нажать» по нему тогда
    // нельзя: `pointer-events` у скрытого пульта выключены, а проверка попадания у Playwright
    // не двигает настоящую мышь — она бы его разбудила. Человек перед нажатием мышь двигает,
    // поэтому и здесь сначала наведение, как и у хозяина ниже.
    await guest.locator('.watch-theater').hover();
    const pause = guest.locator('.watch-play');
    await expect(pause).toBeEnabled();
    await pause.click();
    await expect(host.locator('.watch-play')).toHaveAttribute('aria-label', 'Включить для всех', {
      timeout: 15000,
    });
    // Громкость и качество — личные: комнату они не двигают.
    await expect(guest.getByRole('slider', { name: 'Громкость просмотра' })).toBeVisible();

    // Вторая интеграция во встречу не пускается, пока открыта первая. Музыке кино мешает
    // ушами, покеру — сценой: обе группы закрыты, пока идёт просмотр.
    await guest.getByRole('button', { name: 'Интеграции', exact: true }).click();
    await expect(guest.getByRole('button', { name: /Музыка/ })).toBeDisabled();
    await expect(guest.getByRole('button', { name: /Игры/ })).toBeDisabled();

    // Каталог открывается поверх плеера, не разбирая его: кино продолжает идти.
    await host.locator('.watch-theater').hover();
    await host.getByRole('button', { name: /Каталог/ }).click();
    await expect(host.locator('.cinema-browser')).toBeVisible();
    await expect(host.locator('.watch-theater')).toHaveCount(1);
    await host.getByRole('button', { name: 'Вернуться к просмотру' }).click();
    await expect(host.locator('.cinema-browser')).toHaveCount(0);

    await host.locator('.watch-theater').hover();
    await host.getByRole('button', { name: 'Закрыть просмотр для всех' }).click();
    for (const page of [host, guest]) {
      await expect(page.locator('.watch-theater')).toHaveCount(0, { timeout: 15000 });
      await expect(page.locator('.people-grid')).toBeVisible();
    }
  } finally {
    await first.close();
    await second.close();
  }
});

/**
 * Каталог как каталог: канал, его вкладки, плейлист внутри канала и разделы Twitch.
 *
 * Это не про видео и не про синхронность — это про то, что по каталогу **ходят**: находят
 * канал по имени, заходят в него, листают ленту вниз, открывают плейлист и возвращаются
 * назад. Раньше сюда нельзя было попасть иначе как через чужой ролик, и обратной дороги не
 * было вовсе.
 *
 * Одна встреча, один браузер: комната здесь нужна только как ключ к службам.
 */
test('the catalogue is walked: channels, tabs, playlists and Twitch categories', async ({
  browser,
  request,
  baseURL,
}) => {
  const catalog = await request.get(`${baseURL}/api/v1/services/catalog`).catch(() => null);
  test.skip(!catalog?.ok(), 'Службы не подняты: кинозалу не у кого спрашивать');
  test.slow();
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Новая встреча/ }).click();
    await page.getByLabel('Ваше имя').fill('Майс');
    await page.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(page.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Интеграции', exact: true }).click();
    await page.getByRole('button', { name: /Кинозал/ }).click();
    await page.getByRole('button', { name: /YouTube/ }).click();
    const browse = page.locator('.cinema-browser');
    await expect(browse).toBeVisible();

    // Набрано имя канала — найден сам канал, а не только ролики про него.
    await browse.locator('.cinema-search input').fill('Lofi Girl');
    const channelCard = browse.locator('.cinema-tile-face').first();
    await expect(channelCard).toBeVisible({ timeout: 30000 });
    await channelCard.locator('.cinema-open').click();
    await expect(browse.locator('.cinema-channel-head')).toBeVisible({ timeout: 30000 });
    const videos = browse.locator('.cinema-tile');
    await expect(videos.first()).toBeVisible({ timeout: 30000 });
    const first = await videos.count();

    // Лента канала продолжается по мере спуска вниз, а не кнопкой «страница 2».
    const more = browse.getByRole('button', { name: 'Показать ещё' });
    if (await more.isVisible().catch(() => false)) {
      await more.click();
      await expect(async () => expect(await videos.count()).toBeGreaterThan(first)).toPass({
        timeout: 30000,
      });
    }

    // Вкладки канала — те же, что у площадки, и в плейлист можно зайти.
    await browse.getByRole('tab', { name: 'Плейлисты' }).click();
    const list = browse.locator('.cinema-tile-list').first();
    await expect(list).toBeVisible({ timeout: 30000 });
    await list.locator('.cinema-open').click();
    await expect(browse.locator('.cinema-detail-list')).toBeVisible({ timeout: 30000 });
    await expect(browse.locator('.cinema-tile').first()).toBeVisible({ timeout: 30000 });
    // Назад из плейлиста — на канал, а не из каталога.
    await browse.getByRole('button', { name: 'Назад' }).click();
    await expect(browse.locator('.cinema-channel-head')).toBeVisible({ timeout: 30000 });
    await browse.getByRole('tab', { name: 'О канале' }).click();
    await expect(browse.locator('.cinema-story')).toBeVisible({ timeout: 30000 });

    // Twitch начинается не с поиска: разделы там выбирают раньше, чем людей.
    await browse.getByRole('tab', { name: 'Twitch' }).click();
    await browse.getByRole('tab', { name: 'Категории' }).click();
    const category = browse.locator('.cinema-tile-box').first();
    await expect(category).toBeVisible({ timeout: 30000 });
    await category.locator('.cinema-open').click();
    await expect(browse.locator('.cinema-category-head')).toBeVisible({ timeout: 30000 });
    await expect(browse.locator('.cinema-tile').first()).toBeVisible({ timeout: 30000 });
  } finally {
    await context.close();
  }
});

/**
 * Язык озвучки и субтитры: то, чем ролик говорит и чем он подписан.
 *
 * Жалоба была «почему-то выставляется какой-то другой язык». У ролика с озвучками YouTube не
 * помечает основной **ни одну** дорожку, и плеер брал первую по списку — а список отсортирован
 * по коду языка: `ar`, `de`, `fr`. Здесь проверяется обратное: выбран оригинал, а не алфавит.
 *
 * Ролик взят самый известный из многоязычных; если площадка сегодня отдала его без озвучек,
 * сценарий проверяет только субтитры и не выдумывает поломку там, где её нет.
 */
test('the player speaks the original language and can be subtitled', async ({
  browser,
  request,
  baseURL,
}) => {
  const catalog = await request.get(`${baseURL}/api/v1/services/catalog`).catch(() => null);
  test.skip(!catalog?.ok(), 'Службы не подняты: кинозалу не у кого спрашивать');
  test.slow();
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: /Новая встреча/ }).click();
    await page.getByLabel('Ваше имя').fill('Майс');
    await page.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(page.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Интеграции', exact: true }).click();
    await page.getByRole('button', { name: /Кинозал/ }).click();
    await page.getByRole('button', { name: /YouTube/ }).click();
    const browse = page.locator('.cinema-browser');
    await browse.locator('.cinema-search input').fill('PSY GANGNAM STYLE');
    const start = browse.getByRole('button', { name: /Смотреть вместе: .*GANGNAM STYLE/ }).first();
    await expect(start).toBeVisible({ timeout: 30000 });
    await start.click({ force: true });
    await expect(page.locator('.watch-theater')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.watch-play')).toHaveAttribute('aria-label', 'Пауза для всех', {
      timeout: 40000,
    });

    // Меню качества и озвучки: у ролика с дорожками выбранной обязана быть оригинальная.
    await page.locator('.watch-theater').hover();
    await page.getByRole('button', { name: 'Качество картинки и язык звука' }).click();
    const menu = page.locator('.watch-quality-menu');
    await expect(menu).toBeVisible();
    if (
      await menu
        .getByText('Язык озвучки')
        .isVisible()
        .catch(() => false)
    ) {
      await expect(menu.locator('[role="menuitem"][data-selected="true"]').first()).toContainText('оригинал');
    }
    await page.keyboard.press('Escape');

    /*
      Субтитры. В плейлисте YouTube лежат только написанные руками, а у этого ролика их нет
      вовсе — есть распознанные речью, и их приносит наш сервер отдельным файлом. Для меню
      разницы нет: одна строка среди прочих.
    */
    await page.locator('.watch-theater').hover();
    await page.getByRole('button', { name: /Субтитры/ }).click();
    const choice = page.locator('.watch-quality-menu [role="menuitem"]').nth(1);
    await expect(choice).toBeVisible();
    await choice.click();
    // Реплики рисует сам плеер: в родном показе они лежали бы под пультом.
    await expect(page.locator('.watch-captions')).not.toBeEmpty({ timeout: 40000 });
  } finally {
    await context.close();
  }
});
