# Карта веб-клиента (web/) — E00, 19.10.2026

Корень ссылок — `web/`. `src` — 57 тыс. строк с тестами и CSS.

## Важное сразу

- **`web/.local/` нет** (в .gitignore): `stack.sh`, `poker-shots.mjs`, `durak-six.mjs`, `recorded/` — потеряны
  вместе со старым сервером. Скрипты, на которые ссылаются эпики, надо создать заново (E00 кладёт
  `shots.mjs` уже в git, `web/scripts/`).
- **На главной в браузере левой колонки нет вовсе** (избранное — в модалке), т. е. T46 «панель слева»
  в вебе — новая колонка. Правая панель встречи — `useState(360)` (`src/ui/MeetingView.tsx:141`),
  ширина **не сохраняется**, общего хука нет.
- Курсор в кинозале уже прячется (`src/ui/cinema/theater.css:108-111`); **клавиш в плеере нет** (T20).
- Сервер шлёт `capabilities.resolutions/frameRates/fileMaxBytes` — веб их **не читает**.

## Вход и маршруты

`index.html` (lang=ru, без цвета фона до JS — белая вспышка), `src/main.tsx` (порядок CSS 2-12, SW только
в проде и не в WebView2). Роутера нет: `/download` — `App.tsx:324-325`, остальное — `Workspace` с
`page: 'home'|'prejoin'|'room'` (`App.tsx:36`), `/room/<uuid>` (224-227), нет сессии → `Connect`.
Настройки — не маршрут, состояние `section` (`App.tsx:42`), мост `settings.open` (156-158). **`/support`
нет.** Тема — `cord:theme` + `<html data-theme>`, код продублирован (`App.tsx:45-49` и 316-320).
PWA: `public/manifest.webmanifest` (ярлык «Скачать для Windows»), `public/sw.js`, иконки PNG, `favicon.svg`
(три вертикальные полосы на синем).

## Стили

CSS 13 345 строк: styles 3560, poker 2599, gartic 1754, durak 1201, cinema 1017, room-layout 893, chess 691,
theater 518, game-polish 417, home-entry 254, room-polish 161, accessibility 122, game-people 80.
**Аудит (для E16): 387 разных hex-цветов, 38 радиусов, 40 теней, 71 размер шрифта, 26 z-index,
25 `!important`, 70 `@media`.** Токены `styles.css:5-63` (`--bg --surface --surface-2 --text --muted
--line --blue --blue-hover --blue-soft --shadow --radius --speaking`), `accessibility.css:1-14`
переопределяет `--muted`, `--blue`. Шкал радиусов/теней/z-index нет. Tailwind 4 подключён, утилиты почти
не используются.
`ui/primitives.tsx`: AppIcon 20, DownloadLink 37, ThemeButton 63, useStore 81, useMediaQuery 91,
IconButton 104, Slider 127, Modal 153, Avatar 194, **Logo 217 — CSS-полосы + текст `cord` + точка**.
Нет Button, Switch, Tabs, Toast, Badge, Card, Resizer. **SVG-марки нет нигде.**
Текстовая марка: `Home.tsx:76`, `Prejoin.tsx:182`, `MeetingView.tsx:188`, `Connect.tsx:85`,
`Download.tsx:42`, сукно покера `PokerTable.tsx:239-244` (`<em>cord</em>`), рубашка дурака без марки.

## Встреча

Шапка `MeetingView.tsx:186-245`: Logo, название (у ведущего — настройки), код, `connection-badge` 210-219
(«Завершено/В эфире/Ожидание входа/Подключаемся»), ThemeButton 220, звезда 221-240, приглашение.
Времени встречи нет. Счётчики людей без ботов: 470, 542, `Sidebar.tsx:88`, `Stage.tsx:203`;
**`MeetingView.tsx:318` считает всех**.
Пульт `MeetingView.tsx:362-561`: `.call-footer-info` 363-388; `.call-dock` 398-533 — [десктоп] звук,
микрофон, камера, `CameraMenu` 430, [десктоп] раскладка, «Показать экран», меню «Настройки и действия»
445-512, [десктоп] полный экран, сброс; `.panel-controls` 534-560 — Участники, Чат, Интеграции.
CSS `styles.css:1330-1420`, `room-layout.css:96-128,151-169,374-411,447-470`. Брейкпоинты
`ui/breakpoints.ts` (COMPACT 700, SHEET 767, DOCK 768, ROOMY 960, DRAWER 1199).
Камера `CameraMenu.tsx:95-97` (ChevronDown), касание: тап — переворот, удержание 450 мс — список;
`media/cameras.ts` (WIDE 41); зум уже есть `media/session.ts:1292,1307`.
Чат `Sidebar.tsx:391-442`: `textarea rows={2}`, `<small>до 100 МиБ</small>` 432, CSS `styles.css:1638-1670`.
Говорящий: `media/session.ts:421-425` (ActiveSpeakersChanged), CSS `styles.css:1104-1115`; `useMicLevel.ts`
(опрос 100 мс) — только в настройках.
Правая панель: separator `MeetingView.tsx:565-589`, CSS `styles.css:1434-1447` (`col-resize`, полоса
только при наведении).

## Главная, настройки

`Home.tsx:25-60` (DesktopHome в WebView2, иначе BrowserHome 61-194: шапка, `HomeEntry`, подвал «Без
аккаунта. На вашем сервере.», модалка избранного). `core/favorites.ts` (профиль `cord:profile:v1`, кэш,
автоподключение), `favorite-reorder.tsx`.
Настройки `Settings.tsx`: модалка 940 px «Настроить под себя», вкладки сверху: audio 774, video 792,
profile 819 (тема `AppearanceFields` 637-656), accounts 844, connection 847, hotkeys 854 (оговорка
браузер/клиент 622-625), about 857. **Ползунок: своего `:focus` нет — глобальное
`:focus-visible { outline: 3px }` `styles.css:97-105`** (T31). Глобальное поле
`input:not([type=checkbox],[type=radio])` — `styles.css:112-123`.

## Медиа

`media/profiles.ts` (720/1080/1440, `automatic`, **`companionCamera` 640×360@30 0,6 Мбит/с 285-305**),
`auto-quality.ts` (лестница с 1440), `upstream.ts`, `retune.ts`, `capture.ts`, `session.ts` (1687 строк:
share 1325, publishScreen 1341, setProfile 1458, applyProfile 1514). «Авто»/1440 в выборе —
`Settings.tsx:150-219` (и в `Prejoin.tsx:450-459`). Умолчания `core/preferences.ts:110-111` (1080/30 auto),
валидатор `profile()` 115-121 — место миграции старых значений.

## Звуки и громкость

`core/meeting.ts` `listen()` 142-158: **бот не пропускается** (звуки входа/выхода музыки), rejoin с новым id
даёт «выход»+«вход» (T38). Громкость — `Stage.tsx` `AudioTrack` 101-116: сначала `play()`, потом
`setVolume`; по умолчанию `?? 1` (137). **Вероятная причина T49:** дорожка бота подписывается раньше, чем
снимок с ботом дошёл до `rememberPeople`, и до этого громкость 1.

## Интеграции

`ui/Services.tsx`: GROUPS (кинозал, музыка, игры) 49-80, TELEGRAM `ready:false` 89-96 (внизу, «Скоро»),
`canUse` 112, RIVALS 140-145, **«Убрать сервис из встречи» только ведущему 388-398** (T14 в вебе).
Кинозал: `WatchTheater.tsx` IDLE_MS 2800, `Chrome.tsx` SKIP_MS 15000; «По ссылке» —
`LinkScene.tsx:80,244-263` без удаления. Игры: загрузки-заглушки `Stage.tsx:386-391,404,424` (T55).

## Ссылки на GitHub (видимые)

`AboutFields.tsx` (Github-иконка, «Сервер отстаёт… ./update.sh» 100-108, «Исходный код» 155-157, «Все
выпуски» 160), `core/upstream-version.ts`, `core/download.ts` (36-45, 98, 110, 132), `Download.tsx` (104,
«спросит адрес сервера» 115, «Установщик собирает GitHub Actions…» 169), `Home.tsx:100`, `Settings.tsx:476-479`.

## Тесты

Vitest — 88 файлов рядом с кодом. Playwright — 27 спеков в `e2e/` (1 воркер, 45 с, fake media).
**«В эфире» ждут 13 спеков напрямую + помощник `e2e/support/cinema.ts:459,475` (ещё 8 спеков) — 36
вхождений в 17 файлах**; `data-media-status` нет. Скилл проверки `web/.claude/skills/verify/SKILL.md`.

## Строки и i18n

i18n нет. ~1200 строковых литералов с кириллицей + ~240 текстовых узлов JSX в 149 файлах. Четыре
самодельных склонения (`core/poker.ts:105`, `core/durak.ts:140`, `core/cinema/format.ts:37`,
`core/upstream-version.ts:87`), `'ru-RU'` зашит в 4 местах.
