import { expect, test } from '@playwright/test';
import { routeCinema, startMeeting } from './support/cinema';

/*
  Пульт звонка помещается в сцену на любой ширине от 768 px.

  На 768 px его содержимое было на 32 px шире места в сцене: кнопка «Интеграции» у правого края
  уходила за край, а нажатие по ней прокручивало сцену ради фокуса на 23 px влево — у каталога
  и плиток срезался левый край. Теперь пульт сжимается (подпись, зазоры, кнопки — по очереди), и
  прокручивать сцене нечего.
*/

test('the call controls fit the stage from 768 px up, and «Интеграции» does not scroll the stage', async ({
  browser,
}) => {
  const room = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 768, height: 900 },
  });
  const page = await room.newPage();
  // Каталог служб — из записи: панель интеграций без службы иначе показывает отказ.
  await routeCinema(page);
  const integrations = page.getByRole('button', { name: 'Интеграции', exact: true });
  const overflow = () =>
    page.evaluate(() => {
      const footer = document.querySelector<HTMLElement>('.call-footer')!;
      const stage = document.querySelector<HTMLElement>('.stage-wrap')!;
      return {
        footer: footer.scrollWidth - footer.clientWidth,
        stage: stage.scrollWidth - stage.clientWidth,
        scrolled: stage.scrollLeft,
      };
    });
  try {
    await startMeeting(page);
    for (const width of [768, 800, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await integrations.click();
      await expect(page.locator('.services-panel')).toBeVisible();
      expect(await overflow(), `${width}px, «Интеграции» нажата`).toEqual({
        footer: 0,
        stage: 0,
        scrolled: 0,
      });
      await integrations.click();
      await expect(page.locator('.side-panel')).toHaveCount(0);
    }
    for (const width of [768, 784, 800, 850, 900, 1024, 1100, 1199]) {
      await page.setViewportSize({ width, height: 900 });
      const { footer, stage } = await overflow();
      expect(footer, `пульт на ${width}px`).toBeLessThanOrEqual(0);
      expect(stage, `сцена на ${width}px`).toBeLessThanOrEqual(0);
    }
  } finally {
    await room.close();
  }
});
