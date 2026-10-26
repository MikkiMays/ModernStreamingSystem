// Кнопки окна клиента Windows поверх шапки (R122): главная, предвход и встреча в «клиенте Windows» —
// мост v2, строка браузера Windows, поддельная зона Window Controls Overlay и нарисованные поверх
// страницы «— ⧉ ×» (137×36 справа). Печатает переменные `--titlebar-*` и кнопки страницы под кнопками
// окна; цель — пусто при любой зоне.
//   node scripts/titlebar-shots.mjs --base https://cord.nikg.tech --out ../backlog/screens/R108/titlebar --wco hidden
//   --wco visible — окно «☐» (зона как у Chromium), hidden — развёрнутое 1.0.8 (зона пустая), full — зона во всю ширину
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://127.0.0.1:5208');
const out = path.resolve(arg('out', 'shots'));
const wco = arg('wco', 'hidden');
const themes = arg('themes', 'dark').split(',');
const dprs = arg('dpr', '1.25').split(',').map(Number);
const widths = arg('widths', '1280').split(',').map(Number);
mkdirSync(out, { recursive: true });

// Мост клиента Windows (v2) с возможностями 1.0.8 и ответами на запросы — как у оболочки Electron.
const bridge = `
      // Мост клиента Windows (v2) — заглушка для снимков: возможности 1.0.8 и ответы на запросы.
      (function () {
        const query = new URLSearchParams(location.search);
        
        const thumb = (hue, text) => {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 180;
          const g = canvas.getContext('2d');
          g.fillStyle = \`hsl(\${hue} 30% 92%)\`;
          g.fillRect(0, 0, 320, 180);
          g.fillStyle = \`hsl(\${hue} 40% 30%)\`;
          g.fillRect(0, 0, 320, 22);
          g.font = '14px sans-serif';
          g.fillText(text, 12, 60);
          return canvas.toDataURL('image/png');
        };
        const icon = (hue) => {
          const canvas = document.createElement('canvas');
          canvas.width = 16;
          canvas.height = 16;
          const g = canvas.getContext('2d');
          g.fillStyle = \`hsl(\${hue} 70% 50%)\`;
          g.beginPath();
          g.arc(8, 8, 7, 0, Math.PI * 2);
          g.fill();
          return canvas.toDataURL('image/png');
        };
        const games = {
          games: [
            { exe: 'cs2.exe', name: 'Counter-Strike 2', enabled: true, lastSeen: Date.now() - 20 * 60000 },
            { exe: 'dota2.exe', name: 'Dota 2', enabled: false, lastSeen: Date.now() - 5 * 86400000 },
          ],
          active: null,
        };
        const settings = {
          tray: true, thumbar: true, badge: true, flash: true, sleepBlocker: true, overlay: true, autostart: false,
          mini: true, overlayCorner: 'tl', overlaySize: 'm', overlayNames: 'always', overlayOpacity: 100, overlayToast: true,
        };
        window.cordDesktop = {
          protocol: { major: 2, minor: 9 },
          features: [
            'app.settings', 'overlay', 'overlay.widget', 'golive', 'games', 'hotkeys', 'ptt', 'tray', 'thumbar',
            'badge', 'attention', 'sleep', 'mini', 'autostart', 'capture', 'capture.audio', 'servers', 'update', 'session',
          ],
          app: { version: '1.0.8', arch: 'x64' },
          bootstrap: { profile: 'default', theme: 'system', language: null, showPing: false, notificationSounds: true, autoConnect: true },
          send() {},
          invoke(method, payload) {
            if (method === 'app.settings') return Promise.resolve(Object.assign(settings, payload || {}));
            if (method.startsWith('games.')) return Promise.resolve(games);
            if (method === 'capture.sources')
              return Promise.resolve({
                systemAudio: true,
                appAudio: true,
                sources: [
                  { id: 'window:1:0', kind: 'window', name: 'Release v1.0.238 · Eugeny/tabby · GitHub — Google Chrome', thumbnail: thumb(210, 'GitHub'), icon: icon(30) },
                  { id: 'window:2:0', kind: 'window', name: 'Telegram', thumbnail: thumb(200, 'Telegram'), icon: icon(200) },
                  { id: 'window:3:0', kind: 'window', name: 'Проводник', thumbnail: thumb(45, 'Explorer'), icon: icon(45) },
                  { id: 'screen:1:0', kind: 'screen', name: 'Экран 1', thumbnail: thumb(260, 'Screen 1'), icon: '' },
                  { id: 'screen:2:0', kind: 'screen', name: 'Экран 2', thumbnail: thumb(120, 'Screen 2'), icon: '' },
                ],
              });
            return Promise.resolve(null);
          },
          on() {
            return () => {};
          },
        };
      })();
    `;

const init = (mode) => `
  ${bridge}
  // Зона кнопок окна: видна (как в окне «☐»), пустая (развёрнутое окно 1.0.8, «⧉») или во всю ширину.
  const listeners = new Set();
  const overlay = {
    get visible() { return ${JSON.stringify(mode)} !== 'hidden'; },
    getTitlebarAreaRect() {
      if (${JSON.stringify(mode)} === 'hidden') return new DOMRect(0, 0, 0, 0);
      if (${JSON.stringify(mode)} === 'full') return new DOMRect(0, 0, innerWidth, 36);
      return new DOMRect(0, 0, innerWidth - 137, 36);
    },
    addEventListener(type, listener) { listeners.add(listener); },
    removeEventListener(type, listener) { listeners.delete(listener); },
  };
  Object.defineProperty(Navigator.prototype, 'windowControlsOverlay', { get: () => overlay, configurable: true });
  addEventListener('DOMContentLoaded', () => {
    const buttons = document.createElement('div');
    buttons.id = 'fake-caption';
    buttons.style.cssText = 'position:fixed;top:0;right:0;width:137px;height:36px;display:flex;z-index:2147483647;pointer-events:none;font:14px/36px sans-serif;color:#e9ecf1;mix-blend-mode:difference';
    for (const glyph of ['—', '⧉', '✕']) {
      const cell = document.createElement('span');
      cell.textContent = glyph;
      cell.style.cssText = 'flex:1;text-align:center;outline:1px dashed rgba(255,80,80,.9);outline-offset:-1px';
      buttons.append(cell);
    }
    document.body.append(buttons);
  });
`;

const report = [];
for (const dpr of dprs)
  for (const width of widths) {
    const browser = await chromium.launch({
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--force-device-scale-factor=${dpr}`,
        `--window-size=${width},800`,
      ],
    });
    for (const theme of themes) {
      const context = await browser.newContext({
        viewport: null,
        reducedMotion: 'reduce',
        locale: 'ru-RU',
        colorScheme: theme,
        permissions: ['camera', 'microphone'],
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Cord/1.0.8 Chrome/152.0.0.0 Electron/44.9.1 Safari/537.36',
      });
      await context.addInitScript(init(wco));
      await context.addInitScript((value) => localStorage.setItem('cord:theme', value), theme);
      const page = await context.newPage();
      const measure = async (name) => {
        await page.evaluate(() => document.fonts.ready.then(() => 1));
        await page.waitForTimeout(400);
        const file = `${name}-${wco}-${width}-${theme}-dpr${dpr}.png`;
        await page.screenshot({ path: path.join(out, file) });
        const hit = await page.evaluate(() => {
          const caption = document.getElementById('fake-caption')?.getBoundingClientRect();
          const css = getComputedStyle(document.documentElement);
          const under = [];
          for (const element of document.querySelectorAll('button, a, input, [role="button"], h1, h2'))
            if (!element.closest('#fake-caption')) {
              const r = element.getBoundingClientRect();
              if (
                r.width &&
                r.height &&
                caption &&
                r.right > caption.left &&
                r.top < caption.bottom &&
                r.bottom > 0
              )
                under.push(
                  (element.getAttribute('aria-label') || element.textContent || element.tagName)
                    .trim()
                    .slice(0, 40),
                );
            }
          return {
            titlebarH: css.getPropertyValue('--titlebar-h').trim(),
            titlebarEnd: css.getPropertyValue('--titlebar-end').trim(),
            under,
          };
        });
        report.push({ file, ...hit });
        console.log(file, JSON.stringify(hit));
      };
      await page.goto(base, { timeout: 600000, waitUntil: 'domcontentloaded' });
      await page
        .getByRole('button', { name: /Новая встреча/ })
        .first()
        .waitFor({ timeout: 600000 });
      await measure('home');
      await page
        .getByRole('button', { name: /Новая встреча/ })
        .first()
        .click();
      await page.getByLabel('Ваше имя').waitFor({ timeout: 120000 });
      await page.getByLabel('Ваше имя').fill('Проверка');
      await measure('prejoin');
      await page.getByRole('button', { name: 'Начать встречу' }).click();
      await page.locator('.meeting-header').waitFor({ timeout: 120000 });
      await page.waitForTimeout(1500);
      await measure('meeting');
      await context.close();
    }
    await browser.close();
  }
writeFileSync(path.join(out, `titlebar-${wco}.json`), JSON.stringify(report, null, 1));
console.log(`под кнопками окна: ${report.filter((r) => r.under.length).length} из ${report.length}`);
