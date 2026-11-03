import { expect, test } from '@playwright/test';

test('two synthetic screen sources traverse the real SFU; a third is rejected', async ({ browser }) => {
  test.setTimeout(90000);
  const contexts = await Promise.all(
    [0, 1, 2].map(() => browser.newContext({ viewport: { width: 1366, height: 900 } })),
  );
  // Functional SFU coverage must also run without a GPU on shared CI workers.
  // Keep the larger synthetic source opt-in; neither mode measures capture-to-display latency.
  const source =
    process.env.SCREEN_TEST_HIGH_RESOLUTION === '1'
      ? { width: 2560, height: 1440, fps: 60 }
      : { width: 1280, height: 720, fps: 30 };
  for (const context of contexts)
    await context.addInitScript(({ width, height, fps }) => {
      // New contexts first execute this script on an insecure about:blank page.
      if (!navigator.mediaDevices) return;
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        let frame = 0;
        const paint = () => {
          ctx.fillStyle = '#153f73';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#fff';
          ctx.font = `${height / 20}px sans-serif`;
          ctx.fillText(`TEST SCREEN · ${frame++}`, width / 20, height / 6);
          ctx.fillRect((frame * 12) % (width - 100), height / 3, 100, 100);
        };
        paint();
        const timer = setInterval(paint, 1000 / fps);
        const stream = canvas.captureStream(fps);
        const audio = new AudioContext();
        const tone = audio.createOscillator();
        const output = audio.createMediaStreamDestination();
        tone.connect(output);
        tone.start();
        await audio.resume();
        stream.addTrack(output.stream.getAudioTracks()[0]!);
        stream.getVideoTracks()[0]!.addEventListener('ended', () => {
          clearInterval(timer);
          tone.stop();
          void audio.close();
        });
        return stream;
      };
    }, source);
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const [host, guest, third] = pages;
  try {
    await host!.goto('/');
    await host!.getByRole('button', { name: /Новая встреча/ }).click();
    await host!.getByLabel('Ваше имя').fill('Экран 1');
    await host!.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(host!.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 25000 });
    await host!.getByRole('button', { name: 'Пригласить участников' }).click();
    const invite = await host!.getByLabel('Ссылка приглашения').inputValue();
    await host!.getByRole('button', { name: 'Закрыть', exact: true }).click();
    for (const [i, page] of [guest!, third!].entries()) {
      await page.goto(invite);
      await page.getByLabel('Ваше имя').fill(`Экран ${i + 2}`);
      await page.getByRole('button', { name: 'Войти во встречу' }).click();
      await expect(page.locator('[data-media-status="connected"]')).toBeVisible();
    }
    await host!.getByRole('button', { name: 'Показать экран', exact: true }).click();
    await host!.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await host!.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
    // Плитки людей — без плиток показа (R183): у показа подпись «Экран: …» тоже содержит имя.
    const people = (page: (typeof pages)[number]) => page.locator('.person-tile:not(.presentation-tile)');
    const dock = (page: (typeof pages)[number]) => page.locator('#meeting-controls');
    // Показ сам встаёт крупно у зрителя, как в Google Meet (R183): экран — главным, все трое — лентой рядом.
    // Показ, камера и микрофон публикуются разом через настоящий SFU; на медленном стенде показ у зрителя
    // открывался через 5 с с небольшим — ровно за умолчанием `expect`.
    await expect(guest!.locator('.watch-stage video.screen-video')).toHaveCount(1, { timeout: 20000 });
    await expect
      .poll(() => guest!.locator('video.screen-video').evaluate((v: HTMLVideoElement) => v.videoWidth))
      .toBeGreaterThan(0);
    await expect(guest!.locator('.presentation-strip .person-tile')).toHaveCount(3);
    await expect(guest!.locator('.presentation-strip .person-tile video')).toHaveCount(1);
    await expect(guest!.locator('audio')).toHaveCount(2);
    // У показывающего — свой экран на своей сцене (своя дорожка) и «Вы показываете экран» в шапке.
    await expect(host!.locator('.watch-stage[data-own="true"] video.screen-video')).toHaveCount(1);
    await expect(host!.getByRole('status').filter({ hasText: 'Вы показываете экран' })).toBeVisible();
    const ownCamera = (page: (typeof pages)[number]) =>
      people(page)
        .locator('video')
        .evaluate((v: HTMLVideoElement) => {
          const track = (v.srcObject as MediaStream).getVideoTracks()[0]!;
          return {
            device: track.getSettings().deviceId ?? '',
            state: track.readyState,
            frames: v.videoWidth > 0,
          };
        });
    const localCapture = await ownCamera(host!);
    // «Открепить показ» — сетка, где показ — отдельная плитка первой; подписки на экран больше нет.
    await guest!.getByRole('button', { name: 'Открепить показ' }).click();
    await expect(guest!.locator('.watch-stage')).toHaveCount(0);
    await expect(guest!.locator('.people-grid .person-tile')).toHaveCount(4);
    await expect(guest!.locator('.people-grid .person-tile').first()).toHaveClass(/presentation-tile/);
    await expect(guest!.locator('video.screen-video')).toHaveCount(0);
    await expect(guest!.locator('audio')).toHaveCount(1);
    const micId = await guest!
      .locator('audio')
      .evaluate((v: HTMLAudioElement) => (v.srcObject as MediaStream).getAudioTracks()[0]!.id);
    // Нажатие по плитке показа — снова крупно; открепил — тот же микрофон, а не новая дорожка.
    await guest!.getByRole('button', { name: 'Закрепить показ: Экран 1' }).click();
    await expect(guest!.locator('.watch-stage video.screen-video')).toHaveCount(1);
    await expect(guest!.locator('audio')).toHaveCount(2);
    await guest!.getByRole('button', { name: 'Открепить показ' }).click();
    await expect(guest!.locator('audio')).toHaveCount(1);
    expect(
      await guest!
        .locator('audio')
        .evaluate((v: HTMLAudioElement) => (v.srcObject as MediaStream).getAudioTracks()[0]!.id),
    ).toBe(micId);
    await dock(guest!).getByRole('button', { name: 'Показать экран', exact: true }).click();
    // Свой показ — крупно у себя, как только опубликован; у третьего новый показ сменяет прежний.
    // Подпись в шапке — когда дорожка опубликована, а зрителям показ открывается после `screen.started`
    // (T48): кадр целевого размера или конец окна разгона (`settleMs`, 4 с). Раннер CI без GPU целевого
    // кадра не даёт — окно истекает всегда, на полсекунды позже умолчания `expect`.
    await expect(guest!.locator('.watch-stage[data-own="true"]')).toBeVisible({ timeout: 20000 });
    await expect(third!.locator('.presentation-main .person-caption')).toHaveText('Экран: Экран 2', {
      timeout: 20000,
    });
    await expect(third!.locator('.presentation-strip .presentation-tile')).toHaveCount(1);
    for (const name of ['Экран 1', 'Экран 2']) {
      if (!(await third!.locator('.presentation-main .person-caption').textContent())?.endsWith(name))
        await third!.getByRole('button', { name: `Закрепить показ: ${name}` }).click();
      await expect(third!.locator('.presentation-main .person-caption')).toHaveText(`Экран: ${name}`);
      await expect(third!.locator('video.screen-video')).toHaveCount(1);
      await expect
        .poll(
          () =>
            third!
              .locator('video.screen-video')
              .evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames),
          { timeout: 15000 },
        )
        .toBeGreaterThan(3);
    }
    await third!.getByRole('button', { name: 'Открепить показ' }).click();
    await expect(third!.locator('.people-grid .presentation-tile')).toHaveCount(2);
    await people(guest!).filter({ hasText: 'Экран 1' }).click({ button: 'right' });
    await guest!.getByRole('menuitem', { name: 'Закрепить камеру', exact: true }).click();
    // Закрепление помечает плитку, а не прячет комнату. Раньше оно выбрасывало всех остальных
    // из списка — закрепив собеседника, вы переставали видеть встречу; это был фильтр, а не
    // раскладка, и здесь проверялось именно старое поведение. Свой показ закрепление сняло с крупного.
    await expect(guest!.locator('.watch-stage')).toHaveCount(0);
    await expect(people(guest!)).toHaveCount(3);
    await expect(guest!.locator('.person-tile[data-pinned="true"]')).toHaveCount(1);
    await expect(guest!.locator('.person-tile[data-pinned="true"]')).toContainText('Экран 1');
    // Закреплённый — крупно над лентой остальных, с «Открепить» на плитке и в меню (R83); показы — в ленте.
    await expect(guest!.locator('.spotlight-main .person-tile[data-pinned="true"]')).toHaveCount(1);
    await expect(guest!.locator('.spotlight-strip .person-tile:not(.presentation-tile)')).toHaveCount(2);
    await expect(guest!.locator('.spotlight-strip .presentation-tile')).toHaveCount(2);
    await expect(guest!.getByRole('button', { name: 'Открепить: Экран 1' })).toBeVisible();
    await people(guest!).filter({ hasText: 'Экран 1' }).click({ button: 'right' });
    await expect(guest!.getByRole('menuitem', { name: 'Открепить камеру', exact: true })).toBeVisible();
    await guest!.keyboard.press('Escape');
    // Своя камера зеркалится, чужая — нет: признак теперь facingMode, а не «моя дорожка».
    expect(
      await guest!
        .locator('.person-tile[data-pinned="true"] .camera-video')
        .evaluate((v) => getComputedStyle(v).transform),
    ).toBe('none');
    expect(await host!.locator('.camera-video').evaluate((v) => getComputedStyle(v).transform)).toBe(
      'matrix(-1, 0, 0, 1, 0, 0)',
    );
    // Раскладки: «Говорящий» делает закреплённого крупным, не убирая остальных.
    await guest!.getByRole('button', { name: 'Расположение участников' }).click();
    await guest!.getByRole('menuitem', { name: /^Говорящий/ }).click();
    await expect(guest!.locator('.stage[data-layout="speaker"]')).toHaveCount(1);
    await expect(guest!.locator('.person-tile[data-focused="true"]')).toContainText('Экран 1');
    await expect(people(guest!)).toHaveCount(3);
    await guest!.getByRole('button', { name: 'Расположение участников' }).click();
    await guest!.getByRole('menuitem', { name: /^Сетка/ }).click();
    // Своя камера пережила и показ крупно, и смену раскладки: то же устройство,
    // живая дорожка, идущие кадры. Сверять id самой дорожки здесь больше нельзя: «Авто»
    // поднимает уровень, а показ экрана уводит камеру в маленький кадр — и то и другое
    // пересобирает дорожку намеренно, так что совпадение id зависело бы от того, успел ли
    // сработать замер. Проверка была бы не про переходы, а про расписание.
    expect(await ownCamera(host!)).toEqual({ ...localCapture, state: 'live', frames: true });
    await guest!.getByRole('button', { name: 'Открепить: Экран 1' }).click();
    await expect(guest!.locator('.person-tile[data-pinned="true"]')).toHaveCount(0);
    await expect(guest!.locator('.people-grid .person-tile:not(.presentation-tile)')).toHaveCount(3);
    await dock(third!).getByRole('button', { name: 'Показать экран', exact: true }).click();
    await expect(third!.getByRole('alert')).toContainText('Уже транслируются два экрана');
    await third!.getByRole('button', { name: 'Скрыть уведомление' }).click();
    await third!.getByRole('button', { name: 'Закрепить показ: Экран 1' }).click();
    // Идёт показ — кнопка в пульте красная, с крестиком (R77).
    await expect(dock(host!).getByRole('button', { name: 'Остановить показ', exact: true })).toHaveClass(
      /ui-icon-button--danger/,
    );
    await dock(host!).getByRole('button', { name: 'Остановить показ', exact: true }).click();
    await expect(third!.locator('video.screen-video')).toHaveCount(0);
    await expect(people(third!)).toHaveCount(3);
    await expect(host!.getByText('Вы показываете экран')).toHaveCount(0);
    await expect(host!.locator('[data-media-status="connected"]')).toBeVisible();
    await third!.getByRole('button', { name: 'Полноэкранный режим', exact: true }).click();
    await expect(third!.locator('.meeting-page')).toHaveClass(/meeting-fullscreen/);
    await third!.mouse.move(800, 180);
    await expect(third!.locator('.call-footer')).toBeHidden({ timeout: 5000 });
    await third!.mouse.move(800, 190);
    await expect(third!.locator('.call-footer')).toBeVisible();
    await third!.getByRole('button', { name: 'Выйти из полноэкранного режима' }).click();
    await host!.getByRole('button', { name: 'Настройки и действия' }).click();
    await host!.getByRole('menuitem', { name: 'Завершить для всех' }).click();
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
