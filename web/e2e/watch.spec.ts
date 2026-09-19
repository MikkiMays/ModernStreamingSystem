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
    await expect(host.getByRole('button', { name: /Игры/ })).toBeDisabled();
    await host.getByRole('button', { name: /Кинозал/ }).click();
    await host.getByRole('button', { name: /YouTube/ }).click();
    const browse = host.locator('.cinema-browser');
    await expect(browse).toBeVisible();
    // Каталог личный: у гостя на сцене по-прежнему разговор.
    await expect(guest.locator('.cinema-browser')).toHaveCount(0);

    await browse.locator('.cinema-search input').fill('big buck bunny');
    const result = browse.locator('.cinema-tile').first();
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
    await expect(host.getByRole('button', { name: 'Пауза для всех' })).toBeVisible({ timeout: 30000 });
    // Пауза общая: её жмёт и тот, кто ничего не приносил, и видят это все.
    const pause = guest.getByRole('button', { name: 'Пауза для всех' });
    await expect(pause).toBeEnabled();
    await pause.click();
    await expect(host.getByRole('button', { name: 'Включить для всех' })).toBeVisible({
      timeout: 15000,
    });
    // Громкость и качество — личные: комнату они не двигают.
    await expect(guest.getByRole('slider', { name: 'Громкость просмотра' })).toBeVisible();

    // Вторая интеграция во встречу не пускается, пока открыта первая.
    await guest.getByRole('button', { name: 'Интеграции', exact: true }).click();
    await expect(guest.getByRole('button', { name: /Музыка/ })).toBeDisabled();

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
