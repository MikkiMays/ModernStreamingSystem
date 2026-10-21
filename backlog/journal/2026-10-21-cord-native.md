# 2026-10-21 — E01-B3 «cord-native» (T10 T23 T27 T43)

Ветки: `epic/E01-B3-native` в `ModernStreamingSystem.Windows` (код — `desktop/native`, `desktop/src`),
`epic/E01-B3-journal` в ядре (только этот журнал). Исполнитель — Fable 5.1, один агент, без пуша.
Основа — ADR 0001 §4.1, §4.2, §4.3, §4.6, §9, §10, журналы E01-B и E01-B2 («Осталось» п. 1), В-2, В-6.

## Что сделано (коммит после каждой вехи)

1. **Крейт `cord-native` (Rust, napi-rs 3, windows 0.62)** — `desktop/native/`.
   - Чистая логика на любой платформе: `keys.rs` (имена DOM и `Mouse3`–`Mouse5` ↔ VK), `matcher.rs`
     (машина состояний сочетаний: модификаторы точно, без автоповтора, отпускание по клавише, по
     модификатору и по опросу состояния клавиш — страховка от залипшего push-to-talk под UIPI),
     `pcm.rs` (порции 10 мс × 480 кадров, тишина по часам, пока приложение молчит), `foreground.rs`
     («во весь экран» без рабочего стола, дерево процессов без колец, события только при смене).
     19 тестов `cargo test`.
   - Windows (`src/win/`): `input.rs` — скрытое окно в своём потоке, `RegisterRawInputDevices` с
     `RIDEV_INPUTSINK` (клавиатура и мышь), таймеры 300 мс (переднее окно) и 50 мс
     (`GetAsyncKeyState` при удержании); `audio.rs` — `ActivateAudioInterfaceAsync` +
     `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` (include/exclude дерева процессов), float32
     48 кГц стерео, `AUDCLNT_STREAMFLAGS_LOOPBACK | EVENTCALLBACK`, поток на сеанс, COM MTA;
     `process.rs` — PID по HWND и карта родителей через Toolhelp (без `OpenProcess`).
   - Поверхность: `startInput/setBindings/stopInput`, `watchForeground/stopForeground`,
     `startAudio/stopAudio`, `windowProcess`, `currentProcess`, `platformSupported`, `version`.
     Не Windows — заглушки с отказом; оболочка модуль и не грузит.
2. **Хост и клиент** — `src/native/protocol.ts` (запросы с номерами, события, порт PCM), `src/native/host.ts`
   (utility-процесс: грузит `.node` по `CORD_NATIVE_MODULE`, `CORD_NATIVE_FAKE=1` — подмена с тоном 440 Гц для
   дымового прогона без Windows), `src/main/native/client.ts` (`ready`, `whenReady(3 с)`, таймаут ответа 5 с,
   падение → `ready {available: false}`, перезапуск через 2 с не чаще трёх раз за 10 минут).
3. **Клавиши (T27)** — `hotkeys.ts`: два бэкенда. Raw Input — любая клавиша, `Mouse3`–`Mouse5`, фазы
   `down`/`up` → `hotkey {action, phase}`; строка `STATUS_GLOBAL_RAW` (про отпускание и игру от администратора).
   Модуль упал — набор переезжает на `globalShortcut`, вернулся — обратно, веб получает `hotkeys.status`.
   `messages.ts` принимает `Mouse[3-5]`.
4. **Звук захвата (T10/T43)** — `capture.ts nativeAudioFor`: `app` → дерево процессов окна
   (`window:<hwnd>:0` → PID в хосте), `system-except-cord` → всё, кроме дерева Cord (`process.pid`),
   `app` для экрана и без модуля → `capture.audio {state: 'failed', reason}`. `index.ts`: после
   `callback({video})` main создаёт `MessageChannelMain`, порт 1 — хосту с `audio.start`, порт 2 — preload
   главного окна (`cord:capture-audio`). `preload/server.ts`: порт → `AudioData` → `MediaStreamTrackGenerator`
   → скрытый `<audio id="cord-desktop-capture-audio" muted>`; страница читает `srcObject` того же элемента
   (DOM общий для миров, объект потока один — проверено пробой в Electron 44 под Xvfb: `instanceof
   MediaStream`, дорожка `live`, пик 0,2 в `AnalyserNode`); событие `capture.audio`, новый подписчик получает
   состояние сразу; `track.stop()` страницей → preload сообщает main → захват гаснет. Прямой `postMessage`
   с дорожкой между мирами Chromium не поддерживает (проверено) — отсюда элемент. AudioWorklet в вебе не
   нужен: CSP сервера не пустил бы модуль воркера.
   Окно выбора оболочки (`picker.html/js`): «Без звука» / «Звук системы» / «Звук приложения» (только для окна) /
   «Система кроме Cord», подсказки по режиму; `capture.sources` отдаёт `appAudio`.
5. **Оверлей (T23)** — `overlay-policy.ts decideOverlay`: виден в звонке, если включён, впереди не Cord и окно во
   весь монитор — в углу этого монитора (`OverlayWindow.placeAt`: физическая точка → `screenToDipPoint` →
   `getDisplayNearestPoint`); без модуля — как раньше, на дисплее главного окна.
6. **Сборка и CI** — `scripts/build-native.mjs` (`cargo build --release` → `dist/native/cord-native.win32-x64-msvc.node`,
   без `@napi-rs/cli`), `electron-builder.yml asarUnpack`, `desktop.yml`: `rustup` по `native/rust-toolchain.toml`
   (1.99.1), кэш `actions/cache@v4.2.3` (SHA проверен), `npm run test:native`, `npm run build:native`, проверка
   файла в dist; `test-installer.ps1`: файл в `app.asar.unpacked` и строка «native: загружен» в журнале
   установленного Cord. Дымовой прогон: флаги `ptt`/`capture.app-audio` (Windows — настоящий модуль), на
   Linux — вся дорога звука с подменой (выбор → `getDisplayMedia` → порт → дорожка → тон → `ended`).
7. **Версия 1.0.2**, `docs/releases/desktop-1.0.2.md`, ADR 0001 — как собрано (§3.3, §4.1, §4.2, §4.3, §4.6, §9).
   Попутно (E15-B): заставка обновления под `prefers-reduced-motion` — полоса не ездит, при загрузке растёт
   скачками, процент в строке.

## Как устроено (коротко)

main `Shell` → `NativeClient.start()` при старте, `whenReady(3 с)` перед bootstrap (флаги зависят от модуля) →
`utilityProcess.fork(dist/native/host.js)` → хост `require(.node)` → `ready`. События хоста: `hotkey` →
`HotkeyRegistry.onRawEvent` → `router.post('hotkey', {action, phase})`; `foreground` → `decideOverlay` →
`OverlayWindow`; `audio ended/error` → `capture.audio` странице. `featuresFor(platform, native)`.

## Проверки (exit-коды)

- `native`: `cargo check -j 1` (Linux) — 0; `cargo test -j 1` — 19 тестов, 0;
  `cargo check -j 1 --target x86_64-pc-windows-msvc` — 0, без предупреждений (Win32-часть сверена с типами
  крейта `windows` 0.62.2 без линковки; по пути нашлись два промаха — признак `Win32_Security` для `CreateEventW`
  и `windows-core` напрямую для `#[implement]`). Саму `.dll` собирает только Windows CI.
- `desktop`: `npx tsc -p tsconfig.json --noEmit` — 0; `npx tsc -p tsconfig.test.json` — 0; `npx vitest run` —
  12 файлов, 94 теста, 0; `npm run build` — 0.
- Дымовой прогон под Xvfb против стенда с `CORD_NATIVE_FAKE=1`: `1 passed` за 25 с, код 0. Мост объявил `ptt` и
  `capture.app-audio`; дорога звука: `capture.select` → `getDisplayMedia` (экран Xvfb) → `capture.audio ready`
  → дорожка `live` в элементе → пик 0,22 в `AnalyserNode` → `track.stop()` → `ended`, элемент убран.
- Проба межмировой передачи (до реализации, `.local/probe`): `postMessage` с `MediaStreamTrack` между мирами
  Chromium не принимает («does not have a transferable type»), `srcObject` общего элемента — принимает.

## Что подтверждает только Windows CI или живая машина

- Сборка `.node` (`cargo build --release` на `windows-2022`), загрузка в utility-процессе, флаги в дымовом
  прогоне, файл и строка журнала в `test-installer.ps1`.
- Raw Input поверх игр, отпускание, кнопки мыши, UIPI; process loopback на живом звуке (раннер без звуковых
  устройств может вернуть `failed` — это ожидаемо и видно в журнале); оверлей на мониторе игры, FACEIT.
- `restrictOwnAudio` у `loopback` в Electron 44 (если работает — «кроме Cord» без своего кода остаётся запасным).

## Что остаётся вебу (ядро, `core/desktop-capture.ts`, `ui/CapturePicker.tsx`, `media/session.ts`)

1. Окно выбора E16: режимы `app` (для окна) и `system-except-cord` при флаге `capture.app-audio`.
2. После `getDisplayMedia` при этих режимах — `on('capture.audio')`: `ready` → дорожка из
   `document.getElementById('cord-desktop-capture-audio').srcObject.getAudioTracks()[0]` → `publishTrack`
   как `ScreenShareAudio` (рядом с видео; `ownAudioLeaks` для неё не считать); `failed` — подсказка «показ без
   звука»; при остановке показа — `track.stop()`.
3. Push-to-talk: `hotkeys.configure` с `{action: 'ptt', mode: 'hold'}` при флаге `ptt`; `hotkey {action:'ptt',
   phase}` → микрофон на время удержания; запись кнопок мыши (`Mouse3`–`Mouse5`) в `HotkeyField`; подсказка про
   игру от администратора — из `hotkeys.status`.

## Осталось

1. Веб — п. выше (другой агент, ядро).
2. `net` в `cord-native` (`NotifyAddrChange`) — не нужен, пока веб не просит `network.changed`.
3. Цифры ADR §10 на машине владельца: задержка клавиши `SendInput → hotkey` (≤ 30 мс) и звук приложения в
   звонке двух клиентов.
