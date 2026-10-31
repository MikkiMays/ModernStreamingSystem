# Cord 1.1 — медиа-разбор задач владельца A–G (только чтение)

Снимок кода: `ModernStreamingSystem` main `4667808` (на стенде `cord.nikg.tech` и на `cordcam.ru` тот же `cord-build` 4667808), `ModernStreamingSystem.Windows` main `f58f219` (клиент 1.0.12, Electron 44.9.1), livekit-client 2.22.4, LiveKit SFU 1.13.6.

## 0. Главное за минуту
1. **A.** Камера требует *аппаратный* VP9 (`profiles.ts:381-389`), а кодировщика VP9 в железе нет ни у NVIDIA (NVENC), ни у AMD (VCN/AMF) — только у Intel. AV1 камера не спрашивает. Аппаратный AV1 для WebRTC в Chromium на Windows выключен по умолчанию (`kWebRtcAV1HWEncode` — `FEATURE_DISABLED_BY_DEFAULT` под `IS_WIN`). Electron включает только `force-fieldtrials` RED (`desktop/src/main/index.ts:76-82`). Показ в «Плавности» ставит H.264 первым по замыслу (`profiles.ts:351-367`). Десктоп с 29.10 публикует K-SVC `L3T3_KEY` (`profiles.ts:240,254`, `session.ts:422`), а Media Foundation пространственных слоёв не умеет («MediaFoundation does not support spatial layer encoding», `media_foundation_video_encode_accelerator_win.cc:462`): даже на Intel VP9 уходит в libvpx, сторож видит `cpu` и через ~9 с переходит на H.264 (`encoder-health.ts:33-43`). `powerEfficient` спрашивается без `scalabilityMode` (`profiles.ts:327-336`).
2. На NVIDIA «аппаратный H.264», скорее всего, программный. SFU первым ставит `profile-level-id=42e01f` (порядок `VideoCodecsParameters` в livekit/protocol), а Chromium для CB пропускает NVIDIA (`...encode_accelerator_win.cc:1458-1465`, crbug 1088650) → OpenH264, если нет активного iGPU. `encodingInfo` при этом отвечает `powerEfficient:true`.
3. Что реально есть в железе: H.265 HW — в Chromium WebRTC включён с M136 (`kWebRtcAllowH265Send/Receive` ENABLED; L1T2/L1T3 у H.265 DISABLED), у SFU 1.13.6 `video/h265` входит в кодеки по умолчанию (livekit `pkg/config/config.go:538-548`). AV1 HW (RTX 40+, RX 7000+, Arc/Meteor Lake+) — только в клиенте Windows с `--enable-features=WebRtcAV1HWEncode`.
4. **B.** `@livekit/track-processors` 0.8.2 совместим, но по умолчанию тянет внешние ресурсы → CSP; сегментация на главном потоке.
5. **C.** Значка нет в коде; «не выбирал» шумодав не отличить.
6. **D.** До трёх AudioContext; будится один и только на видимой странице; заглушённый ОС микрофон не перезахватывается.
7. **E.** TURN/TLS только на 5349 на стенде и cordcam.ru (у старого meet — на 443); на стенде не применён Р-34.
8. **F.** Плитка RECOVERING из-за `SignalReconnecting`; кинозал забивает канал Wi-Fi; сторож кодека сбрасывается на каждом переподключении.
9. **G.** Видео — элемент сетки с `height:100%`; портретный кадр → эллипс.
10. R85/R88/R89/R96 закрыть, R99 оставить воротной (§A.10).

## A. Кодеки

### A.1 Что делает код
- **Камера.** `ensureCameraCodec` (`session.ts:852-862`) → `chooseCameraCodec` (`profiles.ts:381-389`): перебор `['vp9','h264']` по `supported&&smooth&&powerEfficient` (`profiles.ts:322-342`), иначе H.264, иначе VP8. AV1 и H.265 не рассматриваются. `encodingInfo` вызывается без `scalabilityMode`. `cameraOptions` (`profiles.ts:241-256`): `backupCodec:{codec:'h264'}` только для VP9/AV1, `maintain-resolution`; десктоп — `L3T3_KEY` (VP9/AV1) или simulcast (H.264); веб и телефон — `L1T3` или один слой. `publishDefaults` = vp8 (`session.ts:503`). `backupCodecPolicy` не задан → по умолчанию `PREFER_REGRESSION` (`options.ts:26-39,448-455`).
- **Показ.** `chooseCodec` (`profiles.ts:351-367`): «Чёткость» AV1→VP9→H.264, «Плавность» (по умолчанию) H.264→AV1→VP9; вызов — `session.ts:1926`; `screenOptions` (`profiles.ts:103-125`).
- **Сторож** (`encoder-health.ts:18-55`, `session.ts:2263-2301`, такт 3 с): 3×`cpu` на VP9/AV1 → H.264 (`fallbackCodec`, `profiles.ts:391-394`), камера переопубликуется (`switchCameraCodec`, `session.ts:2124-2148`); возврат через 4 замера, интервал удваивается, после трёх отступов остаётся H.264. На H.264/VP8 сторож молчит. Один сторож на «ведущую» дорожку (`session.ts:2203-2208`).
- **Чего нет:** GPU-сведений от оболочки (`app.getGPUInfo` нигде не вызывается), ключей Chromium для кодеков, нативного видеозахвата (`desktop/src/main/capture.ts:1-12` — только `getDisplayMedia` и loopback звука), данных о том, что декодируют зрители, метрик кодека отдачи.

### A.2 Почему H.264 на LAN 500 Мбит/с (по убыванию)
Полоса в выборе кодека не участвует.
1. Показ «Плавность» → H.264 по замыслу.
2. Камера на NVIDIA/AMD: VP9-MFT нет → `powerEfficient:false` → H.264.
3. AV1 HW выключен на Windows; в Electron нет Finch и нет ключа.
4. Десктоп + Intel: `L3T3_KEY` не кодируется железом (MF и D3D12 без пространственных слоёв) → libvpx → `cpu` → H.264.
5. `PREFER_REGRESSION`: один зритель без кодека — и всем H.264. Для AV1 это норма: Safari декодирует AV1 только на A17 Pro/M3+.
6. `new EncoderHealth()` на каждом `connected` (`session.ts:2196-2199`, `:1335`): после resume `falls=0`, возврат через 2 замера — кодек прыгает. Важно для F.

Проверка у владельца: «Диагностика» → своя исходящая дорожка: `codec` (`diagnostics.ts:145`) и `encoderImplementation` (`:148-151`); ещё `chrome://gpu` клиента.

### A.3 Факты платформы
| Вопрос | Ответ |
|---|---|
| VP9 HW, Windows | только Intel; L1T1–L1T3; пространственных слоёв нет (`mf_video_encoder_shared_state.cc`, `...encode_accelerator_win.cc:462,1990`) |
| AV1 HW WebRTC, Windows | код есть, `kWebRtcAV1HWEncode` выключен; в Electron — через `--enable-features` |
| H.265 WebRTC | send/receive ENABLED, только аппаратно, один слой |
| H.264 на NVIDIA | для CB пропускается |
| Порядок H.264 у SFU | 42e01f m0/m1 → 640032 → строгие 42001f, 4d001f |
| Кодеки SFU по умолчанию | …VP8, H264, VP9, AV1, H265, RTX; `enabled_codecs` у нас не задан |
| SVC | SFU пересылает слои VP9/AV1 каждому зрителю; livekit-client умеет simulcast VP9/AV1 из слоёв L1T3 (`isSVCSimulcast`, `room/utils.ts:202`) |
| Декодирование | Safari: VP9 ≥16, AV1 только HW, H.265 есть; Firefox: H.265 нет; livekit-client не публикует AV1 из Safari/Firefox (`utils.ts:68-88`) |
| Запасной кодек | только vp8/h264 (`options.ts:433`), по умолчанию — регрессия |
| Electron GPU | `getGPUInfo('complete')` — `gpuDevice[]`, списки профилей кодирования (баг electron#41829 — проверить на 44) |
| Нагрузка ЦП | Compute Pressure (`PressureObserver`) есть в Electron 44 |

### A.4 Дизайн гибкой политики
Модуль `web/src/media/codec-policy.ts` — чистые таблицы и тесты; `profiles.ts` только собирает из них опции.

**Входы:**
1. Платформа: electron / desktop-browser / mobile / telegram.
2. `probeEncoders`: `encodingInfo` для каждого кандидата {av1,h265,vp9,h264} × каждый режим слоёв, который реально публикуем, с теми же размером, fps и битрейтом; кэш по «UA + версия Chromium + GPU»; в Electron плюс мост `app.gpu` как подсказка.
3. Что декодируют зрители: `RTCRtpReceiver.getCapabilities` + `decodingInfo({type:'webrtc'})` → команда ядра → поле участника в RoomState `@JsonInclude(NON_NULL)`. Не атрибуты LiveKit: права на данные участникам не выдаются.
4. Здоровье: `qualityLimitationReason`, частота, время кодирования кадра (Δ`totalEncodeTime`/Δ`framesEncoded`), `encoderImplementation`/`powerEfficientEncoder`, Compute Pressure, `availableOutgoingBitrate`.

**Порядок кодеков:**
- Electron. Камера: AV1 HW (ключ + белый список вендоров) → H.265 HW → VP9 HW → H.264 HW (не-CB) → VP9 SW L1T3 при ≤720p30 и запасе ЦП → H.264. Показ «Плавность»: AV1 HW → H.265 HW → H.264 HW. «Чёткость»: AV1 HW → VP9 HW → AV1/VP9 SW при ≤1080p30 → H.265/H.264 HW.
- Браузер ПК — то же без ключа.
- Телефон — H.264 HW → VP9 HW → VP8, один слой (Р-32).

**Совместимость со зрителями.** Основной кодек — если его декодируют все. Иначе: есть запас по железу → `backupCodecPolicy: SIMULCAST`, нет → следующий по лестнице. Пересчёт при смене состава — не чаще раза в 30 с; видно в диагностике.

**Слои (пересмотр Р-36).** На десктопе — simulcast из L1T3 (каждый слой — отдельная аппаратная сессия; лимит NVENC — 8 сессий); K-SVC — только когда кодирование и так программное и ЦП позволяет. Телефон — один слой.

**H.264 на NVIDIA.** (1) Выбирать H.265/AV1. (2) Проверить, сужается ли H.264 через `room.enabled_codecs` с fmtp 640032/4d001f (livekit `mediaengine.go:86-95`). (3) Без SDP-манипуляций на клиенте.

**Сторож.**
- Не пересоздавать на `connected`.
- Отдельные сторожа для камеры и показа.
- Отступ — по лестнице, а не всегда на H.264. Признаки: `cpu`, или время кодирования > 0,8 бюджета кадра 3 раза подряд, или реализация стала программной.
- На программном H.264 при `cpu` — подсказка стримеру (Р-19), не понижение.
- Каждый отступ — в журнал и в метрику.

**Оболочка.** `appendSwitch('enable-features','WebRtcAV1HWEncode')` под флагом из `config.ts`, одной строкой с прочими фичами; мост `app.gpu` (preload `shell.ts`, `shared/bridge.ts`), флаг возможности `codec.av1hw`.

### A.5 Диагностика и Grafana
- **UI.** Исходящая строка: кодек · профиль (`sdpFmtpLine`) · `scalabilityMode` · HW/SW (`encoderImplementation` + `powerEfficientEncoder`) · мс на кадр · причина выбора · отступы. Входящая: кодек · `decoderImplementation` · `powerEfficientDecoder`. В `callReport` (Р-31) добавить кодек отдачи.
- **Сейчас.** Кодек есть только у приёма в итоге звонка (`call-quality.ts:42-49,96-99`), словами в `meeting_stats.codecs` (`V12__meeting_quality.sql`, `ClientQuality.java:72-110`); `cord.client.*` (`ClientQuality.java:124-145`) кодека не знают; на дашбордах кодеков нет.
- **Предложение.** tx-блок в 10-секундной сводке `rooms/{id}/quality` (`rx-quality.ts`, `RxQuality.java`); счётчики `cord_client_publish_seconds_total{source,codec,hw}`, `cord_client_codec_switch_total{source,from,to,reason}`, `cord_client_tx_limited_seconds_total{source,reason}`; панели в `cord-media.json`. Мониторинг на стенде не поднят (нет VM/Grafana в `docker ps`).

### A.6 Файлы
- **web:** `codec-policy.ts`(+test), `profiles.ts`, `encoder-health.ts`, `session.ts`, `decode-caps.ts`, `core/meeting.ts`, `core/desktop.ts`, `diagnostics.ts` + UI, `call-quality.ts`, `rx-quality.ts`, `docs/frontend.md:343,365` (устарело).
- **desktop:** `main/index.ts`, `main/config.ts`, `preload/shell.ts`, `shared/bridge.ts`, ADR 0001.
- **core:** `Contracts.COMMAND_TYPES`, `RoomService`, `ClientQuality`, `RxQuality`.
- **infra:** `cord-media.json` (`dashboards.mjs`), при необходимости `configure.mjs` (`enabled_codecs`).

### A.7 Риски
- Не нарушить X10/Р-19: смена кодека допустима, только пока разрешение и fps прежние.
- Не нарушить Р-32 и Р-33.
- AV1 HW на Windows: драйверы → флаг, белый список, отступ по `encoderImplementation`.
- H.265 не декодируют Firefox и часть Linux → политика запасного.
- Лимит сессий NVENC; переопубликации — не чаще раза в 30 с.
- e2e на fake-устройствах — всё программное; конкретный кодек в тестах не ждать.

### A.8 Тесты
- **vitest:** `codec-policy.test.ts` — NVIDIA → h265; RTX40 + ключ → av1; Intel → vp9; зритель без h265 → simulcast h264; Safari + AV1 → без регрессии всем; телефон → один слой; `powerEfficient` спрашивается с тем же `scalabilityMode`. `encoder-health.test.ts` — переподключение не сбрасывает; время кадра → отступ; SW H.264 + cpu → подсказка.
- **e2e:** `codec-policy.spec.ts` с подменой `encodingInfo` и `getCapabilities`.
- **Вживую (это и есть ворота R88/R89/R99):** NVIDIA 20/30/40, AMD RDNA2/3, Intel — 10 мин камера 720p30 и показ 1080p60: реализация HW, fps ≥ 0,9 выбранного, `none`, кодирование < 8 мс/кадр, ЦП < 15 %. Плюс зонд «Проверить кодеки» в «Диагностике» с выгрузкой в обращение.

### A.9 Размер
L; нужен релиз Windows; Android не нужен; H.265 и правильный выбор в браузере работают и без оболочки.

### A.10 R85, R88, R89, R96, R99 (`STATUS.md:91,94,95,102,105`)
- **R88, R89 — закрыть:** корни из §9.1 MEDIA-DIAGNOSIS устранены; живой замер переходит в A.8.
- **R96 — закрыть и заменить новой задачей кодеков + Р-37** (отменяет «H.264 HW в Electron» из Р-20, уточняет Р-36; Р-36 в DECISIONS.md отсутствует, хотя 7ca35f0/3f0b8f4 на него ссылаются, а 7ca35f0 писал «НЕ в main»).
- **R85 — закрыть как зонтичную.**
- **R99 — оставить воротной:** если после H.265/AV1 HW Electron/WGC держит 1080p60 — закрыть; иначе этап 2 §9.3 (Go + ffmpeg ddagrab/NVENC) после 1.1.

## B. Фон
- **Сейчас** обработки видео нет. Точки встраивания: `setProcessor`, `CameraPreview.tsx`, `Prejoin.tsx:253,556` (`previewConstraints`, `profiles.ts:162-165`), `CameraMenu.tsx`, `VideoSection.tsx`.
- **Библиотека** 0.8.2, peer `^1.12.0||^2.1.0`, mediapipe 0.10.14. API: `BackgroundProcessor({mode, blurRadius, imagePath, assetPaths:{tasksVisionFileSet, modelAssetPath}, onFrameProcessed})`, `switchTo()` на лету, `supportsBackgroundProcessors`/`supportsModernBackgroundProcessors`.
- **Внешние ресурсы по умолчанию:** jsdelivr wasm и googleapis `selfie_segmenter.tflite`, delegate GPU (`BackgroundTransformer.ts:63-72`). CSP `Caddyfile:25` закроет. Self-host: wasm в `web/public/mediapipe/wasm`, модель (~250 КБ, Apache-2.0) + THIRD-PARTY. CSP уже подходит (`wasm-unsafe-eval`, `worker-src blob:`).
- **Пути кадров:** MSTP + WebGL2 (Chrome, Edge, Electron, Android Chrome); Safari — `captureStream` с тикером-воркером, `maxFps` 30 (`ProcessorWrapper.ts:99,380`). `segmentForVideo` синхронная на главном потоке (`BackgroundTransformer.ts:173`).
- **Дизайн:** модуль `media/background-effect.ts`; пресеты off / blur-light 6 / blur-strong 14 / 6–8 встроенных фонов (`public/backgrounds/*.webp` 1280×720) / своё фото (уменьшить до 1280×720 → IndexedDB, `blob:`).
  - Выбор — в `preferences.camera.background`; применяется при включении камеры, `restoreTracks` и `switchCameraCodec`.
  - UI: меню камеры, «Видео» с превью эффекта, предвход.
  - Платформы: ПК — полностью; Android — только размытие при поддержке MSTP; iOS — выключено; Telegram — выключено.
  - 60 fps при эффекте 30 — сказать явно; сегментировать каждый второй кадр.
  - Нагрузка эффекта > 0,7 бюджета кадра → сначала облегчить эффект, а не отступать кодеком; строка в диагностике.
- **Файлы:** web `package.json` (lock — по `cord-npm-lockfile-wasm`), скрипт копирования wasm, `background-effect.ts`, `session.ts`, `preferences.ts`, `CameraMenu.tsx`, `VideoSection.tsx`, `CameraPreview.tsx`, `Prejoin.tsx`, локали ×8; infra — только MIME/кэш для wasm, `csp-check.sh`.
- **Риски:** главный поток, нагрев, ~9 МБ wasm (грузить лениво), e2e с fake-камерой. Не сломать переворот, зум R36, фронтальную Р-35, зеркало.
- **Тесты:** vitest пресетов и отказа; e2e `background.spec.ts` (кадры у зрителя, размер прежний, нет нарушений CSP); живой замер на ноутбуке.
- **Размер** M–L, только веб.

## C. Значок микрофона и шумодав
**C.1. Значка нет в коде.**
- Оверлей: `mic-off` на тёмной подложке, угол `tl` (`overlay.js:39-42`, `overlay.css:126-139`, `app-settings.ts:46`).
- Мини-окно: правый нижний угол (`mini.ts:349-355`), кнопка серая (`mini.css:138`).
- В WinUI тоже нет.
- Кандидаты: (1) не Cord — NVIDIA App, Windows Voice Access, утилиты клавиатуры, индикатор приватности Android; (2) авто-PiP Chrome (`enterpictureinpicture`, `system-controls.ts:16-80`); (3) свой аватар в оверлее, если виджет перенесён вправо.
- Нужен скриншот. Выключатель по итогам: (2) — настройка «Сворачивать в окно» (не регистрировать действие); (3) — «Показывать себя в оверлее» (`overlay.self` + фильтр в `useDesktopOverlay.ts`, релиз клиента); (1) — подсказка в «Поддержке».

**C.2. Шумодав.**
- Сейчас: rnnoise = «Усиленное»; `NoiseRow` (`media-fields.tsx:113-142`); умолчание `browser` (`preferences.ts:29-40,191-196`); `localStorage['cord:preferences:v1']`, свой у клиента Windows тоже; `savePreferences` пишет весь объект (`:245-257`).
- Дизайн: метка `audio.suppressionChosen`, ставится только в `NoiseRow.onValueChange` (`:138`).
- Чтение: выбрано и значение валидно → оно; иначе `rnnoise`, если есть AudioWorklet и WASM, иначе `browser`.
- Миграция: запись, равная старому умолчанию целиком (browser, true, true, 1), — «не выбирал» → rnnoise; любое отличие — «выбирал». Цену записать в DECISIONS.
- Включать всем только вместе с D (до этого — rnnoise на ПК, browser на телефоне).
- Предзагружать wasm при входе во встречу (`audio.ts:97-106`).
- e2e-фикстуры ставят `off`: fake-тон режется как шум.
- Тесты: новый профиль, нет AudioWorklet, старое умолчание, gain 1,4, «Стандартное» после релиза.
- Размер S, веб.

## D. Android: микрофон в фоне
**D.1. Что сейчас.**
- Контекст встречи без `sampleRate` (`session.ts:169-180,295,492`). `AudioWaker` будит только его и только на видимой странице (`background.ts:405-437`, `:422-426`); `cameBack` будит только при `connected` (`session.ts:1175-1193`).
- Процессор заводит свой 48-кГц контекст, если частота ≠ 48 кГц (`audio.ts:82-86`; Android 44,1 / BT 16 кГц). Его не будит никто → отправитель шлёт тишину, а сырой трек «жив».
- Третий контекст — `levels.ts:369`.
- `holdMicrophone` без процессора (`session.ts:1257-1287`), процессор ставится при включении (`:1537`).
- LiveKit: `pauseUpstream` через 5 с после `mute`; при возвращении перезахват, только если `!isMuted` (`LocalTrack.ts:436-446`); `unmute` перезахватывает только `ended` (`LocalAudioTrack.ts:76-85`).
- Chrome держит FGS `camera|microphone`.
- Приложение: FGS microphone (`CallService.java`), PiP (`MainActivity.java`), Capacitor `KeepRunning=true`. Нет `ACCESS_NETWORK_STATE` (`AndroidManifest.xml:48-56`) → `navigator.connection` change (`session.ts:586`) не приходит.

**D.2. Причины.**
1. Контекст встал и не поднят (признаки: `media-source.audioLevel≈0`, `state≠running`).
2. ОС заглушила захват (`muted`), а `unmute` на живом треке не перезахватил.
3. `pauseUpstream` без `unmute`, а у удержанного микрофона выхода нет.
4. Погашенный экран — известная жалоба Chrome; надёжный путь — приложение.

**D.3. Исправление.**
1. Один контекст `sampleRate:48000` на встречу; процессор и измеритель — на нём.
2. На Android будить и в фоне (iOS — только на видимой странице, там `resume` без жеста виснет), плюс таймер 2 с.
3. Сторож отдачи `mic-sentinel.ts`: сырой `ended`/`muted` > 2 с на видимой странице → `restartTrack`; сырой громкий, а энергия отправки 0 три раза → разбудить контекст, не помогло — `replaceTrack(raw)` и плашка «шумодав временно выключен».
4. Перед включением микрофона — `restartTrack`, если трек `muted` или не `live`.
5. Позже — MSTP/MSTG в воркере для Android.
6. Android: `ACCESS_NETWORK_STATE`; проверить 10 мин с погашенным экраном.

**D.4.**
- Файлы: web `session.ts`, `background.ts`, `audio.ts`, `levels.ts`, `mic-sentinel.ts`, `BackgroundNote.tsx`; Android — манифест.
- Риски: iOS, BT 16 кГц, перезахват в фоне запрещён, эхо при обходе.
- Тесты: vitest sentinel/waker/audio; ручной протокол на двух Android (Chrome и приложение: Telegram-голосовое, GSM-звонок, экран 10 мин, BT).
- Размер: M + S Android (новая APK).

## E. VPN
**E.1. Что сейчас.**
- `configure.mjs:238-247`; стенд: `tls_port 5349`, `external_tls:false`.
- Edge: :443, ALPN только `http/1.1` → 8091.
- UFW: 443, 7881, 7882/udp, 3478/udp, 5349 открыты.
- `cordcam.ru` — сервер по умолчанию в каталоге (`.local/catalog/servers.source.json`, `ru-msk default:true`; `de-fra` = cord.nikg.tech). Проба: 443, 5349, 7881 открыты; на 5349 — свой сертификат LE `CN=cordcam.ru`. Тот же доменный режим, без TURN на 443.
- `meet.nikg.tech`: strict, `turns:turn.nikg.tech:443` проверен (`deployment-meet-nikg-tech.md:23,58`).
- Р-34: ключ в `configure.mjs:217-224` с 27.10 (cba4331), но `infra/generated/livekit.json` от 26.10 08:45 без него; SFU перезапущен 29.10 09:30 → действует старое умолчание `true`. cordcam проверить.

**E.2. Причины.**
1. Нет TURN/TLS 443 → в сетях и VPN, где открыт лишь TCP 443, сигнал есть, медиа нет. Приложения по умолчанию смотрят на cordcam, браузер «работал» на meet.
2. WebView без `ACCESS_NETWORK_STATE` — смена VPN не видна.
3. Дрейф Р-34 → медиа «прилипает» к TCP.
4. MTU туннеля 1280 — на грани.
5. Раздельное туннелирование geoip:ru.

**E.3. Исправление.**
- TURN/TLS 443 через `external_tls:true`: (а) имя `turn.<домен>` + SNI на edge (strict-режим уже есть); (б) одно имя с разбором по содержимому в caddy-l4 (`http` → шлюз, иначе → TURN).
- Р-34 сохраняется: relay используется, только когда UDP закрыт, `path-retry` вернёт на UDP.
- ALPN `h2` на edge.
- `ACCESS_NETWORK_STATE`.
- Понятная ошибка ICE и счётчик `cord_joins_total{result="ice_failed"}`.
- Перевыпустить `livekit.json` на стенде и cordcam; в `update.sh` — сверка ключей.

**E.4.**
- Файлы: `configure.mjs`, `edge-config.mjs`, `turn-cert.mjs`, `update.sh`, DNS в OWNER-ACTIONS; Android-манифест; веб-ошибка.
- Риски: ЦП хоста на TLS; автообновление сертификата `turn.`; A12 не трогать.
- Тесты: `configure.test.mjs`, `turn-relay-check.sh`; relay-only браузер на `turns:…:443`; телефон с WireGuard/VLESS без UDP; приложение со сменой VPN.
- Размер: M + S Android (APK) + S веб.

## F. ivi и вебки на Wi-Fi
**F.1. Откуда статус.**
- `stage.recovering` при RECOVERING (`Stage.tsx:313,408`); свой баннер (`MeetingView.tsx:340-349`).
- RECOVERING ставят: `media.lost` (`RoomService.java:1477-1484`), `participant_left` (`MediaService.java:104-108`), сверка раз в 2 с (`MediaReconciler.java:47-87` → `MediaService.java:173-177`).
- `lost` висит на `Reconnecting` и `SignalReconnecting` (`session.ts:507-508`, `:1271-1310`); сюда же собственный `nudge` (`:1135-1153`).
- Кинозал проксирует сервер; hls.js: 30/60 с, `capLevelToPlayerSize:false`, старт 2,5 Мбит/с (`hls.ts:50-95`); edge — HTTP/1.1.

**F.2. Причины.**
1. HLS забивает Wi-Fi → `bandwidth` → ICE restart через 45 с (`path-retry.ts:59-66`); SFU ставит видео на паузу (`session.ts:1067`): у камер одним слоем нечем уступить, у H.264 нет временных слоёв.
2. Сигнал опаздывает → `SignalReconnecting` → `media.lost` → плитка у всех.
3. Хост: 4 vCPU, steal, soft lockup (`ENV-cord.nikg.tech.md:12,44-46`) + yt-dlp + Python-прокси.
4. Дребезг кодека с переопубликацией + сброс сторожа.
5. Главный поток — маловероятно.

**F.3. Исправление.**
- HLS в звонке: `capLevelToPlayerSize:true`, буфер 12/30 с, ABR-множители 0,8/0,6, потолок = оценка канала − резерв звонка; на сервере — темп отдачи сегментов (token bucket ≈1,5× битрейта уровня).
- `SignalReconnecting` при идущем медиа не считать потерей (`audioFlowing`, `lastInboundBytes`, `session.ts:449-455`).
- Сторож без сброса, отступ не чаще раза в 60 с.
- Simulcast L1T3 на десктопе.
- Причина паузы в UI; журнал событий в отчёт о звонке; h2 на edge.

**F.4.**
- Файлы: web `hls.ts`, `session.ts`, `encoder-health.ts`, плашка паузы; services — прокси сегментов; infra — `edge-config.mjs`.
- Тесты: vitest; pytest на темп прокси; e2e `cinema-call.spec.ts` с CDP-сжатием канала (`freezeCount` ≤ 1/мин, без RECOVERING); вживую — ноутбук на Wi-Fi + ПК по кабелю, ivi с cordcam.
- Размер M.

## G. Овальные вебки
**Причина.** Лицо — грид-контейнер (`place-items:center`), видео в нём `height:100%`:
- покер `.poker-face` / `.poker-camera` (`poker.css:500-536`, без overflow) → эллипс торчит;
- дурак `aspect-ratio:1` (`durak.css:533-563`, `:1403-1406,1462-1464`) → лицо само становится овальным;
- `GamePerson` (`game-people.css:23-46`, overflow hidden) → кадр смещён вверх.

Портретный кадр даёт вклад в высоту трека 1,78·W, ландшафтный — 0,56·W, поэтому ломается только камера с телефона.

**Исправление:**
```css
.poker-camera { position:absolute; inset:0; width:100%; height:100%; border-radius:50%; object-fit:cover; }
& .durak-seat-face video { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; border-radius:inherit; }
.game-person-face video { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
```
- У контейнеров уже `position:relative`; `overflow` у покера и дурака не добавлять — снаружи кольцо хода и лучи.
- Желательно `object-position:50% 35%`.
- Три компонента (`GamePeople.tsx:13-43`, `PokerTable.tsx:1043-1071`, `DurakTable.tsx:1046-1067`) свести в один `ui/SeatVideo.tsx`.

**Тест:** Playwright с портретной поддельной камерой (`web/scripts/phone-camera-probe.mjs`) за покером, дураком и шахматами → `|w−h|<1px`; снимки 390/1280/2560. **Размер** S.

## Попутно
- Р-36 нет в DECISIONS.md.
- Конфиг SFU стенда отстал от `configure.mjs`.
- `docs/frontend.md:343,365` устарел.
- Мониторинг на стенде не поднят.
- Секреты из `livekit.json` не переносились.
- Тарбол `@livekit/track-processors` для чтения исходников распакован в `/tmp/claude-0/-root/62072dd2-7b68-4366-9d80-203cf6aec2c4/scratchpad/tp/`, исходники Chromium и LiveKit — в `.../scratchpad/cr/` и `.../scratchpad/lk/`.