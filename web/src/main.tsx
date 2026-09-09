import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles.css';
import './accessibility.css';
import './room-layout.css';
import './desktop-home.css';
import App from './App';
import { unlockNotificationAudio } from './core/sounds';
unlockNotificationAudio();

createRoot(document.getElementById('root')!).render(<App />);
