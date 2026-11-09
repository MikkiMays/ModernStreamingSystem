import { createRoot } from 'react-dom/client';
// Слой переводов — раньше всего остального: модули ниже уже говорят через него (E14).
import { applyLanguage } from './i18n';
// Оформление — одним списком на оба входа: приложение и Mini App Telegram (`telegram/main.tsx`).
import './app-styles';
// Путь шрифтов доски (R159) — во входе, а не рядом с доской: в сборке Excalidraw лежит в одном чанке с
// доской и выполняется раньше её модулей, а список адресов шрифтов он собирает сразу.
import './ui/board/asset-path';
import App from './App';
import { readPreferences } from './core/preferences';
import {
  acceptCarriedPreferences,
  startSharedPreferences,
  takePrefsFragment,
} from './core/shared-preferences';
import { isDesktop } from './core/desktop';
import { unlockNotificationAudio } from './core/sounds';
import { installInputModality } from './ui/input-modality';
import { installDevicePixel } from './ui/device-pixel';
import { installScrollActivity } from './ui/scroll-activity';
import { startFailureReports, watchFailures } from './core/failure';
import { sendFailures } from './api/client';
import { noteVisit } from './core/analytics';
import { reloadForNewBuild } from './ui/lazy-part';
unlockNotificationAudio();
// Кольцо фокуса — только тому, кто ходит клавиатурой (S1, R26).
installInputModality();
// Ровность до физического пикселя на 125–150 % масштаба (R123): `--device-px` для токенов.
installDevicePixel();
// Бегунок длинных колонок виден и во время прокрутки с клавиатуры (S2, R17).
installScrollActivity();
// Необработанные ошибки страницы — в журнал, последние ошибки обращения (E13) и счётчик ядра; счёт
// ошибок клиента уходит ядру сводкой раз в 30 с и при уходе со страницы (R180).
watchFailures();
startFailureReports(sendFailures);
// Аналитика продукта (R210): «открыл Cord» — один раз на сессию вкладки или запуск приложения.
noteVisit('open');

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
  Модуль не загрузился — чаще всего вкладка открыта до выкатки и просит модуль прежней сборки, которого на
  сервере уже нет (`ui/lazy-part.tsx`). Не во встрече — одна перезагрузка за новой сборкой; во встрече —
  ничего: часть, которая не открылась, скажет об этом сама, а разговор не оборвётся.
*/
window.addEventListener('vite:preloadError', () => {
  reloadForNewBuild();
});

/*
  Общие настройки (R146) — до первой отрисовки. Фрагмент `#cord-prefs=…` («Сменить сервер» в
  браузере) стирается сразу, а принимается, только если переход был с сервера каталога; в клиенте
  Windows — сверка устройств по названию и перенос со старой версии. Ни то ни другое не держит
  страницу дольше полутора секунд.
*/
const carried = takePrefsFragment();
const shared = Promise.all([
  carried ? acceptCarriedPreferences(carried).catch(() => false) : false,
  startSharedPreferences().catch(() => {}),
]);
const settled = Promise.race([shared, new Promise((resolve) => setTimeout(resolve, 1500))]);
/*
  Первая отрисовка — уже на языке человека: выбор из настроек, иначе язык браузера. Русский встроен
  и ставится сразу; другой язык — один файл каталога, и интерфейс ждёт его, а не мигает русским.
*/
void settled
  .then(() => applyLanguage(readPreferences().language))
  .then(() => createRoot(document.getElementById('root')!).render(<App />));
