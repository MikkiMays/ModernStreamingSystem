# Ревью 1.0.3 — клиент Windows (Electron + cord-native): карта дефектов и проект доработок

Разбор по задачам R57–R64, R34, R26 и Electron-части R01–R03. Только чтение кода; ничего не менялось.
Пути: `W/` = `/opt/ModernStreamingSystem.Windows/desktop`, `web/` = `/opt/ModernStreamingSystem/web/src`.
Строки — по состоянию на 21.10.2026.

Сводная таблица в конце; дальше — по пунктам: корень → проект → файлы → тесты → риски → что проверяется
только на живом Windows.

---

## R57. Крестик не сворачивает в трей

### Корень

Сворачивания в трей в коде **нет вовсе** — ни по умолчанию, ни по переключателю. Трей — только значок с меню.

- `W/src/main/windows/main.ts:147-156` — обработчик `close`: `event.preventDefault()` → `remember()` →
  `host.requestClose()` (ждёт `close.ready` ≤ 2,5 с в звонке) → **`this.window.destroy()`**. Всегда уничтожает окно.
- `W/src/main/index.ts:246-252` — `windowHost.onClosed`: `this.main = null … if (!this.quitting) this.quit()`.
  Закрытие окна = выход из приложения (`index.ts:322-330`, `app.quit()`).
- `W/src/main/settings.ts:50` — `tray: true` по умолчанию, но семантика переключателя
  (`W/src/main/app-settings.ts:13-14`, `tray.ts:52-58`) — «значок в трее: открыть, микрофон, выйти», не «прятать при закрытии».
- `W/src/main/index.ts:176` — старт с `--hidden` делает `minimize()`, а не `hide()`: то же «нет режима в трее».
- ADR 0001 §4.4 (`docs/adr/0001-electron-shell.md:269`) обещает «Трей: микрофон, выйти, закрыть» — «закрыть» так и не появилось.

### Проект

Поведение как у Discord: крестик прячет окно, Cord живёт в трее (встреча не рвётся), выход — из меню трея,
«Выйти» или при выключении Windows. Переключатель один — существующий «Значок в трее»: включён → крестик
прячет; выключен → крестик закрывает как сейчас. Отдельной настройки «сворачивать в трей» не делать (X3).

1. Чистая политика `W/src/main/close-policy.ts` (без Electron):
   `decideClose({tray, quitting, updating, sessionEnding}) → 'hide' | 'close'`. `hide` только если `tray && !quitting && !updating && !sessionEnding`.
2. `MainWindow` (`windows/main.ts`): в `close` — спросить `host.closeAction()`; при `hide`:
   `event.preventDefault(); this.window.hide();` без `close-request` вебу (звонок продолжается). При первом
   прятании — `tray.displayBalloon({title:'Cord работает в трее', content:'Встреча продолжается. Выйти — в меню значка.'})`
   один раз, флаг `trayHintShown` в `settings.json`.
3. `Shell` (`index.ts`): `app.on('before-quit', () => this.quitting = true)`; `session-end` окна
   (`window.on('session-end')`, Electron ≥ 30) → `quitting = true` → `quit()`; `second-instance`/`open-url`/
   уведомление/трей «Открыть» уже идут через `focus()` → `MainWindow.focus()` (`main.ts:194-199`) делает `show()` — восстановление из трея работает.
4. Переключение `tray` в рантайме (`applyAppSettings`, `index.ts:300-303`): выключили — следующее закрытие
   закрывает; включили — прячет. При `tray=false` и спрятанном окне — показать окно (не оставить «невидимым без значка»).
5. `--hidden` при автозапуске: `hide()` вместо `minimize()`, если `tray`; иначе как сейчас.
6. Трей-меню (`tray.ts:62-69`): добавить пункт «Закрыть окно»? Нет — лишнее; хватает «Открыть Cord» и «Выйти».
   Двойной клик по значку → `open`. Подсказка значка — состояние звонка («Во встрече · микрофон выключен»).

### Файлы

`W/src/main/close-policy.ts` (новый), `W/src/main/windows/main.ts`, `W/src/main/index.ts`, `W/src/main/tray.ts`,
`W/src/main/settings.ts` (`trayHintShown`), `docs/adr/0001-electron-shell.md` §4.4, `README.md` (раздел трея).

### Тесты

- vitest: `W/test/unit/close-policy.test.ts` — матрица `tray × quitting × updating × sessionEnding`.
- e2e (Playwright `_electron`, `W/test/e2e/smoke.spec.ts`, шаблон — `W/.local/close-probe.mjs`): `window.close()`
  при `tray=true` → процесс жив, `BrowserWindow.getAllWindows()[0].isVisible() === false`, `app.evaluate` отвечает;
  `tray=false` → процесс завершился. На Linux-раннере `Tray` может не создаться (нет системного лотка) — прогон
  должен терпеть `installTray` с ошибкой (как сейчас `index.ts:276-282`), политика при этом — `close`.
- CI Windows (`desktop.yml`, `scripts/test-installer.ps1`): после запуска установленного Cord — закрыть окно через
  `WM_CLOSE` (PowerShell `[Win32]::PostMessage`) и проверить, что `Cord.exe` жив 5 с, затем `taskkill`.

### Риски

- Спрятанное окно в звонке: `backgroundThrottling: false` уже стоит (`main.ts:137`), таймеры и звук не замедлятся.
  Но `document.hasFocus()` в вебе станет `false` — на этом и строится R59.
- `restartIntoSplash` (`index.ts:756-766`) ставит `quitting = true` вокруг `destroyForUpdate` — путь не трогать;
  `destroyForUpdate` вызывает `destroy()`, а не `close()`, так что политика его не перехватит.
- Человек «потерял» Cord: нет значка (трей выключен, но окно спрятано) — закрывается пунктом 4.

### Только на живом Windows

Баллон трея (Win11 показывает как toast), поведение при выключении Windows (`session-end`), восстановление из
трея, когда окно было на отключённом мониторе.

---

## R58. Иконка трея прозрачная

### Корень

Файла иконки в упакованном приложении нет → `nativeImage.createEmpty()` → прозрачный значок.

- `W/src/main/tray.ts:25-29` — `icon()` ищет `build/icon.ico` и `dist/shell/icon.ico`, иначе `createEmpty()`.
- `W/electron-builder.yml:11-14` — `files: dist/**/*, package.json`: каталог `build/` в `app.asar` **не попадает**.
- `W/scripts/copy-shell.mjs:9` — в `dist/shell` копируется только `src/shell/*`; там `icon-256.png`, `mark.svg`,
  но **нет `icon.ico`**. Итог: в `electron .` (dev) иконка есть, в установленном Cord — пустая. Ровно то, что видит владелец.
- Вторично: `W/build/icon.ico` — 7 записей и **все PNG-сжатые** (16/24/32/48/64/128/256; проверено заголовком).
  Для трея и `LoadImage` Windows рекомендует BMP-записи для размеров ≤ 48 и PNG только для 256; PNG-16 в трее у части
  систем рисуется с артефактами альфы/размыто.

### Проект

1. Отдельный файл трея `W/src/shell/tray.ico` (едет в `dist/shell` штатным `copy-shell.mjs`): записи 16, 20, 24, 32, 48
   в BMP 32-бит + 256 PNG; рисунок — марка без подложки с запасом 1 px (на тёмной и светлой панели). Генерация —
   скрипт `W/scripts/make-icons.mjs` из `mark.svg` (sharp/resvg в devDependencies) либо один раз руками, файл в git.
2. `tray.ts`: `trayImage(appPath)` → `createFromPath(dist/shell/tray.ico)`; `if (image.isEmpty())` → запасной путь
   `createFromPath(dist/shell/icon-256.png).resize({width: 16, height: 16})`; если и он пуст — `log('трей: иконка не найдена')`
   и **не** создавать трей (пустой значок хуже отсутствия). `nativeImage` для ICO на Windows берёт нужный размер по DPI сам.
3. Состояние в трее (как Discord): во встрече подменять на вариант с точкой (`tray.setImage`), 2 дополнительных ICO
   (`tray-call.ico`, `tray-muted.ico`) — по желанию, не блокирует.
4. Проверка сборки: `W/scripts/check-dist.mjs` (по образцу `build-native.mjs --check`): `dist/shell/tray.ico` существует,
   ≥ 5 записей, 16 и 32 среди них; шаг в `desktop.yml` после `npm run build`.

### Файлы

`W/src/shell/tray.ico` (новый), `W/src/main/tray.ts`, `W/scripts/check-dist.mjs` (новый), `W/.github/workflows/desktop.yml`,
при желании `W/scripts/make-icons.mjs`.

### Тесты

- vitest `W/test/unit/tray-icon.test.ts`: разбор ICO-заголовка (чистая функция `icoEntries(buffer)`) — размеры и формат;
  выбор кандидата и запасного пути по подменённому `existsSync`.
- CI: `check-dist.mjs`; `test-installer.ps1` — распаковать `app.asar` (`npx @electron/asar extract-file dist/shell/tray.ico`)
  и убедиться, что файл в пакете.

### Риски

Иконка в трее масштабируется Windows по DPI: без 20/24 px при 125/150 % будет размыто. Светлая тема панели задач —
марка должна читаться на белом.

### Только на живом Windows

Внешний вид на 100/125/150/200 %, светлая/тёмная панель, Win10 и Win11.

---

## R59. Системные уведомления Windows

### Корень (почему их не видно)

1. **AUMID не совпадает с ярлыком.** `W/src/main/windows/main.ts:212-214` — `app.setAppUserModelId('Cord')`.
   electron-builder ставит ярлыкам AUMID = `appId` = `tech.cord.desktop`
   (`W/node_modules/app-builder-lib/templates/nsis/include/installer.nsh:197-200` — `WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"`).
   Windows 10/11 показывает toast Win32-приложения только для AUMID, у которого есть ярлык в меню «Пуск» с этим же
   AUMID; иначе toast молча не показывается (или показывается без значка/имени). У нас — `Cord` ≠ `tech.cord.desktop`.
2. **Ярлык рабочего стола без AUMID.** `W/build/installer.nsh:120` — свой `CreateShortCut "$DESKTOP\Cord.lnk"` без
   `WinShell::SetLnkAUMI` (стандартный путь electron-builder выключен: `createDesktopShortcut: false`).
3. **Веб ничего не шлёт.** Оболочка умеет `notify`, `badge`, `attention`, `progress` (`W/src/main/index.ts:612-626`,
   `messages.ts:482-508`, `notifications.ts`), но веб их не вызывает: `grep notifyDesktop(` в `web/` даёт только
   `state`, `call-state`, `overlay.state`, `hotkey.configure`, `favorites.changed`, `preferences.changed`, `servers.*`,
   `update.*`, `capture.select`, `close-ready`, `session.expired`. Ни одного `notify`/`badge`/`attention`.
4. `W/src/main/notifications.ts:19` — `silent: false`: когда веб всё же начнёт слать, toast будет звучать поверх
   собственных звуков веба (`web/core/sounds.ts`) — дубль.

### Проект

**Оболочка.**
- Одна константа `APP_ID = 'tech.cord.desktop'` в `W/src/main/config.ts`; `app.setAppUserModelId(APP_ID)`.
  Тест читает `electron-builder.yml` через `js-yaml` (уже в зависимостях) и сверяет `appId` с константой.
- `installer.nsh` `customInstall`: после `CreateShortCut` рабочего стола — `WinShell::SetLnkAUMI "$DESKTOP\Cord.lnk" "${APP_ID}"`
  (плагин WinShell electron-builder уже кладёт в сборку).
- `notifications.ts`: `silent: true` всегда — звук даёт веб (у него уже есть переключатель «звуки уведомлений»,
  `bootstrap.notificationSounds`); `timeoutType: 'default'`; `toastXml` не нужен. Клик и кнопки уже возвращают
  `notification.action {id, tag}` и делают `focus()` (`index.ts:613-616`) — из трея окно поднимется (R57).
- Новое событие оболочки вебу `window.state {focused, visible}` (HOST_MESSAGES + `BrowserWindow` `focus/blur/show/hide`):
  вебу нужно знать «меня не видно», а `document.visibilityState` при `backgroundThrottling: false` всегда `visible`;
  `document.hasFocus()` подходит как запасной путь.

**Веб** (`web/core/desktop-notify.ts`, новый, чистая политика + тесты):
- Источник событий — то, что уже озвучивается: `web/core/meeting.ts:150-156` (`listen` → `cue`) и типы
  `web/core/sounds.ts:11-26` (`join`, `knock`, `message`, `screen`…). Хук: в `cue(kind)` рядом со звуком — `decideNotification(kind, ctx)`.
- Что уведомлять (только это, X3):
  | Событие | Когда | Текст | Действия |
  |---|---|---|---|
  | `knock` — просится войти | всегда, если окно не в фокусе; в фокусе — только плашка веба | «Имя просится во встречу» | «Впустить», «Отклонить» → `notification.action` → `meeting.admit/deny` |
  | `message` — сообщение в чате | окно не в фокусе или панель чата закрыта | «Имя: первые 120 символов» | клик → открыть чат |
  | `join` — вошёл | окно не в фокусе | «Имя вошёл во встречу» (склеивать: «Имя и ещё 2») | клик → окно |
  | упоминание | нет аккаунтов, но имя есть: сообщение содержит `@имя` или имя целиком → как `message`, но и в фокусе, с `attention` | — | — |
- `badge {count}` — непрочитанные чата, пока окно не в фокусе; сброс при фокусе. `attention` (мигание) — на `knock` и упоминание.
- Без дублей: toast `silent`; звук — только из `sounds.ts` по прежним правилам; если `notificationSounds` выключен —
  тишина и toast. `tag` = `room:<id>:<kind>` → Windows заменяет предыдущий toast того же рода, а не копит.
- «Не беспокоить» Windows соблюдается системой; своей кнопки «не уведомлять» в вебе не добавлять.

### Файлы

`W/src/main/config.ts`, `W/src/main/windows/main.ts`, `W/build/installer.nsh`, `W/src/main/notifications.ts`,
`W/src/shared/bridge.ts` (`window.state`), `W/src/main/index.ts`; `web/core/desktop-notify.ts` (новый), `web/core/meeting.ts`,
`web/core/desktop.ts` (ретрансляция `notification.action`, `window.state`), `web/ui/MeetingView.tsx` (обработка действий),
i18n 8 языков (`web/i18n/locales/*.json` → `desktop.notify.*`), `contracts/desktop-bridge.v2.schema.json` в ядре.

### Тесты

- vitest desktop: `config.test.ts` — AUMID = `appId` из yml; `messages.test.ts` уже проверяет `notify` (оставить).
- vitest web: `desktop-notify.test.ts` — матрица событие × фокус × чат открыт; `tag`, склейка входов, лимиты длины (80/300 как в `messages.ts:483-484`).
- CI Windows: `test-installer.ps1` — прочитать AUMID ярлыков (`$shell.CreateShortcut` не даёт AUMID; через
  `Get-Item … | % { (New-Object -ComObject Shell.Application).Namespace(..).ParseName(..).ExtendedProperty('System.AppUserModel.ID') }`)
  и сравнить с `tech.cord.desktop`.

### Риски

Смена AUMID = Windows считает установленное приложение «другим»: закреплённые на панели задач ярлыки старых
установок останутся с AUMID… нет — ярлыки уже `tech.cord.desktop`, меняется только то, что говорит процесс; наоборот,
станет правильно. Список переходов (`setJumpList`) тоже привязан к AUMID — после смены он начнёт работать стабильно.

### Только на живом Windows

Появление toast в Центре уведомлений, кнопки действий, Focus Assist, поведение, когда окно спрятано в трей.

---

## R61. Оверлей по умолчанию включён

### Корень

`W/src/main/settings.ts:55` — `overlayEnabled: false`; задокументировано в `app-settings.ts:6-7` и ADR §4.3 (`0001-electron-shell.md:249`).
`settings.update()` пишет весь объект (`settings.ts:90-96`), поэтому у всех, кто уже ставил 1.0.x, в `settings.json`
лежит явное `overlayEnabled: false`, даже если человек переключатель не трогал.

### Проект

- `DEFAULTS.overlayEnabled = true`.
- Миграция один раз: `settingsRev: 2` в `Settings`; при чтении файла с `settingsRev < 2` — `overlayEnabled = true`
  (владелец просит «по умолчанию включён», а не «сохранить выбор, которого не было»). Фиксировать в `sanitize`.
- Обновить тексты: ADR §4.3 п. «по умолчанию выключен», `app-settings.ts` шапка, `web/i18n` `settings.desktop.overlayNote` (8 языков) — там же сказать про эксклюзивный полноэкранный режим (см. R62).
- `test/unit/app-settings.test.ts:26` и новый тест `settings.test.ts` на миграцию.

Риск: оверлей без `cord-native` (модуль не загрузился) виден в **каждом** звонке на дисплее главного окна
(`overlay-policy.ts:20`: `if (!foreground) return { visible: true, anchor: null }`) — то есть поверх самого Cord.
С включением по умолчанию это станет заметно. Исправить вместе с R62: без сведений о переднем окне оверлей **не показывать**.

---

## R62–R63. Оверлей «как Discord и лучше»

### Как устроено сейчас

| Часть | Где | Что делает |
|---|---|---|
| Окно | `W/src/main/windows/overlay.ts:18-50` | `BrowserWindow` 320×360, `transparent`, `frame:false`, `focusable:false`, `skipTaskbar`, `setAlwaysOnTop(true,'screen-saver')`, `setIgnoreMouseEvents(true)` **без `forward`**, `setContentProtection(true)`; грузит `cord-app://overlay`. |
| Положение | `overlay.ts:65-75` | Левый верхний угол **рабочей области** (`workArea`) монитора переднего окна, +12 px; только левый верхний угол. |
| Политика | `W/src/main/overlay-policy.ts:18-23` | Виден: в звонке ∧ включён ∧ (нет данных о переднем окне ∨ (не Cord ∧ окно на весь монитор)). |
| Переднее окно | `W/native/src/win/input.rs:333-357`, `foreground.rs:45-52`, `process.rs:391-410` | Раз в 300 мс (`index.ts:346`): HWND, PID, `GetWindowRect`, монитор, класс окна; «на весь монитор» = рамка ≥ монитора и не `Progman/WorkerW`; «свой» — по дереву процессов (Toolhelp). **Имени exe нет**, окон/заголовка нет, borderless от эксклюзивного не отличает. |
| Данные | `web/ui/MeetingView.tsx:257-287` → `W/src/main/index.ts:609-611` → `overlay.ts:81-84` → `W/src/shell/overlay.js` | ≤ 10 Гц: имя (≤ 40), `tier` 0–4 (из `media/levels.ts`, ≤ 30 Гц, атака 1 кадр), `speaking` от SFU. ≤ 20 участников в сообщении (`messages.ts:471`), рисуется 10 (`overlay.js:31`). **Аватаров нет** (ADR §3 «без аватаров»). |
| Вид | `W/src/shell/overlay.html` | Список строк «точка + имя», обводка говорящего, без анимаций. |
| Клавиша | `overlay.toggle` → `index.ts:156-161` | Вкл/выкл оверлея целиком; блокировки нет. |

Путь уровня громкости: анализатор (rAF ≤ 30 Гц) → дроссель 100 мс → IPC в main (разбор JSON `messages.ts:470-481`)
→ `webContents.send` в окно оверлея → `replaceChildren` всего списка. Задержка 100–150 мс плюс перерисовка всего DOM
на каждый тик — отсюда «не моментально». При спрятанном главном окне (R57) анализ продолжается
(`backgroundThrottling:false` держит `visibilityState: visible`, `levels.ts:21,130`).

### Проект (Electron + Rust, без инъекций)

**1. Различение игр — `cord-native` + `W/src/main/games.ts`.**
- `process.rs::parent_map` уже читает `PROCESSENTRY32W`; добавить `szExeFile` → карта `pid → (parent, exe)`. Без
  `OpenProcess` вообще: имя exe приходит из того же снимка Toolhelp. В `ForegroundEvent` — `exe` (basename, lower-case),
  `title` (`GetWindowTextW`, ≤ 80), `borderless` (`GWL_STYLE` без `WS_CAPTION`/`WS_THICKFRAME` и рамка = монитору),
  `exclusive` (`SHQueryUserNotificationState() == QUNS_RUNNING_D3D_FULL_SCREEN` — это и есть штатный способ узнать
  эксклюзивный D3D-режим без касания процесса; `QUNS_BUSY` = borderless/оконный на весь экран).
- `games.ts` (чистая логика + тесты): реестр `settings.games: [{exe, name, enabled, lastSeen, firstSeen}]`.
  Правило регистрации: переднее окно не Cord ∧ (`fullscreen` ∨ `borderless` ∨ exe в `games-known.json`) ∧ не из
  стоп-листа (`explorer.exe`, `chrome.exe`, `msedge.exe`, `firefox.exe`, `vlc.exe`, `mpc-hc64.exe`, `obs64.exe`,
  `ApplicationFrameHost.exe`, `LockApp.exe`…) → добавить как `enabled: true`, событие вебу `games.changed`, плашка веба
  один раз «Обнаружена игра: Counter-Strike 2 — оверлей включён». `games-known.json` — ~150 exe популярных игр с именами
  (cs2.exe, dota2.exe, RocketLeague.exe, Witcher3.exe, HollowKnight.exe…), чтобы имя было человеческим, а не `cs2.exe`.
  Название для неизвестных — из заголовка окна.
- Решение показа: `decideOverlay(inCall, enabled, fg, games)` → виден ⇔ в звонке ∧ включён ∧ `fg` есть ∧ не Cord ∧
  игра зарегистрирована и `enabled` ∧ не `exclusive`. **Без `fg` (модуля нет) — не виден.**
- Веб: раздел «Windows → Оверлей» (аналог r103-26, без IGDB и «конфиденциальности активности»): «Сейчас активно»
  (текущая игра, переключатель), список «Зарегистрированные игры» с переключателем на игру и «Забыть», «Добавить
  вручную» (выбор exe через `dialog.showOpenDialog` оболочки — `invoke('games.pick')`). Мост: `invoke('games.list')`,
  `invoke('games.set', {exe, enabled})`, `invoke('games.forget', {exe})`, `invoke('games.pick')`, событие `games.changed`,
  событие `game.active {exe, name, exclusive}`.

**2. Голосовой виджет (R63).**
- Данные двумя каналами:
  - `overlay.roster` (редко, по изменению состава): `[{id, name, avatar}]`, аватар `data:image/` ≤ 4 КиБ
    (как `state.avatar`, `messages.ts:427-429`); отдельный лимит размера 128 КиБ (сейчас общий `MESSAGE_LIMIT` 16 КиБ,
    `bridge.ts:326` — 20 аватаров не влезут). Идёт через main с проверкой, как сейчас.
  - `overlay.levels` (горячий путь): `[[id, tier, speaking], …]` до 30 Гц. Транспорт — **MessagePort напрямую из
    страницы сервера в окно оверлея, минуя main**: `MessageChannelMain` в main; `port1` → `webContents.postMessage`
    в preload сервера → preload отдаёт странице `window.postMessage('cord:overlay-port', '*', [port])` (штатный путь
    Electron «MessagePorts: main → renderer → page»); `port2` → preload оверлея. Задержка ~1–3 мс вместо 100–150.
    `SharedArrayBuffer` между окнами невозможен (разные процессы, разные agent cluster) — не рассматривать.
    Окно оверлея само проверяет форму данных (sandbox, локальная страница, CSP `connect-src 'none'`).
  - Веб публикует `overlay.levels` из `media/levels.ts` (`watchAll`) без дросселя 100 мс — ограничение 30 Гц уже
    встроено в источник (`MAX_RATE_HZ`, `levels.ts:46`).
- Отрисовка (`overlay.html/js` → переписать на небольшой модуль без фреймворка): карточка на участника —
  аватар (круг, 3 размера: 32/40/56 px), кольцо говорящего (`tier` → цвет `--voice-1..4`, как в вебе), имя;
  обновления точечные (`data-tier` на существующем узле, не `replaceChildren`), переходы 90 мс на кольцо, появление/
  уход — 160 мс scale+fade, `prefers-reduced-motion` уважать, `will-change: transform`. Микрофон выключен — зачёркнутый
  значок у аватара. Говорящие — наверх? Нет: порядок стабильный (как Discord), чтобы не прыгало.
- Настройки (ровно нужное, X3): **положение** (4 угла + перетаскивание при разблокировке), **размер аватара**
  (S/M/L), **имена** (всегда / когда говорит / никогда), **прозрачность** (один ползунок 30–100 %). Всё в
  `settings.json` оболочки (`overlay: {corner, avatar, names, opacity, offset}`) через `invoke('app.settings')` —
  расширить `readAppSettingsPatch` (`app-settings.ts:56-65`, сейчас только булевы).
- **Блокировка/разблокировка** — сочетание `overlay.lock` (новое `HotkeyAction`, `messages.ts:347`, `settings.ts:165`).
  Разблокировано: `setIgnoreMouseEvents(false)`, `focusable` остаётся `false` (клавиатура игре), виджет
  перетаскивается, позиция пишется в `offset`; заблокировано: `setIgnoreMouseEvents(true, {forward: true})` —
  клики уходят в игру, но `mousemove` доходит, и можно подсветить виджет при наведении (без кликов).
- Окно: не 320×360 в углу, а **окно размером с монитор игры** (`display.bounds`, не `workArea` — под игрой панели
  задач нет; `overlay.ts:74` сейчас `workArea`), прозрачное; виджет позиционируется внутри CSS. Так углы и
  перетаскивание — без `setBounds` на каждое движение. `setAlwaysOnTop(true, 'screen-saver')` оставить;
  `setContentProtection(true)` оставить (в показ своего экрана не попадает — как Discord).
- Показ только когда игра впереди: при Alt-Tab на рабочий стол прячется (уже так); на Cord — прячется.

**3. Эксклюзивный полноэкранный режим — честно.**
Поверх настоящего эксклюзивного D3D/Vulkan/OpenGL окна ничего, кроме инъекции в процесс, не нарисует —
новый оверлей Discord ограничен так же (r103-23: «Требуется включение безрамочного дисплея»). На Windows 10/11
большинство DX11/12-игр с «оптимизацией полноэкранного режима» на деле borderless (flip-model) — там оверлей виден.
Что делаем: `exclusive` из `SHQueryUserNotificationState` → оверлей не показываем, веб один раз на игру показывает
плашку «CS2 в эксклюзивном полноэкранном режиме — оверлей не виден. Включите в игре режим «без рамки»»; в разделе
«Оверлей» у игры — пометка «эксклюзивный режим». В настройках (`overlayNote`) то же одной строкой.

**4. Что не переносим из Discord (нет аккаунтов, X2/X3):** чат в оверлее, «активность друзей», «сейчас играет»,
уведомления оверлея, «Go Live»-подсказки, виджеты видео/стримов, режим совместимости, «пожаловаться». Быстрые действия
(микрофон/наушники) — вторая очередь: требуют интерактивных зон при заблокированном оверлее, конфликтует с click-through.

### Файлы

`W/native/src/win/process.rs`, `W/native/src/win/input.rs`, `W/native/src/foreground.rs`, `W/native/src/lib.rs`
(поля события), `W/native/Cargo.toml` (`Win32_UI_Shell` для `SHQueryUserNotificationState`), `W/src/native/protocol.ts`,
`W/src/main/games.ts` (новый), `W/src/main/games-known.json` (новый), `W/src/main/overlay-policy.ts`,
`W/src/main/windows/overlay.ts`, `W/src/shell/overlay.html|js|css`, `W/src/preload/server.ts` и `shell.ts` (порт),
`W/src/shared/bridge.ts`, `W/src/main/bridge/messages.ts`, `W/src/main/app-settings.ts`, `W/src/main/settings.ts`,
`W/src/main/hotkeys.ts`; `web/ui/settings/DesktopSection.tsx`, `web/core/desktop-settings.ts`, `web/ui/MeetingView.tsx`
(roster/levels), `web/media/levels.ts` (экспорт для порта), i18n ×8, `contracts/desktop-bridge.v2.schema.json`, ADR §4.3.

### Тесты

- Rust: `foreground.rs` — `borderless`/`exclusive`/exe в `Change`, трекер шлёт событие при смене exe; `process.rs`
  парсер карты (чистая функция над `Vec<(pid, parent, exe)>`).
- vitest: `games.test.ts` — регистрация, стоп-лист, enable/disable, `forget`, миграция пустого реестра;
  `overlay-policy.test.ts` — новая матрица (включая «без модуля — не виден», «exclusive — не виден»);
  `messages.test.ts` — `overlay.roster` лимиты; `app-settings.test.ts` — не-булевы значения (`corner`, `opacity`).
- e2e smoke (`CORD_NATIVE_FAKE=1`, `host.ts:28-63`): подмена отдаёт `fullscreen:true, exe:'game.exe'` → окно
  `cord-app://overlay` видимо, в DOM карточки участников; смена на `cord:true` → скрыто.
- CI Windows: `cargo test` уже в `desktop.yml:153`; добавить шаг запуска установленного Cord с `CORD_METRICS_FILE` без изменений.

### Риски

- Античиты: прозрачные topmost-окна с `WDA_EXCLUDEFROMCAPTURE` — та же техника, что у внешних ESP-читов; FACEIT/
  Vanguard могут прятать окно или ругаться. Discord делает так же, но проверка на живой машине с FACEIT (CS2) обязательна
  (ADR §9 это уже требует). Запасной вариант — переключатель «не исключать из захвата» не делать; при жалобе — выключить оверлей для игры.
- `forward: true` у `setIgnoreMouseEvents` даёт `mousemove` в окно оверлея постоянно — держать обработчик лёгким.
- Имя exe из Toolhelp — только basename: игра `game.exe` в двух папках неразличима; принять.
- Mica у главного окна + прозрачное окно оверлея на том же мониторе — проверить, что DWM не роняет частоту кадров игры.
- MessagePort странице: страница сервера получает объект из preload — он доверен только на отправку, ничего не принимает.

### Только на живом Windows

Видимость над borderless/эксклюзивом, DPI разных мониторов, античиты, задержка «кольца» на глаз (цель ≤ 50 мс от звука).

---

## R60. Окно начала показа — как в Discord

### Где сейчас

Два окна выбора:
1. **Веб** — `web/ui/CapturePicker.tsx` (+ `capture-picker.css`, `core/desktop-capture.ts`): вкладки «Экраны»/«Окна»,
   плитки с миниатюрой (≤ 320×180, обновление раз в 4 с), внизу переключатель звука системы или радиокнопки режимов
   звука (`none/system/app/system-except-cord`), «Отмена»/«Показать». Используется всегда, когда есть флаг `capture`
   (`desktop-capture.ts:39-41`). Качество/частота кадров здесь **не выбираются**.
2. **Оболочка** — `W/src/shell/picker.html|js`, открывается из `setDisplayMediaRequestHandler` только если веб не
   прислал `capture.select` (`W/src/main/index.ts:816-821, 827-859`). Тексты только по-русски, захардкожены
   (`picker.html:34-47`, `picker.js:61-66`, `index.ts:847` «Что показать») — нарушает X1.

Параметры видео показа задаются в `web/media/capture.ts` / `media/profiles.ts` (пресеты публикации) — там и точка
применения режима.

### Проект (референс r103-02, r103-04)

Переделать **веб-окно** (оно и есть основное); окно оболочки — удалить как дубль (без выбора веба обработчик отвечает
`callback({})` — показа без окна выбора всё равно нет) или оставить как аварийное, но на `app.getLocale()` с 8 языками.
Рекомендация: удалить (`picker.html/js`, `openPicker`/`finishPicker`, `capture.pick`/`capture.cancel` в `installShellCalls`).

Макет окна (размер `lg`, 760→ 880 px, `web/ui/kit` Dialog):
- Вверху сегмент-вкладки **«Приложения» · «Весь экран» · «Устройства»** (иконки как в Discord): «Приложения» = окна
  (`kind: window`), «Весь экран» = экраны, «Устройства» = карты захвата/виртуальные камеры — `enumerateDevices()`
  `videoinput`, кроме выбранной камеры; при пустом — состояние «Устройства для захвата отсутствуют» (r103-04).
  Плитки 16:9, значок приложения + имя, выбранная — обводка акцентом; двойной клик = показать (есть).
- Внизу слева — **строка-сводка** выбранного режима: «Плавное видео · 720p · 30 fps · Звук приложения».
- Внизу справа — **сегмент SD / HD** и **шестерёнка** (popover меню, как r103-04):
  - «Режим стрима»: **Плавное видео** (720p30, `contentHint: 'motion'`), **Чёткий текст** (1080p, 5–15 fps,
    `contentHint: 'detail'`, выше битрейт на кадр), **Пользовательский** → разрешение 480/720/1080/1440 кнопками-сегментом
    и fps 15/30/60 (как ТЗ владельца для камеры: сегмент, не выпадающий список).
  - **Звук**: те же режимы, что сейчас (`captureAudioModes`), как подменю «Звук приложения ›» с текущим значением.
  - **Заглушить звук стрима для себя** — переключатель: свой показ не слышать (локальный mute опубликованной дорожки
    звука показа; у Discord это «Заглушить аудио стрима»).
  - «Расширенные» Discord — не переносить.
  - SD = 720p, HD = 1080p; при «Чёткий текст» сегмент показывает 1080p как HD. Без Nitro-баннеров.
  - Кнопка **«Стримить» → «Показать»** справа от сегмента (как r103-04), «Отмена» — крестик окна.
- Запоминать выбор в `web/core/preferences.ts` (`screen: {mode, width, fps, audio, muteOwn}`); при открытии окна —
  последний режим.
- Миниатюры: оставить текущие (`capture.sources` ≤ 320×180, обновление 4 с); для «Весь экран» — крупнее (2 колонки).

Применение: `media/capture.ts` — `getDisplayMedia` с `video: {width:{ideal}, height:{ideal}, frameRate:{ideal, max}}`
и `track.contentHint`; `media/profiles.ts` — пресет публикации по режиму (битрейт/simulcast); для «чёткого текста» —
`degradationPreference: 'maintain-resolution'`. Это веб-часть R60; оболочке менять нечего, кроме удаления дубля.

### Файлы

`web/ui/CapturePicker.tsx`, `web/ui/capture-picker.css`, `web/core/desktop-capture.ts`, `web/core/preferences.ts`,
`web/media/capture.ts`, `web/media/profiles.ts`, i18n ×8 (`capture.*`: `apps`, `screens`, `devices`, `noDevices`,
`mode.smooth`, `mode.text`, `mode.custom`, `muteOwn`, `sd`, `hd`, `start`); `W/src/main/index.ts` (удалить
`openPicker`/`finishPicker`/`capture.pick`/`capture.cancel`), `W/src/shell/picker.*` (удалить), ADR §4.1.

### Тесты

- vitest web: `capture-picker.test.tsx` (есть) — вкладки, сводка, сегмент SD/HD меняет сводку, меню режима,
  «Устройства» пустое состояние; `desktop-capture.test.ts` — параметры `getDisplayMedia` по режиму (чистая функция
  `captureConstraints(mode)`).
- vitest desktop: `capture.test.ts` — без изменений; удалить тесты окна оболочки, если его убираем.
- e2e: Playwright web (`web/e2e`) — открыть окно показа в `data-desktop` режиме с подменой `window.cordDesktop`.

### Риски

60 fps 1080p — нагрузка на энкодер и канал (R05/R07): пресеты «Пользовательский» 1440p60 показывать с пометкой
«нужен быстрый канал». Для окон (`window:`) 1080p означает масштаб окна, не экрана — сводка должна говорить «до 1080p».

### Только на живом Windows

Карты захвата в «Устройствах», process loopback по режимам звука (уже проверялось в E01-B3).

---

## R64. Установщик NSIS

### Что не так на r103-07 (корни)

| Что видно | Корень |
|---|---|
| Заголовок окна «Установка Cord» | стандартный `$(^SetupCaption)` NSIS — норма; но и единственный «титул» страницы — просто «Cord» (`W/build/installer.nsh:69` `MUI_WELCOMEPAGE_TITLE "Cord"`) — голо. |
| `Нажмите кнопку "Далее" для продолжения.` — прямые кавычки | `installer.nsh:20-27` добавляют `$_CLICK` — строка из `Russian.nlf` NSIS с `"…"`. Своя последняя строка в 8 языках с «» / “ ” / « » по правилам языка, либо вовсе без неё. |
| «— без прав администратора», «ставит их тихо» | канцелярит/двусмысленность: «ставит их тихо» ≈ «втихаря». Переписать: «Cord устанавливается для текущего пользователя, права администратора не нужны. Обновления приходят сами при запуске.» Аналогично в 7 языках. |
| Тёмная боковая картинка с логотипом рядом с белым диалогом, картинка мыльная | `build/installerSidebar.bmp` 164×314 при 96 DPI растягивается на 125/150 % (NSIS не DPI-aware: в шаблонах electron-builder `ManifestDPIAware` нет). Нужны: согласованный светлый/тёмный стиль под системную тему диалога (диалог всегда светлый в NSIS → светлая подложка), `ManifestDPIAware true` в `customHeader` (вставляется на верхний уровень скрипта, `installer.nsi:45-46`), и bitmap с запасом (328×628, `MUI_WELCOMEFINISHPAGE_BITMAP_NOSTRETCH` не нужен — MUI2 масштабирует). `installerHeader.bmp` 150×57 — то же. |
| Текст прижат к верху, пустое пространство внизу | стандартная разметка MUI2 welcome: заголовок + текст; добавить второй абзац и строку «Версия x.y.z · Для Windows 10/11 x64»? Версию владелец запретил показывать (T58) — не добавлять; использовать `MUI_WELCOMEPAGE_TITLE_3LINES` и 3 абзаца. |
| Нет выбора языка | `electron-builder.yml:66-67` — `displayLanguageSelector: false`, `language: 1049`. NSIS сам берёт язык Windows; при англоязычной Windows и русском пользователе — английский без выбора. |
| Карточка Windows, кнопки «Далее >»/«Отмена» | стандарт NSIS; кнопки с `>` — из nlf; заменить нельзя без правки nlf — принять. |

### Проект

1. **Выбор языка.** `displayLanguageSelector: true` → electron-builder вставит `MUI_LANGDLL_DISPLAY` в `.onInit`
   (`installer.nsi:58-61`, после `customHeader`). В `customHeader` до этого: `!define MUI_LANGDLL_REGISTRY_ROOT HKCU`,
   `MUI_LANGDLL_REGISTRY_KEY "Software\Cord"`, `MUI_LANGDLL_REGISTRY_VALUENAME "InstallerLanguage"` (запоминание),
   `MUI_LANGDLL_ALWAYSSHOW` (показывать и при запомненном — иначе повторная установка молчит; при `${Silent}` диалога нет
   и так), `MUI_LANGDLL_WINDOWTITLE "Cord"`, `MUI_LANGDLL_INFO "Выберите язык установки / Choose the installer language"`.
   Диалог стандартный (список из 8 языков — ровно `installerLanguages`), под нашим значком. Своя страница на nsDialogs
   невозможна: язык фиксируется в `.onInit` до создания страниц, а перезапуск установщика с `/LANG=` — хрупко.
   Названия языков в списке — родные (`LANGFILE` даёт «Русский», «English», «Español», …) — проверить `Russian.nlf`,
   что `LANGFILE_LANGDLL` = «Русский», а не «Russian».
2. **Передача языка в приложение.** `customInstall`: `WriteRegStr HKCU "Software\Cord" "Language" "$LANGUAGE"` (LCID).
   Оболочка при первом старте (нет `settings.json`) читает `HKCU\Software\Cord\Language` (Electron без `winreg`: через
   `reg.exe query` в `child_process` или `cord-native` `read_hkcu_string` — предпочесть native, 10 строк),
   переводит LCID → `ru|en|es|fr|it|zh-Hans|de|pt-BR`, пишет `settings.language` и отдаёт вебу в `Bootstrap.language`
   (`bridge.ts:294-301`); preload кладёт `localStorage['cord:language']`, если его ещё нет (как `cord:theme`,
   `server.ts:28-29`). Веб (`web/i18n/index.ts`) уже читает сохранённый язык; дальше — обычная смена в настройках.
3. **Тексты.** Все `LangString` переписать (8 языков), `$_CLICK` убрать; `MUI_WELCOMEPAGE_TITLE "Установка Cord"`
   (`$(CordWelcomeTitle)`), страница «Ярлыки» → объединить с выбором папки? Нет — оставить, но заголовок/подзаголовок
   («Ярлыки» / «Где показывать Cord» — норм); финиш: `MUI_FINISHPAGE_TITLE "Cord установлен"`, `MUI_FINISHPAGE_TEXT`,
   галочка «Запустить Cord» (`runAfterFinish: true` уже). Кавычки — через `GLOSSARY.md` i18n веба (там правила кавычек по языкам).
4. **Разметка/баннер.** `ManifestDPIAware true`; `installerSidebar.bmp` 2× (328×628) светлый, марка по центру,
   градиент бренда снизу; `installerHeader.bmp` 300×114; `MUI_HEADERIMAGE_RIGHT` оставить. Проверить на 100/125/150/200 %.
   Иконка установщика — `build/icon.ico` (есть).
5. **Карточка «Установленные приложения».** `Comments` уже на языке установки (`installer.nsh:131`); `DisplayVersion` —
   пишет electron-builder; `Publisher Cord` — есть. AUMID ярлыка рабочего стола — см. R59.
6. **docs/installer.md** устарел полностью (описывает WinUI, Inno Setup, WebView2: строки 3, 12, 64, 92) — переписать под
   NSIS/Electron (ADR §6): путь `%LOCALAPPDATA%\Programs\Cord`, без WebView2, обновление `electron-updater`, языки.

### Файлы

`W/electron-builder.yml`, `W/build/installer.nsh`, `W/build/installerSidebar.bmp`, `W/build/installerHeader.bmp`,
`W/src/main/settings.ts` (`language`), `W/src/main/index.ts` (чтение реестра при первом старте), `W/native/src/win/*`
(`read_hkcu_string`) или `child_process`, `W/src/shared/bridge.ts` (`Bootstrap.language`), `W/src/preload/server.ts`,
`web/i18n/index.ts` (учесть `cord:language` из preload), `W/scripts/test-installer.ps1`, `docs/installer.md`, ADR §6.

### Тесты

- `makensis` на Linux есть (`apt nsis`)? В CI сборка на windows-2022 — компиляция ловит синтаксис. Локально: `npx electron-builder --win nsis` не на Linux без wine; ограничиться CI.
- `test-installer.ps1`: тихая установка с `/LANG=1049`… тихий режим пропускает диалог; проверить `HKCU\Software\Cord\Language`
  после `/S` (= язык по умолчанию) и после `Cord-Setup.exe /LANG=1033 /S`; снимки экрана мастера (`-Screenshots`) на
  раннере через `Add-Type System.Windows.Forms` + `Graphics.CopyFromScreen` для ревью разметки в артефактах.
- vitest: `lcidToLanguage()` таблица; `settings.test.ts` — `language` sanitize.

### Риски

`MUI_LANGDLL_ALWAYSSHOW` раздражает при обновлении поверх — но обновления идут тихо (`/S`), диалога нет.
`ManifestDPIAware` меняет размеры всех страниц: nsDialogs-страница ярлыков (`installer.nsh:93` в `u`-единицах) проверить.

### Только на живом Windows

Внешний вид мастера на 100–200 %, диалог языка, карточка «Установленные приложения», финишная страница.

---

## R34. Кнопки окна наезжают на иконки шапки встречи

### Корень

- `W/src/main/windows/main.ts:121-126` — `titleBarStyle: 'hidden'` + `titleBarOverlay {color: '#00000000', height: 36}`:
  Windows рисует «—  ⧉  ×» поверх страницы в правом верхнем углу: 3 × 46 px = **138 px** (Win11; Win10 — 135) × 36 px, в DIP.
- Веб **ничего не знает** о зоне: в `web/` нет ни `env(titlebar-area-*)`, ни `navigator.windowControlsOverlay`, ни
  `-webkit-app-region` (grep по `src`, `index.html`, `public` — пусто). Единственная поправка на оболочку —
  `web/room-layout.css:19-23` для `.prejoin-page > .app-header` (высота 76 px, марка спрятана).
- Шапка встречи `web/ui/meeting-header.css:8-17` (`min-height: 64px; padding: 0 var(--space-6)`) и
  `meeting-header__actions` (`:174-179`, `MeetingHeader.tsx:157-187` — звезда, ссылка, «?») прижаты к правому краю на
  высоте ~30 px — ровно под кнопками окна (r103-15).
- Побочное: без `app-region: drag` окно **нельзя перетащить за шапку** — только за 36-px полосу? Нет: при
  `titleBarStyle: hidden` без drag-регионов в контенте перетаскивать не за что вовсе (кроме Win+стрелки/Alt+Space).

### Проект (веб; оболочке менять нечего)

1. Токены в `web/styles.css` под `html[data-desktop='true']` (атрибут ставит preload до первой отрисовки, `server.ts:50`):
   ```css
   html[data-desktop='true'] {
     --wco-h: env(titlebar-area-height, 36px);
     /* ширина кнопок справа = ширина окна − (x + width зоны заголовка) */
     --wco-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw));
   }
   ```
   `env()` отдаёт значения только когда есть WCO (Electron `titleBarOverlay` = Window Controls Overlay) — в браузере
   fallback `0`/`36px` безвреден.
2. `.meeting-header { padding-right: calc(var(--space-6) + var(--wco-right, 0px)); min-height: max(64px, var(--wco-h)); }`;
   то же для шапки главной `.app-header` (`styles.css:279`) и окна настроек (`ui/settings/SettingsWindow.tsx` — крестик в
   правом верхнем углу), панели «Боты и интеграции» (её крестик на r103-15 на 95 px — ниже 36, не задет, но при
   `min-height` меньшем задет будет).
3. Drag: `.meeting-header, .app-header, .settings-window__header { -webkit-app-region: drag; }` и
   `button, a, input, [role=button] { -webkit-app-region: no-drag; }` внутри них — чтобы шапка двигала окно, как у Discord.
4. JS: `navigator.windowControlsOverlay?.addEventListener('geometrychange', …)` не нужен — `env()` обновляется сам при
   максимизации/восстановлении. Проверить `getTitlebarAreaRect()` только в e2e.
5. Цвет символов задаёт оболочка по теме (`main.ts:124, 191`) — остаётся.

### Файлы

`web/styles.css`, `web/ui/meeting-header.css`, `web/ui/settings/*.css`, `web/room-layout.css` (76 px → через токен).

### Тесты

- vitest/RTL не видит `env()`; Playwright web (`web/e2e`) в режиме `data-desktop` с подменой CSS-переменной
  `--wco-right: 138px` — скриншот-тест, что `meeting-header__actions` правее 138 px от правого края нет.
- e2e Electron smoke: `await page.evaluate(() => navigator.windowControlsOverlay.getTitlebarAreaRect().width)` > 0 на Windows.

### Только на живом Windows

Реальная ширина зоны (Win10/11, 125 %), перетаскивание за шапку, двойной клик по шапке = максимизация (Electron даёт для drag-области).

---

## R26. Shift подсвечивает окна — есть ли вклад Electron/cord-native

### Вывод: Electron и cord-native не при чём

- `cord-native` только **слушает** Raw Input (`W/native/src/win/input.rs`): ни `SendInput`, ни `keybd_event`, ни хуков
  (`grep` — пусто); отпускания эмулируются только внутри своей машины состояний (`matcher.rs`), в систему не уходят.
- Electron: меню скрыто (`main.ts:142` `setMenuBarVisibility(false)`), `Alt` не включает меню; `globalShortcut`
  регистрирует только сочетания с Ctrl/Alt (`hotkeys.ts`); контекстное меню — только по ПКМ (`menu.ts`).
- Корень в вебе: `web/styles.css:51-58` — `:focus-visible { outline: 3px solid var(--blue) }`; по эвристике Chromium
  **любое** нажатие клавиши, включая одиночный модификатор, переводит фокус в «клавиатурный», и кнопка, на которой
  остался фокус после клика мышью, получает кольцо. Исправление в вебе: расширить `web/ui/pointer-focus.ts`
  (сейчас только для ползунков, `styles.css:168`): на `pointerdown` ставить `data-pointer-focus` на целевой
  фокусируемый элемент, снимать при Tab/стрелках/Space/Enter (не при Shift/Ctrl/Alt/Meta); CSS
  `[data-pointer-focus]:focus-visible { outline: none }`. Клавиатурная навигация остаётся. То же в Electron автоматически.
- Проверить только одно в оболочке: `spellcheck: true` (`main.ts:139`) не влияет на фокус. Ничего не менять.

---

## Electron-часть R01–R03: звук, таймеры, приоритеты

### Что есть

| Мера | Где | Состояние |
|---|---|---|
| `backgroundThrottling: false` | `W/src/main/windows/main.ts:137` | есть, только главное окно; этого достаточно для таймеров/rAF/`visibilityState` страницы |
| `autoplayPolicy: 'no-user-gesture-required'` | `main.ts:138` | есть |
| Ключи Chromium (`app.commandLine.appendSwitch`) | нигде (`grep` по `src/main` пусто) | нет: ни `disable-renderer-backgrounding`, ни `disable-background-timer-throttling`, ни `disable-backgrounding-occluded-windows` |
| `powerSaveBlocker` | `index.ts:313-320` | `prevent-display-sleep` во встрече/показе — верно (включает `ES_SYSTEM_REQUIRED`) |
| Приоритет процессов / EcoQoS | нигде | нет |
| Звук приложения (process loopback) | `W/native/src/win/audio.rs`, `host.ts:130-150`, `preload/server.ts:105-165` | 10-мс порции float32 → `MessagePort` → `MediaStreamTrackGenerator`; метки времени считаются по счётчику кадров (`server.ts:149`) |

### Что из этого может давать «трек лагает в клиенте, но не в Edge»

Честно: музыка — **принятая** WebRTC-дорожка музыкального бота (`web/core/meeting.ts:163-167` — бот публикует как
микрофон), запас приёма — `web/media/playout.ts`. Это одинаково в Edge и в Electron; R09 (1 кбит/с, потери 6 %) указывает
на сервер/бота, не на оболочку. Отличия Electron, которые стоит закрыть, потому что они реальны и дёшевы:

1. **Field trials.** Edge/Chrome получают настройки NetEq/jitter через Finch; Electron — только дефолты Chromium.
   Не чинится ключами надёжно; фиксируем как объяснение разницы, не как корень.
2. **Окно под игрой/спрятано.** `backgroundThrottling:false` держит страницу «видимой», но Chromium всё равно считает окно
   **occluded** — компоновка стоит, что нормально; добавить `app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')`
   и `('disable-renderer-backgrounding')` до `app.whenReady` (`index.ts:61`) — страхует второй/третий `BrowserWindow`
   (оверлей, окно серверов) и воркеры; побочных эффектов нет.
3. **EcoQoS / «режим эффективности» Windows 11.** Windows может переводить фоновые процессы в EcoQoS; Chromium сам
   включает `PROCESS_POWER_THROTTLING` для фоновых рендереров (с `backgroundThrottling:false` — нет), но **utility
   «audio service»** и главный процесс при спрятанном окне (R57!) — кандидаты. Решение: в `cord-native` функция
   `set_power_throttling(pid, off)` (`SetProcessInformation(ProcessPowerThrottling)`, `PROCESS_POWER_THROTTLING_EXECUTION_SPEED` выкл.)
   и `SetPriorityClass(ABOVE_NORMAL)`; main вызывает во встрече для своего PID, рендерера главного окна
   (`webContents.getOSProcessId()`) и процесса `type: 'Utility', name: 'Audio Service'` из `app.getAppMetrics()`;
   снимает после встречи. Открытие чужих процессов не нужно — это свои дочерние (`PROCESS_SET_INFORMATION` у того же пользователя).
   Вне встречи — ничего (не греть ноутбук).
4. **Звук показа через cord-native.** Поток захвата без `AvSetMmThreadCharacteristics("Pro Audio")` (`audio.rs:188-205`,
   цикл `WaitForSingleObject(event, 10)`) и без приоритета — под нагрузкой игры порции приходят пачками, `Pacer`
   подкладывает тишину (`IDLE_SILENCE_MS 30`) → щелчки/дыры в **звуке показа**. Добавить MMCSS в `capture_thread`,
   а в preload — буфер 2–3 порции перед записью в генератор (метки времени по счётчику уже монотонные). Это про R07/показ, не про трек.
5. **Свой `AudioContext` воспроизведения** (`web/media/session.ts:150`, `latencyHint: 'interactive'`) + Mica
   (`backgroundMaterial`) — не влияет на звук; оставить.
6. **Переустановка сети (VPN) и ICE** — вне оболочки; `net.fetch` каталога не трогает WebRTC.

### Файлы

`W/src/main/index.ts` (ключи, вызовы приоритета во `updateCall`), `W/native/src/win/process.rs` (`set_power_throttling`,
`set_priority`), `W/native/src/lib.rs`, `W/src/native/protocol.ts`/`host.ts` (`process.boost {pids, on}`),
`W/native/src/win/audio.rs` (MMCSS), `W/src/preload/server.ts` (буфер порций), ADR §4.1/§2.1.

### Тесты

- vitest: `boost-plan.test.ts` — какие PID поднимать из подменённого `getAppMetrics()`; `pcm` буфер в preload — чистая функция.
- Rust: `pcm.rs` Pacer уже тестируется; MMCSS — только живой.
- CI Windows: `metrics.json` (`test-installer.ps1 -Metrics`) — добавить «память в покое» без изменений; измерение
  стабильности звука — только на живой машине: `getStats()` зрителя у трека бота (jitter, concealmentEvents) в Edge и
  в Cord на одной сети, 10 минут, до/после ключей и EcoQoS.

### Риски

`ABOVE_NORMAL` для рендерера — Chromium может сбросить при смене видимости; EcoQoS — API Windows 11 (на Win10 — `E_INVALIDARG`, игнорировать).

---

## Сводная таблица

| № | Корень (`путь:строка`) | Решение | Где проверяется |
|---|---|---|---|
| R57 | `windows/main.ts:147-156` всегда `destroy()`; `index.ts:246-252` `onClosed → quit()`; сворачивания в трей нет | `close-policy.ts`: при `tray` — `hide()`; выход из трея/`before-quit`/`session-end` | vitest матрица; e2e «процесс жив»; live: баллон, выключение Windows |
| R58 | `tray.ts:25-29` ищет `build/icon.ico`, которого нет в asar (`electron-builder.yml:11-14`, `copy-shell.mjs:9`) → `createEmpty()` | `src/shell/tray.ico` (16/20/24/32/48 BMP + 256 PNG), `isEmpty()` → запасной PNG → не создавать трей; `check-dist.mjs` | vitest ICO-парсер; CI asar; live DPI/темы |
| R59 | AUMID `'Cord'` (`main.ts:213`) ≠ `tech.cord.desktop` ярлыков; ярлык рабочего стола без AUMID (`installer.nsh:120`); веб не шлёт `notify` | `APP_ID` общая константа; `SetLnkAUMI`; `desktop-notify.ts`: knock/message/join/упоминание, `badge`, `attention`, toast `silent` | vitest политика + yml; CI AUMID ярлыков; live toast |
| R61 | `settings.ts:55` `overlayEnabled: false`, записан явно у всех | default `true` + миграция `settingsRev: 2`; без модуля — не показывать | vitest sanitize/миграция |
| R62–63 | `overlay-policy.ts:18-23`, `overlay.ts`, `input.rs:333-357` — нет exe/borderless/exclusive, нет реестра игр, 10 Гц через main, без аватаров/анимаций | exe из Toolhelp, `SHQueryUserNotificationState`, `games.ts` + известные exe, roster через main + уровни через прямой MessagePort (30 Гц), окно на монитор, 4 угла/размер/имена/прозрачность/lock-клавиша | Rust/vitest матрицы; e2e с `CORD_NATIVE_FAKE`; live: античиты, эксклюзив, DPI |
| R60 | `web/ui/CapturePicker.tsx` без режима/качества; дубль `W/src/shell/picker.*` ru-only (`index.ts:827-867`) | Вкладки Приложения/Весь экран/Устройства, сводка, SD/HD, шестерёнка (режим, звук, mute); дубль удалить; `preferences.screen` | vitest web; e2e web; live: карты захвата |
| R64 | `installer.nsh:20` `$_CLICK` с `"Далее"`, титул «Cord», не DPI-aware bitmap 164×314, `displayLanguageSelector:false` (`yml:66`) | `MUI_LANGDLL_DISPLAY` + реестр, `ManifestDPIAware`, тексты ×8, 2× баннеры, язык → `HKCU\Software\Cord\Language` → `Bootstrap.language` → веб | CI makensis + `test-installer.ps1` скриншоты; live мастер |
| R34 | `main.ts:124` overlay 36 px/138 px; веб без `env(titlebar-area-*)` и `app-region` (`meeting-header.css:8-17`) | токены `--wco-right/--wco-h`, `padding-right`, drag-регион шапок | Playwright web скриншот; live перетаскивание |
| R26 | Electron/cord-native не участвуют; `web/styles.css:51-58` `:focus-visible` + модификатор | расширить `pointer-focus.ts` на все кнопки | vitest web |
| R01–03 (Electron) | нет ключей Chromium (`index.ts`), нет EcoQoS/приоритетов, MMCSS нет (`audio.rs:188`) | ключи, `process.boost` через cord-native во встрече, MMCSS + буфер порций | live `getStats` Edge vs Cord; CI без изменений |

Порядок: R58 → R57 → R59 (AUMID) → R61 → R34 → R64 → R60 → R62/63 → Electron-часть R01–R03. Первые четыре —
один день, низкий риск; R62/63 — самая большая работа (Rust + мост + веб), её стоит вести отдельной веткой
с приёмкой на живой машине с FACEIT.
