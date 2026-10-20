import { createRoot } from 'react-dom/client';
// Слой переводов — раньше всего остального: модули ниже уже говорят через него (E14).
import { applyLanguage } from './i18n';
import '@fontsource-variable/inter';
import './styles.css';
import './accessibility.css';
import './room-layout.css';
/*
  Экран звонка (E04) — сцена, пульт и панель встречи на токенах. Здесь, а не в компонентах: CSS
  компонента встаёт в конец каскада, а кинозал и столы ниже переопределяют сцену равным весом и
  обязаны оставаться после неё — как и тогда, когда всё это было `styles.css` и `room-layout.css`.
*/
import './ui/stage.css';
import './ui/call-dock.css';
import './ui/meeting-panel.css';
// Интеграции в панели встречи — витрина и музыка (E06-B), на токенах.
import './ui/integrations.css';
// Кинозал — сразу за раскладкой встречи, откуда он вынесен: там же он и стоял в каскаде.
import './ui/cinema/cinema.css';
import './ui/cinema/theater.css';
import './desktop-home.css';
import './poker.css';
import './durak.css';
import App from './App';
import { readPreferences } from './core/preferences';
import { unlockNotificationAudio } from './core/sounds';
import { installPointerFocus } from './ui/pointer-focus';
unlockNotificationAudio();
installPointerFocus();

/**
 * Регистрируется после загрузки и только в браузере.
 *
 * В оболочке Windows он не нужен — там уже есть установленное приложение, — а на
 * `localhost` мешал бы разработке: свежая сборка соревновалась бы с копией предыдущей.
 * Отказ ничего не ломает: без него Cord остаётся обычной страницей.
 */
if ('serviceWorker' in navigator && !window.chrome?.webview && import.meta.env.PROD)
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
