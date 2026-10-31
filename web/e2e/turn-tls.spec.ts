import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

/*
  TURN по TLS на 443 везёт настоящее медиа (R149, Р-50, Р-52). Два браузера во встрече на стенде, оба в
  режиме «только TURN по TLS» (`localStorage['cord:relay'] = 'tls'`, `web/src/media/turn-tls.ts`): ICE не
  берёт ни UDP, ни TCP 7881, ни TURN по UDP — только `turns:turn.<домен>:443`. Ведущий включает поддельные
  камеру и микрофон Chromium; у гостя кадры идут, звук приходит голосом, а не кадрами тишины, и
  «Диагностика» у обоих называет путь — «Через ретранслятор TURN · TLS», у дорожек — «TURN · TLS».

  Только против стенда в режиме `strict`: локально TURN/TLS на 443 нет. Одна встреча на прогон — у адреса
  стенда 10 новых встреч в час. Веб, ещё не выкаченный на стенд, — через `scripts/stand-dev.mjs`:

    cd web && node scripts/stand-dev.mjs &
    CORD_STAND_DEV=127.0.0.1:5443 PLAYWRIGHT_BASE_URL=https://cord.nikg.tech npx playwright test e2e/turn-tls.spec.ts
*/

test.skip(!process.env.PLAYWRIGHT_BASE_URL, 'только против стенда: локально нет TURN по TLS на 443');

const HOST = 'Майс';
const GUEST = 'Алекс';

async function relayOnly(browser: Browser) {
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 900 },
  });
  // До первой строки приложения: флаг читается один раз, когда встреча создаёт медиасессию.
  await context.addInitScript(() => localStorage.setItem('cord:relay', 'tls'));
  return context;
}

async function connected(page: Page) {
  // Ретранслятор по TLS поднимается дольше прямого пути: TLS до TURN, выделение адреса, проверки ICE.
  await expect(page.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 45000 });
}

async function openDiagnostics(page: Page) {
  await page.getByRole('button', { name: 'Настройки и действия' }).click();
  await page.getByRole('menuitem', { name: /^Диагностика/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Диагностика' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Значение строки «подпись — значение» в «Диагностике». */
const metric = (scope: Locator, label: string) =>
  scope
    .locator('.diagnostics-metric')
    .filter({ has: scope.page().locator('dt', { hasText: new RegExp(`^${label}$`) }) })
    .locator('dd');

/** Первая дорожка с таким заголовком: у отдачи с simulcast их по слою на каждую. */
const track = (dialog: Locator, title: string) =>
  dialog.locator('article.diagnostics-track').filter({ hasText: title }).first();

test('TURN по TLS на 443 везёт камеру и звук между двумя браузерами', async ({ browser }) => {
  test.setTimeout(180000);
  const a = await relayOnly(browser);
  const b = await relayOnly(browser);
  const host = await a.newPage();
  const guest = await b.newPage();
  try {
    await host.goto('/');
    await host.getByRole('button', { name: /Новая встреча/ }).click();
    await host.getByLabel('Ваше имя').fill(HOST);
    await host.getByRole('button', { name: 'Начать встречу' }).click();
    await connected(host);
    await host.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
    const invitation = await host.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await guest.goto(invitation);
    await guest.getByLabel('Ваше имя').fill(GUEST);
    await guest.getByRole('button', { name: 'Войти во встречу' }).click();
    await connected(guest);

    await host.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await host.getByRole('button', { name: 'Включить микрофон', exact: true }).click();

    // Кадры идут, а не один застывший: счётчик показанных растёт.
    const camera = guest.locator(`video[aria-label="Камера: ${HOST}"]`);
    await expect
      .poll(() => camera.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30000 })
      .toBeGreaterThan(0);
    const frames = () =>
      camera.evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames);
    const shown = await frames();
    await expect.poll(frames, { timeout: 20000 }).toBeGreaterThan(shown + 30);

    // Гость: путь — ретранслятор по TLS, и выбран он режимом проверки; звук и картинка ведущего — тем же путём.
    const seen = await openDiagnostics(guest);
    await expect(metric(seen, 'Путь медиа')).toContainText('Через ретранслятор TURN · TLS', {
      timeout: 15000,
    });
    await expect(seen.getByText(/Включена проверка TURN\/TLS/)).toBeVisible();
    const voice = track(seen, `${HOST} · Аудио · Получение`);
    await expect(metric(voice, 'Соединение')).toHaveText('TURN · TLS', { timeout: 15000 });
    // Голос, а не кадры тишины (≈1–4 Кбит/с): поддельный микрофон Chromium пищит без пауз.
    await expect
      .poll(async () => parseInt(await metric(voice, 'Битрейт').innerText(), 10), { timeout: 20000 })
      .toBeGreaterThan(10);
    await expect(metric(voice, 'Звук отправителя')).toHaveText('Идёт');
    await expect(metric(track(seen, `${HOST} · Видео · Получение`), 'Соединение')).toHaveText('TURN · TLS');
    await guest.keyboard.press('Escape');
    await expect(seen).toHaveCount(0);

    // Ведущий: его отдача — тем же путём (принимать ему нечего, путь читается по своей отдаче).
    const sent = await openDiagnostics(host);
    await expect(metric(sent, 'Путь медиа')).toContainText('Через ретранслятор TURN · TLS', {
      timeout: 15000,
    });
    await expect(metric(track(sent, `${HOST} · Видео · Передача`), 'Соединение')).toHaveText('TURN · TLS');
    await host.keyboard.press('Escape');

    await host.getByRole('button', { name: 'Настройки и действия' }).click();
    await host.getByRole('menuitem', { name: 'Завершить для всех' }).click();
    await expect(host.getByRole('heading', { name: 'Встреча завершена' })).toBeVisible();
  } finally {
    await a.close();
    await b.close();
  }
});
