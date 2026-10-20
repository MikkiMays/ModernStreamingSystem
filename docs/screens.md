# Экраны Cord: перечень, рецепты, Figma

Каждый экран и каждое состояние веб-клиента — с тем, как его открыть руками, где он в коде и где он в Figma. Снимок
«как есть» на 20.10.2026 (E15-A, T57, T29), `main` на `020eb66`, стенд https://cord.nikg.tech.

- **Figma:** https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA — страницы «Как есть», «Флоу», «Движение». У каждого
  состояния на странице «Как есть» шесть кадров: 360 / 1024 / 1440 px, светлая и тёмная тема (где ширина не применима —
  меньше). Ссылки в таблицах ведут на ряд состояния. Разделы: [обложка](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=6-2),
  [вход и главная](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-2),
  [прихожая](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=18-2),
  [встреча](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=19-2),
  [настройки](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=21-2),
  [кинозал](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=22-2),
  [игры](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=25-2),
  [диалоги и прочее](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=22-71),
  [флоу](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=3-4),
  [движение](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=3-5).
- **Счёт:** 69 состояний, 386 кадров, 13 флоу, 123 строки движения.
- **Снять заново:** из `web/` — `node --experimental-transform-types scripts/figma-screens.mjs [--only id,id]`
  (флаг нужен для записанных ответов кинозала из `e2e/support/cinema.ts`). PNG и `manifest.json` — в
  `backlog/screens/figma/` (вне git). Встреча на четверых — один сценарий `--only meeting [--steps id,id]`.
  `--tree` (с `--tree-only` — без PNG) пишет рядом `<id>-<ширина>-<тема>.json`: дерево видимых элементов с рамками,
  вычисленными стилями, текстами и SVG значков — из него E15-B строит настоящие слои. Сейчас выгружено для 360 и 1440,
  тёмная тема.
- **В Figma:** `scripts/figma-build.mjs --group '<раздел>'` печатает код для `use_figma`, который строит ряды;
  `scripts/figma-upload.mjs` кладёт PNG в кадры по ответу `upload_assets`; `scripts/figma-flows.mjs` и
  `scripts/figma-motion.mjs` — флоу и таблицы движения.
- **Подставное:** камера участников — синтетический силуэт (`scripts/fake-camera.mjs`), показ экрана — холст «План на
  неделю», кинозал — записанные ответы службы и 12-секундный тестовый поток, десять комнат в избранном и «соседняя
  вкладка» — ответы `page.route` / BroadcastChannel. Интерфейс при этом настоящий.

Исходники — от `web/src/`.

## Вход и главная

| Состояние | id | Как открыть | Исходники | Figma |
| --- | --- | --- | --- | --- |
| Загрузка (статичная, до бандла) | `loader` | Открыть Cord на медленной сети; для снимка бандл не отдаётся | `web/index.html` (`#cord-boot`), `ui/loader/boot.ts`, `ui/loader/BootGate.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-5) |
| Полноэкранная загрузка «Открываем Cord» | `loader-start` | `/kit` → «Показать старт» (в приложении старт рисует `index.html`) | `ui/loader/FullscreenLoader.tsx`, `ui/loader/scenes.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=24-2) |
| Загрузка игры «Раздаём карты» | `loader-cards` | `/kit` → «Показать карты» | `ui/loader/FullscreenLoader.tsx`, `ui/loader/scenes.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=24-24) |
| Загрузка — «Сеть медленная», «Повторить» | `loader-slow` | `/kit` → «Показать старт», ждать 1,5 с (в продукте — 12 с) | `ui/loader/FullscreenLoader.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=24-46) |
| Подключение — ищем сервер | `connect-searching` | Сервер не ответил на `/api/v1/capabilities` | `ui/Connect.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-27) |
| Подключение — без автоподключения | `connect-manual` | Выключить «Подключаться автоматически при запуске» и открыть Cord заново | `ui/Connect.tsx`, `core/servers.ts` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-49) |
| Подключение — нужен пароль | `connect-password` | Сервер с паролем (`capabilities.passwordRequired`) | `ui/Connect.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-71) |
| Подключение — пароль не подошёл | `connect-wrong-password` | Ввести неверный пароль → «Подключиться» | `ui/Connect.tsx`, `core/session.ts` (`describeFailure`) | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-93) |
| Подключение — сервер не отвечает | `connect-failed` | Сервер отвечает 5xx; раскрыть «Не подключено» | `ui/Connect.tsx`, `core/session.ts` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-115) |
| Главная, избранное пустое | `home` | Первый вход в браузере | `ui/home/HomeShell.tsx`, `ui/HomeEntry.tsx`, `ui/home/FavoritesNav.tsx`, `ui/InstallHint.tsx` (телефон) | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-137) |
| Главная, избранное 10 из 10 | `home-favorites` | Сохранить 10 комнат звездой в шапке встречи; закрепить, разложить по группам | `ui/home/FavoritesNav.tsx`, `ui/home/RoomRow.tsx`, `ui/useFavoriteShelf.ts` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-159) |
| Главная — меню под бургером | `home-drawer` | Уже 960 px: «Открыть меню» | `ui/home/HomeShell.tsx`, `ui/home/home.css` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-175) |
| Главная — меню комнаты | `home-room-menu` | ПКМ по комнате в избранном (или «…», долгое касание) | `ui/home/RoomRow.tsx`, `ui/kit/Menu.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-185) |
| Главная — встреча в соседней вкладке (T52) | `home-active-elsewhere` | Встреча открыта в другой вкладке этого браузера, открыть главную | `ui/home/ActiveMeetingNotice.tsx`, `core/active-meeting.ts` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-201) |
| Главная — избранное не загрузилось | `home-favorites-error` | Сервер отвечает ошибкой на `/favorites` | `ui/home/FavoritesNav.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-223) |
| Ссылка на встречу без входа | `room-not-found` | Открыть `/room/<id>` в вкладке, где этого входа нет | `App.tsx` (`recent`, `.global-error`) | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-239) |
| Скачать Cord | `download` | `/download` или «Скачать Cord» в панели | `ui/Download.tsx`, `core/download.ts` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-261) |
| Скачать Cord — сборка недоступна | `download-unavailable` | Манифеста `downloads/windows/download.json` нет | `ui/Download.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-283) |
| Главная в клиенте Windows | `desktop-home` | Открыть Cord в клиенте (WebView2); боковую панель рисует клиент | `ui/DesktopHome.tsx`, `desktop-home.css` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=17-305) |

## Прихожая

| Состояние | id | Как открыть | Исходники | Figma |
| --- | --- | --- | --- | --- |
| Новая встреча | `prejoin-create` | Главная → «Новая встреча» | `ui/Prejoin.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=18-5) |
| Вход по коду или ссылке | `prejoin-join` | Ввести 9 цифр на главной или открыть `/join/<код>` | `ui/Prejoin.tsx`, `core/invitation.ts` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=18-27) |
| «Перед разговором» (устройства) | `prejoin-settings` | В прихожей «Включить камеру» → «Настройки предпросмотра» | `ui/Prejoin.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=18-49) |
| Устройства запрещены | `prejoin-denied` | Запретить камеру и микрофон в браузере → «Включить камеру» | `ui/Prejoin.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=18-71) |
| Ожидание допуска | `meeting-waiting` | Встреча «Только с вашего подтверждения» → гость входит по коду | `ui/MeetingView.tsx`, `ui/MeetingHeader.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=18-93) |

## Встреча

| Состояние | id | Как открыть | Исходники | Figma |
| --- | --- | --- | --- | --- |
| Один участник | `meeting-solo` | «Начать встречу» | `ui/MeetingView.tsx`, `ui/Stage.tsx`, `ui/CallDock.tsx`, `ui/MeetingHeader.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=19-5) |
| Сетка, четверо | `meeting-grid` | Пригласить троих | `ui/Stage.tsx`, `ui/grid.ts`, `ui/stage.css` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=19-27) |
| Раскладка «Говорящий» | `meeting-speaker` | «Расположение участников» → «Говорящий» (телефон — в «ещё») | `ui/LayoutMenu.tsx`, `ui/Stage.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=24-68) |
| Панель «Чат и файлы» | `meeting-chat` | «Чат» в пульте (телефон — «ещё» → «Чат и файлы») | `ui/Sidebar.tsx`, `ui/chat.ts`, `ui/meeting-panel.css` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=19-49) |
| Панель «Участники» | `meeting-people` | «Участники» | `ui/Sidebar.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=19-71) |
| Меню участника | `meeting-participant-menu` | ПКМ по плитке; телефон — «Участники» → «Действия: <имя>» | `ui/ParticipantMenu.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=19-93) |
| Панель «Интеграции» | `meeting-integrations` | «Интеграции» | `ui/Services.tsx`, `ui/ServiceRoster.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=19-115) |
| Меню «Настройки и действия» | `meeting-more` | «…» в центре пульта | `ui/CallDock.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=19-137) |
| «Настройки встречи» (создатель) | `meeting-room-settings` | «ещё» → «Настройки встречи» или карандаш у названия | `ui/MeetingSettings.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=19-159) |
| Демонстрация: «Смотреть стрим» на плитке | `meeting-screen-tile` | Участник жмёт «Показать экран» | `ui/Stage.tsx`, `media/session.ts` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=19-175) |
| Демонстрация: экран на сцене | `meeting-screen` | Зритель жмёт «Смотреть стрим» | `ui/Stage.tsx`, `ui/stage.css` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=19-197) |
| Обрыв управления | `meeting-control-lost` | Пропал канал событий (`/api/v1/events`) | `ui/MeetingView.tsx`, `core/meeting.ts` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=19-219) |
| Обрыв медиа, обратный отсчёт | `meeting-recovering` | Пропал медиа-канал (`/rtc`) | `ui/MeetingView.tsx`, `ui/MeetingHeader.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=19-241) |
| Встреча завершена | `meeting-ended` | Создатель: «ещё» → «Завершить для всех» | `ui/MeetingView.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=19-263) |

## Настройки

| Состояние | id | Как открыть | Исходники | Figma |
| --- | --- | --- | --- | --- |
| Список разделов (телефон) | `settings-list` | Телефон: меню → «Настройки» | `ui/settings/SettingsWindow.tsx`, `ui/settings/sections.ts` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=21-5) |
| Профиль | `settings-01` | «Настройки» → «Профиль» | `ui/settings/*` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=21-15) |
| Оформление | `settings-02` | → «Оформление» | `ui/settings/*` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=21-37) |
| Горячие клавиши | `settings-03` | → «Горячие клавиши» | `ui/settings/*` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=21-59) |
| Голос и видео (по умолчанию), начало и конец | `settings-04`, `settings-04b` | → «Голос и видео»; второй кадр — прокручено вниз | `ui/settings/*`, `ui/DeviceCheck.tsx` | [начало](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=21-81), [конец](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=21-103) |
| Звуки, начало и конец | `settings-05`, `settings-05b` | → «Звуки» | `ui/settings/*` | [начало](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=21-125), [конец](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=21-147) |
| Аккаунты | `settings-06` | → «Аккаунты» | `ui/settings/*`, `ui/YandexIntegration.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=21-163) |
| Сервер | `settings-07` | → «Сервер» | `ui/settings/*` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=21-185) |
| О программе | `settings-08` | → «О программе» или «О программе» внизу главной | `ui/settings/*` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=21-207) |
| Поиск по настройкам | `settings-search` | «Найти настройку» → «звук» | `ui/settings/sections.ts` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=21-229) |
| Настройки поверх встречи | `meeting-settings` | Встреча: «ещё» → «Настройки» | `ui/settings/SettingsWindow.tsx`, `ui/CallDock.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=21-251) |

## Кинозал

| Состояние | id | Как открыть | Исходники | Figma |
| --- | --- | --- | --- | --- |
| Каталог площадки, поиск | `cinema-catalog` | «Интеграции» → «Кинозал» → YouTube → поиск | `ui/cinema/CinemaGroup.tsx`, `ui/cinema/catalog/*` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=22-5) |
| Карточка ролика | `cinema-detail` | «Подробнее: <название>» | `ui/cinema/catalog/*` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=22-27) |
| Плеер «Смотреть вместе» | `cinema-player` | «Смотреть вместе» — плеер открывается у всех | `ui/cinema/theater/*`, `ui/cinema/theater.css` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=22-49) |

## Игры

| Состояние | id | Как открыть | Исходники | Figma |
| --- | --- | --- | --- | --- |
| Группа «Игры» | `games-panel` | «Интеграции» → «Игры» | `ui/GamesGroup.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=25-5) |
| Покер, раздача | `game-poker` | «Покер» → «Открыть стол» → все «Сесть за стол» → «Раздать» | `ui/PokerTable.tsx`, `poker.css` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=25-27) |
| Дурак, раздача | `game-durak` | «Дурак» → «Открыть стол» → «Сесть за стол» → «Раздать» | `ui/DurakTable.tsx`, `ui/DurakMotion.tsx`, `durak.css` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=25-49) |
| Шахматы, партия | `game-chess` | «Шахматы» → «Открыть доску» → «Играть белыми»/«чёрными» → «Начать партию» | `ui/ChessTable.tsx`, `chess.css` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=25-71) |
| Gartic, первый ход | `game-gartic` | «Gartic» → «Угадай рисунок» → «Открыть Gartic» → «Присоединиться» → «Начать игру» | `ui/GarticTable.tsx`, `ui/GarticCanvas.tsx`, `gartic.css` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=25-93) |
| «История игр» | `games-history` | Группа «Игры» → «История игр» | `ui/GamesGroup.tsx`, `ui/PokerResult.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=25-115) |

## Диалоги и прочее

| Состояние | id | Как открыть | Исходники | Figma |
| --- | --- | --- | --- | --- |
| 409 «Вы уже во встрече» (T52) | `dialog-409` | Быть во встрече в одном окне и войти во вторую из другого с тем же профилем | `ui/MeetingElsewhere.tsx`, `core/identity.ts` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=22-74) |
| Избранное заполнено — звезда на пределе | `dialog-favorites-full` | 10 комнат в избранном → звезда в шапке новой встречи `aria-disabled`; подсказка «В избранном уже 10 комнат…» — системная (`title`), на снимке не видна | `ui/MeetingHeader.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=22-96) |
| Избранное заполнено — отказ ядра | `dialog-favorites-refused` | Список устарел (9 из 10), звезда → ядро отвечает `409 FAVORITES_FULL`, текст у шапки | `ui/MeetingHeader.tsx`, `server/…/room/FavoriteService.java` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=22-118) |
| «Убрать из избранного?» | `home-remove-confirm` | Меню комнаты → «Убрать из избранного» | `ui/home/FavoritesNav.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=22-140) |
| «Пригласить во встречу» | `meeting-invite` | Код в шапке или «Пригласить участников» | `ui/Invite.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=22-162) |
| «Диагностика» | `meeting-diagnostics` | «ещё» → «Диагностика» | `ui/Diagnostics.tsx`, `ui/DeviceCheck.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=22-184) |
| «Что будет в кружке» | `avatar-cropper` | «Настройки» → «Профиль» → выбрать картинку | `ui/AvatarCropper.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=22-206) |
| Настройки избранной комнаты (клиент Windows) | `desktop-favorite-settings` | Клиент: настройки комнаты в его панели | `ui/FavoriteSettings.tsx` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=22-228) |
| Витрина набора `/kit` | `kit` | `/kit` | `ui/kit/Showcase.tsx`, `ui/kit/*` | [ряд](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=22-244) |

## Вне браузера

| Экран | Где | Figma |
| --- | --- | --- |
| Заставка обновления клиента Windows: проверка, загрузка, установка, сбой (T58, В-1) | `ModernStreamingSystem.Windows/src/Cord.Windows/SplashWindow.xaml`, `Cord.Core/ForcedUpdate.cs` | [компонент «Заставка обновления»](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=5-52) |
| Установщик Windows | `ModernStreamingSystem.Windows/installer/` — снимков нет (E01) | — |

## Чего здесь нет и почему

- **Музыка** (плеер, очередь, загрузка трека): комната с музыкальным ботом на стенде не закрывается сама (скилл
  `verify`) — снимки отложены до E15-B.
- **Выбор сервера (T05)** и **Telegram Mini App (T04)** — экранов ещё нет: каталог серверов живёт в клиенте, Mini App
  за флагом `TELEGRAM_WEBAPP_ENABLED`.
- **Игровые листы и окна** (настройки стола, счёт, итог партии, превращение пешки, реакции) и итог покерного турнира —
  перечислены в коде (`ui/PokerTable.tsx`, `ui/DurakTable.tsx`, `ui/ChessTable.tsx`), в E15-B снимаются по одному.
