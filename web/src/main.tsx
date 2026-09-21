import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles.css';
import './accessibility.css';
import './room-layout.css';
import './desktop-home.css';
import './poker.css';
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
