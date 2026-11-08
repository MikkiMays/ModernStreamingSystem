import { createRoot } from 'react-dom/client';
import '../app-styles';
import './admin.css';
import { installInputModality } from '../ui/input-modality';
import { installDevicePixel } from '../ui/device-pixel';
import { AdminApp } from './AdminApp';

/*
  Вход пульта флота (`admin.html`, R207). Слой переводов приложения не поднимается: пульт — только
  по-русски (Р-114), его тексты — `src/i18n/admin/ru.ts`. Тема — та же настройка, что у приложения
  (`cord:theme`), чтобы владелец видел пульт в своём оформлении.
*/
document.documentElement.dataset.theme = localStorage.getItem('cord:theme') || 'system';
installInputModality();
installDevicePixel();
createRoot(document.getElementById('root')!).render(<AdminApp />);
