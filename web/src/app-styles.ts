/*
  Каскад приложения — один на оба HTML-входа: `index.html` (`main.tsx`) и Mini App Telegram (`tg.html`,
  `telegram/main.tsx`). Порядок — это поведение: правила ниже переопределяют верхние равным весом.
*/
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
