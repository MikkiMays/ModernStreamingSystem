import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Камера — непрерывный поток (R189, И1–И4, И6): камера, которую человек включил, возвращается сама.
 *
 * Без настоящего устройства: поддельная камера Chromium, а поломки — перехватом до кода страницы
 * (`hooks`): `getUserMedia` отказывает по команде, у захвата вызываются `ended` и `mute`, как это делает
 * система, когда камеру отбирают, усыпляют или перенастраивают. Сценарии — ровно те, что воспроизвели
 * «камера отвалилась» на стенде (`docs/superpowers/specs/2026-11-05-r189-camera-continuity.md`):
 * 1. захват кончился, устройство отказало один раз — камера возвращается сама, кнопка «Выключить
 *    камеру» всё это время, у зрителя снова идут кадры;
 * 2. отказы 20 с подряд — возвращается, когда они кончаются;
 * 3. `mute` без `unmute` — публикация не заглушена, у зрителя видео на месте, сторож лечит;
 * 4. разрешение отозвано — камера выключена, без шторма попыток.
 * Нужен стенд с SFU: локальный стек CI или `PLAYWRIGHT_BASE_URL`.
 */
test.skip(
  !process.env.PLAYWRIGHT_BASE_URL && !process.env.CI,
  'нужен стенд с SFU: PLAYWRIGHT_BASE_URL=https://…',
);

function hooks() {
  const w = window as unknown as {
    __gum: MediaStreamTrack[];
    __gumFail: string | null;
    __gumCalls: number;
    __permission: PermissionState | null;
    __pcs: RTCPeerConnection[];
  };
  w.__gum = [];
  w.__gumFail = null;
  w.__gumCalls = 0;
  w.__permission = null;
  w.__pcs = [];
  const Native = window.RTCPeerConnection;
  if (Native) {
    class Wrapped extends Native {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args);
        w.__pcs.push(this);
      }
    }
    window.RTCPeerConnection = Wrapped as typeof RTCPeerConnection;
  }
  if (!navigator.mediaDevices) return;
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
    if (constraints?.video) {
      w.__gumCalls++;
      if (w.__gumFail) throw new DOMException('Could not start video source', w.__gumFail);
    }
    const stream = await gum(constraints);
    for (const track of stream.getVideoTracks()) w.__gum.push(track);
    return stream;
  };
  // Отозванное разрешение — как его видит `permissions.query`.
  const query = navigator.permissions?.query.bind(navigator.permissions);
  if (query)
    navigator.permissions.query = async (descriptor: PermissionDescriptor) => {
      const status = await query(descriptor);
      if (w.__permission && (descriptor as { name: string }).name === 'camera')
        return { state: w.__permission, onchange: null } as PermissionStatus;
      return status;
    };
}

/** Что видно снаружи: кнопка камеры, живой захват, отправка, видео у зрителя. */
type Look = {
  button: string | null;
  live: number;
  sent: number[];
  ownVideo: boolean;
  gumCalls: number;
};
async function look(page: Page): Promise<Look> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      __gum: MediaStreamTrack[];
      __pcs: RTCPeerConnection[];
      __gumCalls: number;
    };
    const sent: number[] = [];
    for (const pc of w.__pcs) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats();
      stats.forEach((report: RTCStats & { kind?: string; framesSent?: number }) => {
        if (report.type === 'outbound-rtp' && report.kind === 'video') sent.push(report.framesSent ?? 0);
      });
    }
    return {
      button:
        document.querySelector('#meeting-controls [aria-label*="камеру" i]')?.getAttribute('aria-label') ??
        null,
      live: w.__gum.filter((t) => t.readyState === 'live').length,
      sent,
      ownVideo: !!document.querySelector('.person-tile video.camera-video'),
      gumCalls: w.__gumCalls,
    };
  });
}

/** У зрителя: видео отправителя есть, и кадры продолжают приходить. */
async function viewerFrames(page: Page): Promise<{ video: boolean; decoded: number }> {
  return page.evaluate(async () => {
    const w = window as unknown as { __pcs: RTCPeerConnection[] };
    let decoded = 0;
    for (const pc of w.__pcs) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats();
      stats.forEach((report: RTCStats & { kind?: string; framesDecoded?: number }) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') decoded += report.framesDecoded ?? 0;
      });
    }
    return { video: !!document.querySelector('.person-tile video.camera-video'), decoded };
  });
}

async function join(page: Page, name: string, invite?: string) {
  if (invite) {
    await page.goto(invite);
    await page.getByLabel('Ваше имя').fill(name);
    await page.getByRole('button', { name: 'Войти во встречу' }).click();
  } else {
    await page.goto('/');
    await page.getByRole('button', { name: /Новая встреча/ }).click({ timeout: 30000 });
    await page.getByLabel('Ваше имя').fill(name);
    await page.getByRole('button', { name: 'Начать встречу' }).click();
  }
  await expect(page.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 60000 });
}

/** Сделать с живым захватом то, что делает система. */
const onLive = (page: Page, action: 'ended' | 'mute' | 'unmute') =>
  page.evaluate((what) => {
    const w = window as unknown as { __gum: MediaStreamTrack[] };
    const track = w.__gum.filter((t) => t.readyState === 'live').at(-1);
    if (!track) throw new Error('no live capture');
    if (what === 'ended') {
      track.stop();
      track.dispatchEvent(new Event('ended'));
    } else {
      // Как система: `muted` у дорожки меняется вместе с событием, а не только событие.
      Object.defineProperty(track, 'muted', { configurable: true, get: () => what === 'mute' });
      track.dispatchEvent(new Event(what));
    }
  }, action);

const refuse = (page: Page, name: string | null) =>
  page.evaluate(
    (value) => void ((window as unknown as { __gumFail: string | null }).__gumFail = value),
    name,
  );

/** Кадры у зрителя идут: счётчик декодированных растёт (после подписки SFU даёт первый кадр не сразу). */
async function expectViewerFlowing(viewer: Page) {
  const before = await viewerFrames(viewer);
  expect(before.video).toBe(true);
  await viewer.waitForTimeout(2000);
  await expect
    .poll(async () => (await viewerFrames(viewer)).decoded, {
      timeout: 30000,
      message: 'кадры у зрителя идут',
    })
    .toBeGreaterThan(before.decoded);
}

test('камера возвращается сама после `ended`, отказов устройства и `mute`; без разрешения — выключается (R189)', async ({
  browser,
}) => {
  test.setTimeout(6 * 60 * 1000);
  const contexts: BrowserContext[] = await Promise.all([browser.newContext(), browser.newContext()]);
  for (const context of contexts) await context.addInitScript(hooks);
  const [host, guest] = (await Promise.all(contexts.map((c) => c.newPage()))) as [Page, Page];
  try {
    await join(host, 'Майс');
    await host.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
    const invite = await host.getByLabel('Ссылка приглашения').inputValue();
    await host.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await join(guest, 'Аня', invite);
    const dock = host.locator('#meeting-controls');
    const off = dock.getByRole('button', { name: 'Выключить камеру', exact: true });
    await dock.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await expect(off).toBeVisible({ timeout: 15000 });
    await expect(guest.locator('.person-tile video.camera-video')).toBeVisible({ timeout: 20000 });
    await expectViewerFlowing(guest);
    const gumAtStart = (await look(host)).gumCalls;

    // Настройки → «Видео» во встрече с включённой камерой — второго захвата нет (превью на дорожке встречи).
    await dock.getByRole('button', { name: 'Настройки и действия' }).click();
    await host.getByRole('menuitem', { name: 'Настройки', exact: true }).click();
    const settings = host.getByRole('dialog', { name: 'Настройки' });
    await settings.getByRole('button', { name: 'Видео', exact: true }).click();
    await expect(settings.locator('.setting-camera__preview[data-state="live"]')).toBeVisible({
      timeout: 10000,
    });
    await host.waitForTimeout(1500);
    expect((await look(host)).gumCalls).toBe(gumAtStart);
    await host.keyboard.press('Escape');

    // 1. Захват кончился, устройство один раз отказало: LiveKit заглушил бы публикацию — сторож возвращает.
    await refuse(host, 'NotReadableError');
    await onLive(host, 'ended');
    await host.waitForTimeout(1500);
    await refuse(host, null);
    await expect
      .poll(async () => (await look(host)).live, { timeout: 30000, message: 'захват вернулся сам' })
      .toBeGreaterThan(0);
    await expect(off).toBeVisible();
    await expect(host.locator('.own-camera-chip')).toHaveCount(0, { timeout: 15000 });
    await expectViewerFlowing(guest);

    // 2. Устройство отказывает 20 с подряд (драйвер, другое приложение): возвращается, когда отпустит.
    await refuse(host, 'NotReadableError');
    await onLive(host, 'ended');
    await host.waitForTimeout(20000);
    expect((await look(host)).live).toBe(0);
    await expect(off).toBeVisible();
    await expect(host.locator('.own-camera-chip')).toHaveText('Камера переподключается…');
    await refuse(host, null);
    await expect
      .poll(async () => (await look(host)).live, { timeout: 40000, message: 'захват вернулся после отказов' })
      .toBeGreaterThan(0);
    await expect(host.locator('.own-camera-chip')).toHaveCount(0, { timeout: 15000 });
    await expectViewerFlowing(guest);

    // 3. `mute` без `unmute`: LiveKit через 5 с снимал бы дорожку с отправителя и глушил публикацию —
    // теперь нет: у зрителя видео на месте, а сторож через 3 с перезахватывает.
    const livesBefore = (await look(host)).gumCalls;
    await onLive(host, 'mute');
    await host.waitForTimeout(10000);
    expect((await viewerFrames(guest)).video).toBe(true);
    await expect(off).toBeVisible();
    expect((await look(host)).gumCalls).toBeGreaterThan(livesBefore);
    const senderAttached = await host.evaluate(() => {
      const w = window as unknown as { __pcs: RTCPeerConnection[] };
      return w.__pcs.some((pc) =>
        pc.getSenders().some((s) => s.track?.kind === 'video' && s.track.readyState === 'live'),
      );
    });
    expect(senderAttached).toBe(true);
    await expectViewerFlowing(guest);

    // 4. Разрешение отозвано: камера выключается, попыток не копится.
    await host.evaluate(() => void ((window as unknown as { __permission: string }).__permission = 'denied'));
    await refuse(host, 'NotAllowedError');
    await onLive(host, 'ended');
    await expect(dock.getByRole('button', { name: 'Включить камеру', exact: true })).toBeVisible({
      timeout: 20000,
    });
    const calls = (await look(host)).gumCalls;
    await host.waitForTimeout(12000);
    expect((await look(host)).gumCalls).toBe(calls);
    await expect(host.locator('.media-error')).toContainText('Нет доступа к камере');
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
