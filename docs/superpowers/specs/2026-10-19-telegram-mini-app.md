# Telegram: привязка комнаты и Mini App на весь экран (E09): исследование и проект

Черновик от 19.10.2026, ещё не одобрен владельцем. Задачи: T04, T30, T55. Решения П5 и П14 в
`backlog/DECISIONS.md`. Код не менялся.

## 0. Выводы

1. **Bot API на сегодня — версия 10.3 (24.08.2026), скрипт `telegram-web-app.js?64`.** Всё нужное
   для полного экрана появилось в 8.0 (ноябрь 2024).
2. **Кнопка `web_app` в группах запрещена.** Это касается и inline-кнопки, и меню-кнопки: обе
   работают только в личке. В группе работает одно: обычная `url`-кнопка со ссылкой
   `https://t.me/<бот>?startapp=<id>` (главный Mini App) или `https://t.me/<бот>/<app>?startapp=<id>`
   (Mini App из `/newapp`). Mini App откроется прямо в этом чате и получит в `initData` поля
   `start_param`, `chat_type`, `chat_instance`.
3. **«Плашка посередине»** — это описание бота в пустом чате. Текст (до 512 символов) задаётся
   запросом `setMyDescription`. Картинку или видео к нему можно поставить **только у BotFather**
   («Edit Description Picture»). Заставку Mini App (иконку и цвета для светлой и тёмной темы) — тоже
   только там.
4. **Полный экран** включают два механизма, и нужны оба: `requestFullscreen()` (с 8.0) и параметр
   ссылки `mode=fullscreen`. Второй описан в спецификации ссылок, а не на странице Mini Apps. На
   Desktop и Web нужно ждать событие `fullscreenFailed: UNSUPPORTED` и работать в окне.
5. **Камера и микрофон внутри Telegram** по исходникам клиентов поддерживаются на iOS, Android,
   Desktop и в обоих веб-клиентах. Но разрешение спрашивается заново (на Android — при каждом
   запросе), а на iOS есть жалобы на чёрный кадр. **Демонстрации экрана в WebView телефонов
   нет**, а веб-клиенты не дают её в iframe. Главный риск эпика — его проверяем прототипом
   первым. Запасной путь — `openLink` в системный браузер.
6. **SDK: `@tma.js/sdk` (+ `@tma.js/sdk-react`)**, лицензия MIT, выпуск 14.07.2026. Причины.
   Официальный скрипт грузится с `telegram.org`, а это (а) запрещено нашим CSP
   (`script-src 'self'`) и (б) рискованно для пользователей в РФ, где Telegram с 10.02.2026
   замедляют. Наш бандл: ~51 КБ в минифицированном виде, ~16 КБ в gzip (замерено).
7. **Без правки заголовков Mini App не откроется в Telegram Web.** Сейчас `infra/Caddyfile` шлёт
   `X-Frame-Options DENY` и `frame-ancestors 'none'`, а Web A и Web K встраивают Mini App в
   iframe. Для `/tg` нужно `frame-ancestors https://web.telegram.org`.

## 1. Что уже есть

- `services/cord_services/telegram.py`: long polling (`allowed_updates: message, channel_post`),
  20 команд, `setChatMenuButton {type: commands}`. `/bind <токен 24 симв.>` привязывает
  **без подтверждения в комнате**, и `ownerId` в этом случае — тот, кто написал `/bind`. Кроме того:
  `/unbind` (только админ чата), `/meet` с invite-ссылкой, вход организатора через
  `?start=host_<token>`, а оформление бота задаётся в `describe()` (description, short description,
  default admin rights без `can_pin_messages`).
- `app.py:255` `POST …/telegram/link`: принимает `owner=True`, заводит `room-profile:<id>` (избранное с
  удостоверением создателя) и одноразовый claim `kind=bind` на 15 минут.
- Хранилище: таблицы `bindings(scope = chat:thread)` и `claims`. Mini App, `web_app`, `initData`,
  `startapp` и флага `TELEGRAM_WEBAPP_ENABLED` нет (`journal/E00/map-services.md`).
- Витрина: карточка Telegram уже отдельно внизу и помечена «Скоро» (`web/src/ui/Services.tsx:82-95`).
  Значит, T30 по расположению выполнена, остаётся только флаг.
- Веб: React 19.2, Vite 8.2, livekit-client 2.22. Тёмный фон — `--bg: #16181f`.

## 2. Превью бота: что делается запросом, а что — только в BotFather

| Что видит человек | Bot API (из кода, `describe()`) | Только BotFather |
|---|---|---|
| Текст в пустом чате «Что умеет этот бот?» | `setMyDescription`: 0–512 симв., `language_code` | — |
| Картинка или видео над этим текстом | — | «Edit Description Picture» (фото или видео) |
| Короткое «О боте» в профиле и при пересылке | `setMyShortDescription`: 0–120 симв. | `/setabouttext` (то же самое) |
| Имя | `setMyName` (лимит частоты — см. `describe()`) | `/setname` |
| Аватар | `setMyProfilePhoto` (с 9.4) | `/setuserpic`, видео в профиле |
| Кнопка «Открыть» в профиле, скриншоты и видео превью | — | Main Mini App → Previews |
| Заставка Mini App до `ready()` | — | Bot Settings → Configure Mini App → Configure Splash Screen |

Предлагаемый текст (`ru` и по умолчанию): «Cord — видеовстречи прямо из чата. Создатель встречи
привязывает её к беседе, и в чате появляется кнопка „Открыть встречу“: Cord открывается на весь
экран, без регистрации». Картинка: кадр загрузки из E16 (сцена и марка Cord) на тёмном фоне.
Размеры в документации не указаны, ориентируемся на подсказку BotFather.

## 3. Как открыть Mini App из группы

| Способ | Работает в группе? | Источник |
|---|---|---|
| `InlineKeyboardButton.web_app` | **Нет**: «Available only in private chats between a user and the bot» | Bot API → InlineKeyboardButton |
| `KeyboardButton.web_app` | **Нет**: «Available in private chats only» | Bot API → KeyboardButton |
| `setChatMenuButton` + `MenuButtonWebApp` | **Нет**: меняет кнопку «в личном чате или по умолчанию» | Bot API → setChatMenuButton, MenuButton |
| Меню вложений (`startattach`) | Только крупным рекламодателям | webapps → Attachment Menu |
| **`url`-кнопка со ссылкой на главный Mini App** `t.me/<бот>?startapp=<p>` | **Да**: открывается «in the current chat» | webapps → Launching the main Mini App |
| **`url`-кнопка с Direct Link** `t.me/<бот>/<short_name>?startapp=<p>` | **Да** | webapps → Direct Link Mini Apps |

Подробности по ссылочным способам:
- **Параметр `startapp`.** Если он непустой, клиент передаёт его в `initData.start_param` и в
  GET-параметре `tgWebAppStartParam`. Значит, нужный экран можно выбрать до всякой сети.
  В таблице `WebAppInitData` поле `start_param` описано как «startattach … attachment menu» — это
  устаревшая формулировка, разделы про Direct Link и главный Mini App прямо говорят о `startapp`.
- **Допустимые символы `startapp`** в первоисточниках не перечислены. Документация tma.js даёт
  `A-Z a-z 0-9 _ -`, длину до 512 (`/^[\w-]{0,512}$/`). Для `/start` и `startgroup` первоисточник
  говорит «up to 64 base64url characters». Наш id привязки — `b` + 22 символа base64url (16 случайных
  байт), он укладывается в оба ограничения.
- **Контекст чата.** В этом режиме Mini App получает `chat_type` (`sender`, `private`, `group`,
  `supergroup`, `channel`) и `chat_instance`. **Числового `chat.id` нет**: `chat` приходит только
  из меню вложений и при заявках на вступление.
- **Высота окна.** С 7.6 Direct Link и главный Mini App сразу открываются на полную высоту.
  `mode=compact` открывает их на половину экрана, а `mode=fullscreen` клиент обязан открыть с
  флагом `fullscreen` (`api/links`; флаг есть в `messages.requestAppWebView` и
  `requestMainWebView`).
- **Подтверждение.** Спецификация клиентов требует спрашивать подтверждение, когда ссылку
  открывают «из мест, где полная ссылка не видна (… inline buttons)». Значит, после нажатия на
  кнопку в закрепе возможно окно «Открыть приложение?» — живой прогон покажет, на каких клиентах
  оно появляется.
- **Защита по источнику (Bot API 10.2).** С 20.07.2026 методы Mini App запрещены со страниц
  другого источника, чем домен Mini App. Mini App Cord должен оставаться одним документом на домене
  Cord и не уходить на `/join/...` полной навигацией. Отключать защиту в BotFather не нужно.

**Выбор: главный Mini App** — `https://t.me/<бот>?startapp=<id>&mode=fullscreen`. Он
настраивается в BotFather один раз, вместе с заставкой, и даёт кнопку «Открыть» в профиле.
Вариант с `/newapp` поддерживаем той же кодовой веткой через `TELEGRAM_WEBAPP_SHORT_NAME`
(пусто — главный).

## 4. Полный экран, безопасные зоны, цвета (T55)

| Метод или поле | С версии | Что делает Cord |
|---|---|---|
| `ready()` | 6.0 | Вызываем сразу после первого кадра своей загрузки. До этого вызова Telegram держит свою заставку, а без вызова — до полной загрузки страницы |
| `expand()`, `isExpanded` | 6.0 | Вызываем на старте: на случай `compact` и старых клиентов |
| `setHeaderColor`, `setBackgroundColor` | 6.1; произвольный цвет шапки — с 6.9 | Цвет фона Cord до первого кадра. Документация просит задавать шапку и в полноэкранном режиме: по ней выбирается контраст статус-бара |
| `enableClosingConfirmation()` | 6.2 | Во время звонка: «Выйти из встречи?» вместо мгновенного закрытия |
| `openLink(url)` | 6.0 (опции с 6.4) | Запасной путь в браузер. **Только в ответ на действие пользователя** |
| `disableVerticalSwipes()` | 7.7 | Свайп по видео не сворачивает приложение (за шапку свернуть по-прежнему можно) |
| `setBottomBarColor` | 7.10 | Цвет нижней панели. На Android он же красит навигационную панель |
| `requestFullscreen()`, `exitFullscreen()`, `isFullscreen` | 8.0 | На `ios` и `android`, если ещё не включён полный экран |
| `fullscreenChanged`; `fullscreenFailed` (`UNSUPPORTED`, `ALREADY_FULLSCREEN`) | 8.0 | При `UNSUPPORTED` работаем в окне и не показываем ошибку |
| `safeAreaInset` и `contentSafeAreaInset` + события `*Changed` | 8.0 | Переводим в свои CSS-переменные (см. ниже) |
| CSS `--tg-safe-area-inset-*`, `--tg-content-safe-area-inset-*` | 8.0 | Ставит официальный скрипт. Аналоги в tma.js `bindCssVars()` называются `--tg-viewport-safe-area-inset-*` (другие имена!) |
| `lockOrientation()` / `unlockOrientation()` | 8.0 | **Не запираем**: во встрече поворот полезен (экран собеседника, плитки) |
| `isActive`, `activated` / `deactivated` | 8.0 | При сворачивании показываем «камера на паузе», если ОС отберёт камеру (проверить) |
| `hideKeyboard()` | 9.1 | Чат встречи: закрыть клавиатуру после отправки |

**Порядок старта без белой вспышки:**
1. В BotFather задаём заставку: иконка Cord и цвет фона `#16181f` (или тёмный токен из E16) для
   **обеих** тем.
2. Отдельный документ `web/tg.html`. В нём `<meta name="color-scheme" content="dark">`, встроенный
   критический CSS (`html,body{background:#16181f}`) и статическая разметка загрузки из E16 (П14).
   Первый кадр рисуется до JS и совпадает с заставкой.
3. Модуль с нашего домена: `init()` → цвета шапки, фона и нижней панели → `disableVerticalSwipes`
   → `expand` → `requestFullscreen` (по условию) → `ready()`. Параллельно — `POST /enter`, проверка
   камеры и подгрузка кода встречи.
4. Загрузку убираем, когда комната подключилась. Не дольше нужного (П14).

**Вёрстка.** Фон и видео — во весь экран, как у Cardbox. Шапку встречи сдвигаем на
`safe.top + contentSafe.top`: в полноэкранном режиме это плавающие «✕» и «⋯» Telegram. Пульт
ставим над `safe.bottom`. Переменные `--cord-inset-{top,bottom,left,right}` =
`max(env(safe-area-inset-*), telegram-значение)`. Высоту берём из `viewportStableHeight`, а не из
`100vh` и не из `viewportHeight`: документация предупреждает, что последняя обновляется
рывками.

## 5. Проверка `initData`

Строка `Telegram.WebApp.initData` (у tma.js — `retrieveRawInitData()`) уходит на сервер как есть.
`initDataUnsafe` недоверенная, доверять ей нельзя.

**HMAC (наш случай, токен бота у нас есть):**
1. Разобрать query-строку. Значения декодируются из URL; повтор ключа — ошибка.
2. Вынуть `hash`. **`signature` остаётся в строке** — исключается только `hash`.
3. `data_check_string` = пары `key=value`, отсортированные по ключу и склеенные через `\n`.
4. `secret_key = HMAC_SHA256(key=b"WebAppData", msg=bot_token)` — сырые байты, не hex.
5. Сравнить `hex(HMAC_SHA256(key=secret_key, msg=data_check_string))` с `hash` за постоянное время.
6. Проверить `auth_date`. Документация оставляет это на нас («you can additionally check»). Наше
   правило: не старше `TELEGRAM_INITDATA_MAX_AGE` (по умолчанию 3600 с) и не из будущего больше чем
   на 60 с. Строка нужна только в момент входа: дальше встреча живёт на собственном удостоверении
   Cord. Перезагрузка WebView сохраняет ту же `initData` (скрипт держит её в `sessionStorage`).

```python
def verify_init_data(raw: str, token: str, now: float, max_age: int = 3600) -> dict:
    pairs = parse_qsl(raw, keep_blank_values=True, strict_parsing=True)
    data = dict(pairs)
    if len(data) != len(pairs) or "hash" not in data:
        raise InitDataError("malformed")
    received = data.pop("hash")
    check = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(hmac.new(secret, check.encode(), hashlib.sha256).hexdigest(), received):
        raise InitDataError("signature")
    age = now - int(data["auth_date"])
    if age > max_age or age < -60:
        raise InitDataError("stale")
    data["user"] = json.loads(data.get("user", "null"))
    return data
```

**Ed25519 (для третьих сторон, с 8.0)** — нам не обязателен, оставляем справочно. Строка
собирается так: `"<bot_id>:WebAppData\n"`, затем пары без `hash` **и** без `signature`.
`signature` — подпись в base64url, Telegram присылает её без `=`, их нужно дописать. Публичный ключ
production — `e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d`, тестовой среды —
`40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec`. В Python проверка делается через `cryptography` (уже есть в
`requirements.lock`), новых зависимостей не нужно.

Фрагмент прогнан на эталоне из docs.telegram-mini-apps.com/platform/init-data: токен `5768337691:…`,
`hash=c501b71e…` — проходит, а с `now + 4000 с` отвергается как устаревший. Тесты: эталонная строка с известным токеном; подмена любого поля; дубль ключа; просроченная и
«будущая» `auth_date`; `signature` внутри строки (проверка проходит только при её включении);
юникод и `+`, `/` в имени.

## 6. Камера и микрофон внутри Telegram

| Клиент | Что в коде клиента | Сообщения разработчиков | Вывод |
|---|---|---|---|
| **iOS** (WKWebView) | `requestMediaCapturePermissionFor` → `.prompt` (iOS 15+). `allowsInlineMediaPlayback = true`, автозапуск звука без жеста. getUserMedia в WKWebView есть с iOS 14.3 (WebKit #208667) | «Чёрный» поток видео (tma.js #748, 06.2025, закрыт без исправления). Микрофон спрашивается при каждом открытии (tma.js #390, 2024) | Должно работать, запрос разрешения каждый сеанс. Чёрный кадр проверить прототипом |
| **Android** (System WebView) | `onPermissionRequest`: свой диалог Telegram, затем системное разрешение `CAMERA`/`RECORD_AUDIO`, затем `grant` | Диалог повторяется при каждом запросе, в том числе при смене камеры (`facingMode`) и при новом открытии (issues #43 2024, #83 01.2026; PR DrKLO #1947 03.2026 открыт) | Работает. Запрашиваем аудио и видео **одним** `getUserMedia`, камеру переключаем без повторного запроса, где возможно |
| **Desktop** (tdesktop: WebView2 / WKWebView / WebKitGTK) | Windows: запросы не отклоняются → штатный запрос WebView2. Linux: запрос проброшен в диалог Telegram. macOS: обычный обработчик не переопределён (запрет есть только в «restricted»-режиме) | Камера запоминается (issue #43) | Должно работать. Проверить на Windows и macOS |
| **Web A / Web K** (iframe) | `allow="camera; microphone; …"` есть, `display-capture` **нет** | — | Камера и микрофон — по разрешению браузера для домена Cord, экран — нет |
| Демонстрация экрана | Android WebView: `getDisplayMedia` нет (MDN BCD). iOS: появилась в Safari 27, в WebView Telegram не включена. Web: нет `display-capture` | — | В Mini App кнопку «Экран» скрываем и даём «Открыть в браузере» |

**Запасной путь.** Перед входом пробуем `getUserMedia({audio:true, video:true})`. Если
`mediaDevices` нет, получили `NotAllowedError` или чёрный кадр (проверка по
`videoWidth`/яркости 1–2 кадров), показываем экран «Камера недоступна внутри Telegram» с
кнопками «Открыть в браузере» (`openLink(inviteUrl)` по нажатию) и «Войти только со звуком»
или «без камеры». На Desktop `openLink` открывает системный браузер.

**Прототип — первым делом.** Тестовый бот, страница `/tg-probe`: getUserMedia, плитка
LiveKit, смена камеры, сворачивание и разворачивание, `requestFullscreen`. Прогоняем на iOS 18+,
Android 13+, Telegram Desktop (Windows, macOS), Web A и Web K. По каждому — скриншоты и вердикт.

## 7. SDK и готовые решения (T55: «прошарить гиты»)

| | `telegram-web-app.js` (официальный) | **`@tma.js/sdk` + `sdk-react`** | `@telegram-apps/sdk(-react)` | `@twa-dev/sdk` | `react-telegram-web-app` |
|---|---|---|---|---|---|
| Где | `telegram.org/js/telegram-web-app.js?64` | GitHub Telegram-Mini-Apps/tma.js, ★1207, коммиты до 12.10.2026 | Старое имя того же проекта | twa-dev/SDK, ★332 | vkruglikov, ★614, **архив** |
| Последний выпуск | Всегда текущий: проверки версий до 9.6 | `sdk` 3.3.0 и `sdk-react` 3.0.23 — 14.07.2026 | 3.11.8 — 08.10.2025. `init-data-node` официально deprecated → `@tma.js` | 8.0.2 — 05.02.2025 (застрял на 8.0) | 2.1.9 — 12.2023 |
| Лицензия | Не указана | MIT | MIT | MIT (обёртка над официальным скриптом) | MIT |
| Размер | 120 КБ исходника, ~19 КБ gzip, отдельный блокирующий запрос в `<head>` | Наш набор (init, viewport, miniApp, swipe, closing, openLink): 51 КБ минифицированного, **16 КБ gzip**, внутри бандла | ≈ tma.js | ≈ официальный | — |
| Полный экран и безопасные зоны | Да | Да: `viewport.requestFullscreen.isSupported()`, `safeAreaInsets()`, `bindCssVars()` | Да | До 8.0 | Нет |
| Тема Telegram | `--tg-theme-*` | `themeParams.bindCssVars()` | Да | Да | Частично |
| Тесты без Telegram | Самодельная подмена `window.Telegram` | `mockTelegramEnv` (подмена моста) | Да | — | — |

**Рекомендация: `@tma.js/sdk` и `@tma.js/sdk-react`, точные версии**, за тонкой обёрткой
`web/src/telegram/sdk.ts` (наружу ~15 функций), чтобы при необходимости заменить SDK в одном
месте. Причины. (1) Наш CSP `script-src 'self'` не пускает скрипт с `telegram.org`, а
послаблять CSP ради чужого скрипта противоречит правилу из `Caddyfile`. (2) Скрипт с
`telegram.org` — лишний блокирующий запрос до первого кадра. В РФ, где Telegram замедляют с
10.02.2026, WebView ходит в сеть мимо MTProto-прокси Telegram, и запрос может не пройти. (3) MIT,
TypeScript, свежий выпуск, проверка `isSupported` у каждого метода, подмена окружения для
скриншотов. Цена: у проекта была смена имени пакетов (`@telegram-apps` → `@tma.js`), поэтому
версии фиксируем и обновляем осознанно. Официальный скрипт остаётся справочником поведения.

**Шаблоны.** `Telegram-Mini-Apps/reactjs-template` (★430, MIT, Vite 6, React 18,
`@tma.js/sdk-react` 3): эталон `init.ts` (mount и `bindCssVars`) и `mockEnv.ts`.
`twa-dev/Vite-Boilerplate` устарел. `nextjs-template` нам не подходит.

**Mini App с полноэкранной загрузкой.** Открытого аналога Cardbox (3D-карты и марка) не нашлось:
у популярных открытых игр (клоны Hamster Kombat, TonStory, `nmime/uno`) нет ни полного экрана, ни
своей заставки. Полезные образцы:
- `moonkattymky/moonkatty-game` PR #20 (07.10.2026): `ready` и `expand`, затем `requestFullscreen`
  (8.0+, только мобильные), `disableVerticalSwipes`, цвета шапки, фона и нижней панели, безопасные
  зоны в CSS-переменных; `100vh` заменено на стабильную высоту, `overscroll-behavior: none`, тест
  на 390×844 и 320×568 с подставным `Telegram.WebApp` 8.0 и 7.0;
- `apiton-org/telegram-game-fullscreen-template` — шаблон игры на tma.js с подставными безопасными
  зонами;
- встроенная заставка Telegram (BotFather → Splash Screen) — первая половина «загрузки без
  шва».

Анимацию сцены выбирает E16 (П14). Здесь фиксируем только контракт: статическая разметка
загрузки в `tg.html`, тот же компонент после запуска, `ready()` после первого кадра.

## 8. Проект для Cord

### 8.1 Флаг и витрина
- `TELEGRAM_WEBAPP_ENABLED` (по умолчанию `false`) в службах. В каталог добавляется поле
  `telegram.webapp = флаг && бот готов`, и витрина показывает «Скоро», пока поле `false` (T30).
  Пока флаг выключен, всё работает как сейчас: старый `/bind <токен>`, `/meet` и музыка не
  меняются.
- Связанные переменные: `TELEGRAM_WEBAPP_SHORT_NAME` (пусто — главный Mini App),
  `TELEGRAM_INITDATA_MAX_AGE=3600`. URL Mini App — `PUBLIC_URL + "/tg"`.

### 8.2 Привязка: код плюс подтверждение в комнате
1. Создатель встречи (`owner=True`) открывает «Интеграции → Telegram → Привязать» и получает:
   - **код из 6 символов** (алфавит `0-9A-Z` без `I L O U`; ввод без учёта регистра, `O→0`, `I/L→1`),
     живёт 10 минут, у комнаты одновременно один код;
   - кнопку и QR «Добавить бота в группу»: `https://t.me/<бот>?startgroup=<код>&admin=pin_messages+manage_chat`
     (`api/links`). Telegram сам предложит выбрать группу, добавит бота админом с правом закрепа
     и пришлёт в группу `/start <код>`;
   - строку для копирования: `/bind@<бот> <код>`.
2. Ещё два способа:
   - в личке с ботом: `/bind <код>`, затем reply-кнопка `KeyboardButtonRequestChat`
     (`chat_is_channel: false`, `bot_administrator_rights: {can_pin_messages}`, у пользователя —
     те же права и выше). Бот получает выбранный чат и права;
   - с телефона по **номеру комнаты**: `/bind 123-456-789` в группе. Запрос уходит создателю
     точно так же (T04).
3. Служба заводит **запрос**: чат, тема, название, число участников (`getChatMemberCount`), кто
   запросил. Он живёт 5 минут; на комнату один открытый запрос. Код при этом гасится.
4. **У создателя в комнате всплывает окно**: «Чат „Название" (группа, 34 участника) хочет
   привязаться к встрече. Запросил: Иван (@ivan). Разрешить / Отклонить». Состояние приходит тем же
   опросом служб, что и сейчас. Без «Разрешить» привязки нет. Если создателя нет в комнате, бот
   отвечает в чат «Попросите создателя открыть встречу — запрос ждёт 5 минут».
5. «Отклонить» или истечение срока → бот пишет в чат «Создатель отклонил привязку». Пара
   «чат + комната» получает паузу на 10 минут.
6. Ограничения частоты: не больше 5 неверных кодов от чата за 10 минут и не больше 3 запросов к
   комнате за 10 минут. Обход перебором бесполезен: создатель сам видит каждый запрос.

### 8.3 Закреп и кнопка
После «Разрешить» служба делает три шага:
- пишет привязку (§8.6);
- `sendMessage` в чат и тему с текстом «Встреча „…" привязана к этому чату» и кнопкой
  `[{text: "Открыть встречу", url: "https://t.me/<бот>?startapp=<id>&mode=fullscreen", style: "primary"}]`
  (`style` — с 9.4);
- `pinChatMessage` с `disable_notification: true`.

Закреп требует права `can_pin_messages`. Если права нет, сообщение остаётся без закрепа, в нём
подсказка, а в комнате — «Закрепить не удалось». В `setMyDefaultAdministratorRights` добавляем
`can_pin_messages: true`.

### 8.4 Вход через Mini App
1. Пользователь нажимает «Открыть встречу» и попадает на `tg.html`. Там загрузка, цвета, полный
   экран (§4).
2. `POST /api/v1/services/telegram/webapp/enter {initData}`, без заголовка авторизации.
3. Служба проверяет:
   - HMAC и `auth_date` (§5);
   - что `start_param` указывает на действующую привязку;
   - **членство**: `getChatMember(chat_id привязки, user.id)` → `creator`, `administrator`, `member`
     или `restricted` с `is_member`. Документация гарантирует метод только когда бот — админ,
     а он и так админ ради закрепа. Результат кэшируется на 5 минут;
   - `chat_type` и `chat_instance` только пишутся в журнал для диагностики, решение по ним не
     принимается.
4. Ответ: `{roomId, title, name, inviteUrl}`. `name` = `first_name last_name`, обрезается до 40
   символов, как `actor()`. Invite берётся из `POST /internal/services/{room}/invite` (вход без
   ожидания допуска).
5. Клиент проверяет камеру (§6) и входит по invite с этим именем, без поля «Ваше имя». Встреча
   рендерится **в том же документе** — так требует защита по источнику и не ломается iframe в Web.
6. Ошибки показываются экранами, а не алертами: «Привязка снята», «Вы не состоите в чате»,
   «Ссылка устарела — откройте заново из чата», «Встреча завершена».
7. Создатель, пришедший из Telegram, входит как гость. Права организатора — существующим путём
   `?start=host_<token>` (личка, `ownerId`).

### 8.5 Отвязка
- Из комнаты: создатель жмёт «Отвязать». Служба снимает закреп (`unpinChatMessage`), меняет
  сообщение на «Встреча отвязана» без кнопки и помечает привязку отозванной. Старые ссылки
  `startapp` после этого отдают «Привязка снята».
- `/unbind` в чате: тот, кто запрашивал привязку, или админ чата (чат принадлежит им). Создатель
  видит уведомление в комнате.
- Автоматически: бот удалён из чата (обновление `my_chat_member` — его нужно добавить в
  `allowed_updates`, сейчас там только `message` и `channel_post`) или комната удалена (ядро
  отвечает 404 — та же ветка, что в `ensure_room`).

### 8.6 Данные (SQLite, `CREATE TABLE IF NOT EXISTS`)
- `telegram_links(id PK, scope UNIQUE, room_id, body JSON, created_at, revoked_at)`. В `body`:
  `chatId`, `threadId`, `chatTitle`, `requestedBy` (Telegram id), `approvedBy` (участник Cord),
  `messageId`, `pinned`.
- `telegram_requests(id PK, room_id, scope, body JSON, expires_at)`.
- В существующие `bindings[scope]` пишем то же, что сейчас (`roomId`, `profile`, …): `/meet`,
  `/play` и прочие команды продолжают работать без изменений.
- Telegram id участников Mini App не храним, кроме счётчиков ограничения частоты в памяти.
  `initData` никогда не пишем в журнал — как и токен бота.

### 8.7 API служб
| Метод | Кто | Что |
|---|---|---|
| `POST /rooms/{id}/telegram/link` | создатель | `{code, expiresAt, startgroupUrl, command}` — развитие нынешнего |
| `GET /rooms/{id}/telegram` | создатель | `{binding: {chatTitle, since, pinned} \| null, request: {…} \| null}` |
| `POST /rooms/{id}/telegram/requests/{rid}` | создатель | `{decision: allow \| decline, commandId}` |
| `DELETE /rooms/{id}/telegram/binding` | создатель | отвязать |
| `POST /telegram/webapp/enter` | `initData` | `{roomId, title, name, inviteUrl}` |

### 8.8 Фронтенд и инфраструктура
- Vite multi-page: `web/tg.html` и `web/src/telegram/` (`sdk.ts` — обёртка, `TelegramEntry.tsx`,
  `insets.ts`, `media-probe.ts`). Встреча — тот же `MeetingView`.
- **`infra/Caddyfile`** для `/tg`: убрать `X-Frame-Options DENY` и поставить
  `frame-ancestors https://web.telegram.org` (Web A и Web K). `script-src 'self'` оставить: SDK
  в бандле. Аватар из `photo_url` (`t.me`) не показываем — иначе нужно расширять `img-src`.
- `Permissions-Policy camera=(self), microphone=(self)` подходит: iframe клиента делегирует
  разрешение через `allow`.

## 9. Шаги владельца (→ `OWNER-ACTIONS.md`)
1. @BotFather → `/mybots` → бот → Bot Settings → **Configure Mini App → Enable Mini App**, URL
   `https://meet.nikg.tech/tg`. Это главный Mini App, ссылка `t.me/<бот>?startapp=…`.
   Альтернатива — `/newapp`: название, описание, фото 640×360, short name (например, `meet`), тот
   же URL. Тогда в env пишем `TELEGRAM_WEBAPP_SHORT_NAME=meet`.
2. Там же → **Configure Splash Screen**: иконка Cord и цвет фона `#16181f` для светлой **и**
   тёмной темы. Проверить через Open Splash Screen Preview.
3. **Edit Description Picture**: картинка или видео загрузки Cord (текст описания бот ставит сам).
4. По желанию: Main Mini App → Previews (скриншоты и видео встречи); аватар.
5. `/setjoingroups` — включено. `/setprivacy` можно оставить включённым: команды мы адресуем
   `@бот`.
6. **`/setdomain` не нужен**: он связывает домен с Login Widget и `login_url`, а не с Mini App.
7. Защиту Mini App по источнику (10.2) **не отключать**.
8. Включить `TELEGRAM_WEBAPP_ENABLED=true` на тестовом боте. Пройти чек-лист прототипа (§6) на
   своих устройствах.

## 10. Риски и открытые вопросы
- **Медиа в WebView** — главный риск: §6, прототип первым. Если на iOS чёрный кадр подтвердится,
  на iOS по умолчанию предлагаем «Открыть в браузере», а встроенный режим оставляем только для
  звука.
- **Доступность Telegram в РФ** (замедление с 02.2026): от нас не зависит. Снижаем зависимость:
  всё отдаём со своего домена, Bot API вызываем с сервера во Франкфурте.
- Окно подтверждения при нажатии url-кнопки (§3) — проверить на живом боте. Если мешает,
  рассмотреть Direct Link.
- Закреп в теме форума: `pinChatMessage` не принимает `message_thread_id` — проверить, где окажется
  закреп.
- `mode=fullscreen` описан для клиентов в `api/links`. Если какой-то клиент его не знает, остаётся
  `requestFullscreen()`.
- В `DECISIONS.md → «Решено агентом»` после одобрения: SDK `@tma.js/sdk`, главный Mini App,
  проверка членства через `getChatMember`, `auth_date ≤ 1 ч`, `frame-ancestors` для `/tg`.

## 11. Источники
Первоисточники Telegram (прочитаны 19.10.2026):
- https://core.telegram.org/bots/api — InlineKeyboardButton, KeyboardButton, MenuButton, setChatMenuButton,
  setMyDescription, setMyShortDescription, setMyProfilePhoto, pinChatMessage, getChatMember,
  KeyboardButtonRequestChat, CallbackQuery.chat_instance
- https://core.telegram.org/bots/api-changelog — 10.3 (24.08.2026), 10.2 (защита по источнику), 9.4 (`style`), 8.0
- https://core.telegram.org/bots/webapps — способы запуска, WebApp, SafeAreaInset, WebAppInitData, проверка HMAC и Ed25519, события
- https://core.telegram.org/api/bots/webapps — обработка Direct Link, подтверждение, флаги `fullscreen`, `fullscreen_changed`
- https://core.telegram.org/api/links — Main и Direct Mini App links, `mode=compact|fullscreen`, `startgroup&admin=`
- https://core.telegram.org/bots/features — Description Picture, Splash Screen, `/setdomain`, Main Mini App
- https://telegram.org/js/telegram-web-app.js?64 — CSS-переменные безопасных зон, проверки версий

Исходники клиентов:
- https://github.com/TelegramMessenger/Telegram-iOS/blob/master/submodules/WebUI/Sources/WebAppController.swift , …/WebAppWebView.swift
- https://github.com/DrKLO/Telegram/blob/master/TMessagesProj/src/main/java/org/telegram/ui/web/BotWebViewContainer.java
- https://github.com/desktop-app/lib_webview (`webview_windows_edge_chromium.cpp`, `webview_mac.mm`, `webview_linux_webkitgtk.cpp`)
- https://github.com/Ajaxy/telegram-tt/blob/master/src/util/browser/iframe.ts
- https://github.com/morethanwords/tweb/blob/master/src/components/webApp.tsx

Сообщения о медиа:
- https://github.com/Telegram-Mini-Apps/tma.js/issues/748 , https://github.com/Telegram-Mini-Apps/tma.js/issues/390 , https://github.com/Telegram-Mini-Apps/tma.js/issues/681
- https://github.com/Telegram-Mini-Apps/issues/issues/43 , https://github.com/Telegram-Mini-Apps/issues/issues/83
- https://github.com/DrKLO/Telegram/pull/1947
- https://bugs.webkit.org/show_bug.cgi?id=208667
- https://github.com/mdn/browser-compat-data/blob/main/api/MediaDevices.json

SDK и примеры:
- https://github.com/Telegram-Mini-Apps/tma.js , https://www.npmjs.com/package/@tma.js/sdk , https://www.npmjs.com/package/@tma.js/sdk-react
- https://www.npmjs.com/package/@telegram-apps/sdk , https://www.npmjs.com/package/@tma.js/init-data-node
- https://docs.telegram-mini-apps.com/platform/start-parameter , https://docs.telegram-mini-apps.com/platform/init-data ,
  https://docs.telegram-mini-apps.com/packages/tma-js-sdk/features/viewport
- https://github.com/twa-dev/SDK , https://github.com/vkruglikov/react-telegram-web-app
- https://github.com/Telegram-Mini-Apps/reactjs-template , https://github.com/telegram-mini-apps-dev/awesome-telegram-mini-apps
- https://github.com/moonkattymky/moonkatty-game/pull/20 , https://github.com/apiton-org/telegram-game-fullscreen-template

Контекст РФ: https://www.bfm.ru/news/597714 , https://novayagazeta.eu/articles/2026/02/10/telegram-snova-blokiruiut-v-rossii
