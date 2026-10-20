import { createRoot } from 'react-dom/client';
// Слой переводов — раньше всего остального: модули ниже уже говорят через него (E14).
import { applyLanguage } from './i18n';
// Оформление — одним списком на оба входа: приложение и Mini App Telegram (`telegram/main.tsx`).
import './app-styles';
import App from './App';
import { readPreferences } from './core/preferences';
import { isDesktop } from './core/desktop';
import { unlockNotificationAudio } from './core/sounds';
import { installPointerFocus } from './ui/pointer-focus';
import { watchErrors } from './core/support';
unlockNotificationAudio();
installPointerFocus();
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
