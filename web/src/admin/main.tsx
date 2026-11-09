import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '../styles.css';
import '../accessibility.css';
import './admin-tokens.css';
import './admin.css';
import { installInputModality } from '../ui/input-modality';
import { installDevicePixel } from '../ui/device-pixel';
import { AdminApp } from './AdminApp';
import { readTheme } from './theme';

/*
  Вход пульта флота (`admin.html`, R207). Слой переводов приложения не поднимается: пульт — только
  по-русски (Р-114), его тексты — `src/i18n/admin/ru.ts`. Каскад — только основа приложения (токены, сброс,
  марка) и набор: сцена встречи, кинозал и столы пульту не нужны (R220). Тема — своя настройка пульта
  (`cord:theme` на имени пульта: у пульта и продукта разные адреса и разное хранилище), переключается в шапке.
*/
document.documentElement.dataset.app = 'admin';
document.documentElement.dataset.theme = readTheme();
installInputModality();
installDevicePixel();
createRoot(document.getElementById('root')!).render(<AdminApp />);
