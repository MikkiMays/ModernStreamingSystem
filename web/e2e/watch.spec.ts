import { expect, test } from '@playwright/test';

/**
 * Кинозал в двух настоящих браузерах.
 *
 * Проверяется путь целиком — витрина, поиск, открытие на всех, пульт у того, кто принёс, —
 * но без ожидания настоящих кадров: за ними стоит чужая площадка, и прогон не должен падать
 * из-за её настроения. Что видео действительно идёт синхронно, меряется живьём против прода
 * и записано в `docs/INTEGRATIONS.md`.
 */
test('the cinema opens for the whole room from search, and only its owner drives', async ({
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

    // Витрина: сначала группы, потом сервисы внутри группы.
    await host.getByRole('button', { name: 'Интеграции', exact: true }).click();
    await expect(host.getByRole('button', { name: /Игры/ })).toBeDisabled();
    await host.getByRole('button', { name: /Кинозал/ }).click();
    await host.getByRole('button', { name: /YouTube/ }).click();
    await host.getByRole('textbox').last().fill('big buck bunny');
    const result = host.locator('.cinema-card').first();
    await expect(result).toBeVisible({ timeout: 30000 });
    const title = (await result.locator('b').textContent())?.trim() ?? '';
    await result.click();

    // Кинозал открывается у обоих, люди переезжают в ленту под плеером.
    for (const page of [host, guest]) {
      await expect(page.locator('.watch-theater')).toBeVisible({ timeout: 30000 });
      await expect(page.locator('.people-strip .person-tile')).toHaveCount(2);
    }
    await expect(host.locator('.watch-title b')).toContainText(title.slice(0, 12));
    // Пульт у того, кто принёс: у гостя те же кнопки, но нажать их нельзя.
    await expect(host.getByRole('button', { name: /Пауза для всех|Включить для всех/ })).toBeEnabled();
    await expect(guest.getByRole('button', { name: /Пауза для всех|Включить для всех/ })).toBeDisabled();
    await expect(guest.locator('.watch-title small')).toContainText('Управляет');

    // Вторая интеграция во встречу не пускается, пока открыта первая.
    await guest.getByRole('button', { name: 'Интеграции', exact: true }).click();
    await expect(guest.getByRole('button', { name: /Музыка/ })).toBeDisabled();

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
