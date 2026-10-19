import { createRoot } from 'react-dom/client';
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
// Кинозал — сразу за раскладкой встречи, откуда он вынесен: там же он и стоял в каскаде.
import './ui/cinema/cinema.css';
import './ui/cinema/theater.css';
import './desktop-home.css';
import './poker.css';
import './durak.css';
import App from './App';
import { unlockNotificationAudio } from './core/sounds';
unlockNotificationAudio();

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

createRoot(document.getElementById('root')!).render(<App />);
