import { createRoot } from 'react-dom/client';
// Слой переводов — раньше всего остального, как в `main.tsx`.
import { applyLanguage } from '../i18n';
import '../app-styles';
import './telegram.css';
import { readPreferences } from '../core/preferences';
import { unlockNotificationAudio } from '../core/sounds';
import { installDevicePixel } from '../ui/device-pixel';
import { installInputModality } from '../ui/input-modality';
import { installScrollActivity } from '../ui/scroll-activity';
import { startTelegram } from './sdk';
import { TelegramApp } from './TelegramApp';
// Путь шрифтов доски (R159) — во входе, раньше ленивого чанка с Excalidraw (см. `src/main.tsx`).
import '../ui/board/asset-path';

/*
  Вход Mini App Telegram (`tg.html`, E09). Telegram — до React: цвета шапки и фона, полный экран и
  `ready()` уходят, пока на экране статичная загрузка, и заставка Telegram сменяется ею без шва.
  Service worker здесь не ставится: WebView Telegram — не установленное приложение, а кэш бандла
  пережил бы выкатку.
*/
const shell = startTelegram();
document.documentElement.dataset.telegram = shell ? shell.platform : 'outside';
unlockNotificationAudio();
installInputModality();
installDevicePixel();
installScrollActivity();

void applyLanguage(readPreferences().language).then(() =>
  createRoot(document.getElementById('root')!).render(<TelegramApp shell={shell} />),
);
