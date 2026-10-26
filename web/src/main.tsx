import { createRoot } from 'react-dom/client';
// Слой переводов — раньше всего остального: модули ниже уже говорят через него (E14).
import { applyLanguage } from './i18n';
// Оформление — одним списком на оба входа: приложение и Mini App Telegram (`telegram/main.tsx`).
import './app-styles';
import App from './App';
import { readPreferences } from './core/preferences';
import { isDesktop } from './core/desktop';
import { unlockNotificationAudio } from './core/sounds';
import { installInputModality } from './ui/input-modality';
import { installDevicePixel } from './ui/device-pixel';
import { installScrollActivity } from './ui/scroll-activity';
import { watchErrors } from './core/support';
unlockNotificationAudio();
// Кольцо фокуса — только тому, кто ходит клавиатурой (S1, R26).
installInputModality();
// Ровность до физического пикселя на 125–150 % масштаба (R123): `--device-px` для токенов.
installDevicePixel();
// Бегунок длинных колонок виден и во время прокрутки с клавиатуры (S2, R17).
installScrollActivity();
// Последние ошибки страницы — для обращения в поддержку, если человек сам их приложит (E13).
watchErrors();

/**
 * Регистрируется после загрузки и только в браузере.
 *
 * В оболочке Windows он не нужен — там уже есть установленное приложение, — а на
 * `localhost` мешал бы разработке: свежая сборка соревновалась бы с копией предыдущей.
 * Отказ ничего не ломает: без него Cord остаётся обычной страницей.
 */
if ('serviceWorker' in navigator && !isDesktop() && import.meta.env.PROD)
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  });

/*
  Первая отрисовка — уже на языке человека: выбор из настроек, иначе язык браузера. Русский встроен
  и ставится сразу; другой язык — один файл каталога, и интерфейс ждёт его, а не мигает русским.
*/
void applyLanguage(readPreferences().language).then(() =>
  createRoot(document.getElementById('root')!).render(<App />),
);
