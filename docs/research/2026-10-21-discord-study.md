# Как это делает Discord — и что из этого ставим в Cord

Архитектор-исследователь, 21.10.2026. Задачи R66/X6 волны «Ревью 1.0.3» (`backlog/review-1.0.3/TASKS.md`).
Сверено с кодом `main` ядра (`web/src/media/*`, `services/publisher/main.go`, `scripts/configure.mjs`) и
клиента (`W/desktop/src/main/*`, `W/docs/adr/0001-electron-shell.md`). Референсы Discord — скрины
`backlog/refs/img/review-1.0.3/r103-02…06, 21…29`. Код не менялся; здесь — решения и их привязка к
R-номерам и файлам. Числа — с обоснованием; где число не измерено, так и написано.

## 0. Главное за минуту

1. **Звук «обрывается» не из-за одного дефекта.** Три слоя: хост замирает (71 soft lockup/сутки, R10) →
   SFU и издатель молчат по 20–35 с, этого не пережить никаким буфером; издатель шлёт тишину, когда у
   него нет кадров (R09: «1 Кбит/с» на дорожке музыки — это и есть кодированная тишина Opus, не пустая
   статистика); потери 6 % на UDP без защиты для стерео (RED у LiveKit только для моно). Лечится по
   слоям: разнос SFU от стенда, сторож издателя, **RED на SFU для музыки** (`audio.active_red_encoding`).
2. **Discord переживает отказ голосового сервера переназначением**: сервер выпадает из service discovery,
   клиент сам переподключается к новому; «куратор» шлёт синтетический голосовой трафик на каждый сервер и
   выводит больные. У нас один узел — переносим **куратора** (зонд-участник с эталонным тоном) и
   **дренаж** (обновление SFU только при пустых комнатах), а не второй SFU.
3. **Превью демонстрации у Discord — периодический снимок, который загружает сам стример**
   (`POST /streams/{key}/preview`, base64 JPEG), не видео для всех. У нас так уже написано
   (`web/src/media/screen-preview.ts`, 256×144 JPEG раз в 10 с по каналу данных) — «зелёный фон» это дефект
   захвата кадра, не архитектуры (§2).
4. **Синхронность кинозала у нас уже лучше Syncplay и CyTube** (0,19 с измерено против их порогов 1–4 с),
   Jellyfin точнее по порогу (60 мс), но тем же методом. Для музыки «одна секунда» — это разброс буферов
   приёма: потолок музыки опускаем 2500 → 1500 мс, показываем расхождение в диагностике.
5. **Krisp для Discord бесплатен, для нас — нет**: SDK только через продажи, LiveKit даёт Krisp лишь в
   Cloud. RNNoise оставляем, добавляем DeepFilterNet3 (MIT/Apache-2, WASM) как «усиленное» в Electron.
6. **Новый оверлей Discord (2025) — вне процесса игры, виджеты, нужен безрамочный режим.** Ровно наша
   схема (ADR §4.3). Делаем: включён по умолчанию, список игр по exe с переключателями, виджет голоса,
   быстрые действия, замок оверлея по клавише.
7. **Три дефекта Electron найдены в коде**: закрытие уничтожает окно (R57); иконка трея — `build/icon.ico`
   не попадает в пакет, а `dist/shell/icon.ico` нет, `createEmpty()` → прозрачная (R58); AUMID `Cord` ≠
   `appId` `tech.cord.desktop` на ярлыке NSIS (R59).

## 1. Источники

| # | Источник | URL | Что взяли |
| --- | --- | --- | --- |
| 1 | Discord, «How Discord Handles 2.5M Concurrent Voice Users using WebRTC» (2018) | https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc | Elixir-сигналинг, SFU на C++, выбор сервера по нагрузке через etcd, отказ = выпадение из discovery + переподключение клиента, тишина не передаётся, RTCP на SFU решает полосу видео, 850 серверов / 13 регионов |
| 2 | Discord, «We care about your voice» (2016) | https://discord.com/blog/we-care-about-your-voice-engineering-special | «Куратор»: синтетические голосовые пакеты на каждый сервер, вывод больных, ручной blacklist, **draining** для обновлений без простоя; быстрый resume при смене сети |
| 3 | Discord, «Meet DAVE: E2EE for audio & video» (2024) | https://discord.com/blog/meet-dave-e2ee-for-audio-video | Текущий медиаконвейер: WebRTC, encoded transform, MLS через voice gateway, цель «time-to-media — сотни мс» |
| 4 | Discord, «Player release Q1 2025» | https://discord.com/blog/player-release-q12025 | Новый оверлей: без инъекции, виджеты, action bar, стримы друзей в оверлее, античиты |
| 5 | Discord, «How Discord Scaled Elixir to 5M» | https://discord.com/blog/how-discord-scaled-elixir-to-5-000-000-concurrent-users | Изоляция процессов, Manifold, FastGlobal, **Semaphore** — backpressure вместо каскада |
| 6 | Discord, «How Discord Stores Trillions of Messages» | https://discord.com/blog/how-discord-stores-trillions-of-messages | Data services на Rust, request coalescing, горячие партиции |
| 7 | Discord Support, «Krisp FAQ» | https://support.discord.com/hc/en-us/articles/360040843952 (ru: …/hc/ru/articles/360040843952) | Krisp бесплатен в Discord, работает на устройстве, по умолчанию выключен, есть в десктопе/браузере/мобильном |
| 8 | Discord Support, «Go Live / Screen share» | https://support.discord.com/hc/articles/360040816151 | 720p30 бесплатно, 1080p60 с Nitro, до 50 зрителей, превью стрима до входа, «скрыть превью» |
| 9 | Discord API, список определяемых игр | https://discord.com/api/applications/detectable | 24 780 записей: `executables[{name, os, is_launcher}]`, `hook`, `overlay`, `overlay_methods`, `overlay_warn` — модель «Зарегистрированных игр» |
| 10 | Неофициальная документация API Discord (fluxer) | https://fluxer.js.org/rest/upload_stream_preview/ | `POST /streams/{stream_key}/preview {channel_id, thumbnail: base64}` — превью стрима загружает клиент |
| 11 | NVIDIA, Discord AV1 | https://www.nvidia.com/en-us/geforce/news/nvidia-studio-discord-av1/ | 4K60 при 8 Мбит/с на AV1 (Nitro, RTX 40); автоматический откат на H.264, если зритель не декодирует |
| 12 | LiveKit docs, «Tracks: advanced» | https://docs.livekit.io/home/client/tracks/advanced/ | RED, DTX, `AudioPresets.musicHighQualityStereo`, стерео до 510 кбит/с, dynacast, simulcast |
| 13 | LiveKit docs, «Playout delay» | https://docs.livekit.io/robotics/media/performance/low-latency/playout-delay/ | Комнатный `playout_delay` min/max — **только видео**, шаг 10 мс, рекомендация 400–2000 мс для «плавно» |
| 14 | LiveKit docs, «Receiving tracks» | https://docs.livekit.io/home/client/receive/ | adaptiveStream по размеру и видимости, `setVideoQuality`, `autoSubscribe:false`, enable/disable без переговоров |
| 15 | LiveKit docs, «Noise cancellation» | https://docs.livekit.io/home/cloud/noise-cancellation/ | Krisp NC / ai-coustics **только в LiveKit Cloud**; self-hosted — лишь WebRTC NS |
| 16 | LiveKit server, `config-sample.yaml` | https://github.com/livekit/livekit/blob/master/config-sample.yaml | `congestion_control` (пауза дорожек), `packet_buffer_size_audio/video` 200/500, `pli_throttle`, `allow_tcp_fallback`, `audio.active_red_encoding`, `room.playout_delay`, `sync_streams` |
| 17 | LiveKit server, `pkg/sfu/redreceiver.go` | https://github.com/livekit/livekit/blob/master/pkg/sfu/redreceiver.go | SFU сам кодирует RED (до 2 избыточных блоков ≤ 1 КиБ) для Opus-дорожки без RED — Chrome/native подписчикам |
| 18 | livekit-client, `src/room/track/options.ts` | https://github.com/livekit/client-sdk-js/blob/main/src/room/track/options.ts | `AudioPresets` 12/24/48/64/96/128 кбит/с; `red`, `dtx` по умолчанию **только для моно**; `ScreenSharePresets` h720fps30 2 Мбит/с, h1080fps30 5 Мбит/с, h360fps3 200 кбит/с |
| 19 | LiveKit blog, «Audio quality» | https://livekit.com/blog/audio-quality | RED + inband FEC держат ~20–30 % потерь без ретрансляции; джиттер в норме ~7 мс |
| 20 | webrtcHacks, «How WebRTC's NetEQ jitter buffer provides smooth audio» | https://webrtchacks.com/how-webrtcs-neteq-jitter-buffer-provides-smooth-audio/ | Accelerate / preemptive expand / expand-PLC, относительная задержка (2022), окно 2 с, forget factor 0,983; NACK не ждёт |
| 21 | MDN, `RTCRtpReceiver.jitterBufferTarget` | https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget | 0–4000 мс, **пожелание**, Baseline с 09.2026; метрика `jitterBufferTargetDelay / jitterBufferEmittedCount` |
| 22 | Jellyfin SyncPlay, `PlaybackCore.js` | https://github.com/jellyfin/jellyfin-web/blob/master/src/plugins/syncPlay/core/PlaybackCore.js | `minDelaySpeedToSync` 60 мс, `maxDelaySpeedToSync` 3000, `speedToSyncDuration` 1000, `minDelaySkipToSync` 400; `speed = 1 + diff/speedToSyncTime` |
| 23 | Syncplay, `syncplay/constants.py` | https://github.com/Syncplay/syncplay/blob/master/syncplay/constants.py | rewind 4 с, fastforward 5 с, slowdown 0,95 с порога 1,5 с, сброс при 0,1 с, seek 1 с, EMA пинга 0,85 |
| 24 | CyTube, `www/js/util.js`, `callbacks.js` | https://github.com/calzoneman/sync/blob/3.0/www/js/util.js | `sync_accuracy` по умолчанию 2 с → перемотка по `mediaUpdate` |
| 25 | Krisp для разработчиков | https://krisp.ai/developers/ ; https://usagepricing.com/blueprint/krisp | RTC SDK (Win/Mac/Linux/Web-WASM/iOS/Android, LiveKit), доступ только через продажи, публичных цен нет |
| 26 | DeepFilterNet (Rikorose) + arXiv DeepFilterNet2 | https://github.com/Rikorose/DeepFilterNet ; https://arxiv.org/abs/2205.05474 | MIT/Apache-2, 48 кГц, задержка алгоритма 40 мс, RTF 0,04 на Core i5 |
| 27 | `deepfilternet3-noise-filter` (npm) | https://cdn.jsdelivr.net/npm/deepfilternet3-noise-filter@1.3.0/README.md | WASM+ONNX, `TrackProcessor` для livekit-client, уровень 0–100, SIMD; Chrome 91+ |
| 28 | Jitsi, «Enhanced noise suppression» | https://jitsi.org/blog/enhanced-noise-suppression-in-jitsi-meet | RNNoise в AudioWorklet+WASM, 480-отсчётные кадры, кольцевой буфер |
| 29 | WorkAdventure, «Noise suppression in an AudioWorklet» | https://workadventu.re/tech/building-an-easy-to-use-browser-noise-suppression-library-in-an-audio-worklet/ | DTLN в LiteRT: 4–6 мс на кадр; Krisp отвергнут — «$100k+ в год минимум» |
| 30 | Datadog, «dtln-rs» | https://www.datadoghq.com/blog/engineering/noise-suppression-library | DTLN на Rust для native и web; 33 мс на секунду звука |
| 31 | Microsoft Learn, Windows Studio Effects | https://learn.microsoft.com/windows/ai/studio-effects | Voice Focus требует NPU (23H2+, Phoenix/Meteor Lake/Qualcomm) |
| 32 | NVIDIA Maxine Audio Effects SDK | https://docs.nvidia.com/deeplearning/maxine/audio-effects-sdk/index.html | Только RTX с тензорными ядрами, проприетарный redistributable |
| 33 | electron-overlay-window (MIT) | https://github.com/SnosMe/electron-overlay-window | Привязка окна Electron к окну игры по заголовку, слежение за позицией/фокусом, Win 7–10 |
| 34 | goverlay / electron-overlay | https://github.com/hiitiger/goverlay | DX9–12/OpenGL хуки, DLL-инъекция, «многие игры блокируют инъекцию» — то, чего мы не делаем |
| 35 | Electron docs: Tray, nativeImage, Notification, app, BrowserWindow | https://www.electronjs.org/docs/latest/api/tray ; …/api/native-image ; …/tutorial/notifications ; …/api/app ; …/api/browser-window | ICO 16/20/24/32 + 256; `createFromPath` → пустая картинка при отсутствии файла; AUMID + ToastActivatorCLSID; `backgroundThrottling`; `setContentProtection` |
| 36 | electron-builder, `nsis.md` | https://github.com/electron-userland/electron-builder/blob/master/website/docs/nsis.md | «AUMID должен быть равен `appId` … `app.setAppUserModelId(appId)` первым кодом main» |
| 37 | Chrome, «Timer throttling in Chrome 88» | https://developer.chrome.com/blog/timer-throttling-in-chrome-88 | Скрытая страница с живым `MediaStreamTrack`/звуком не попадает под минутный троттлинг таймеров |
| 38 | Скрины Discord r103-02…06, 21…29 | `backlog/refs/img/review-1.0.3/` | Окно выбора источника (Приложения/Весь экран/Устройства, SD/HD, шестерёнка), «Показывать предпросмотр стрима», оверлей: «требуется безрамочный режим», виджеты, «Зарегистрированные игры», «X сворачивает Discord» |

## 2. Темы

### 2.1 Голос: как не обрывать (R01, R09, R10, R68)

**Discord.** Клиент всегда инициирует соединение; сервер голоса — C++ SFU, выбирается наименее
загруженный в регионе; упавший сервер не проходит ping и исчезает из discovery, клиент через gateway
получает новый и переподключается «с минимальным разрывом» (ист. 1). Куратор (ист. 2) шлёт на каждый
сервер трафик, имитирующий голос, и по обратному потоку выводит сервер из ротации; обновления — через
draining. Тишина не передаётся (DTX), «обе стороны готовы к тому, что звук прекратится в любой момент».
Браузерам — стандартный DTLS-SRTP, нативным — свой стек. Поверх этого в 2024 — DAVE (ист. 3).

**Открытые аналоги.** NetEQ (ист. 20) — тот самый буфер, который у нас «ускорял музыку»: accelerate при
избытке, expand/PLC при потере, цель по относительной задержке с окном 2 с. RED + inband FEC в LiveKit
держат 20–30 % потерь (ист. 19), но **только для моно** (ист. 18) — к нашей стерео-музыке на клиенте
это не относится. SFU LiveKit умеет сам обернуть Opus-дорожку в RED на пути вниз
(`audio.active_red_encoding`, ист. 16/17): до двух избыточных блоков по ≤ 1 КиБ; наш кадр 256 кбит/с ×
20 мс = 640 байт — помещается.

**Что видно в Cord.** Диагностика r103-19: «Музыка · приём: 1 Кбит/с, потери 6 %, буфер 1723–2489 мс».
Издатель (`services/publisher/main.go`) никогда не прерывает поток: без кадров идёт закодированная
тишина CELT по 20 мс — это ~2–6 байт на пакет, то есть **~1–2 кбит/с на счётчике и есть «музыки нет»**:
ffmpeg не отдавал кадры (замер хоста, стоп yt-dlp, пауза), а не сеть «съела» 254 кбит/с. 6 % потерь при
«прямом UDP, RTT 57 мс» — на стенде со steal 38–56 % такие потери, вероятнее всего, делает сам хост
(пакеты не выбираются из сокета вовремя); куратор из таблицы ниже это и проверит. Буфер 1,7–2,5 с — приёмник честно пережидает всплески, но замирание на 21–35 с
(`backlog/journal/ENV-cord.nikg.tech.md`) не пережить ничем.

**Делаем.**

| Решение | Задача | Где |
| --- | --- | --- |
| **Куратор**: зонд-участник (Go, тот же `services/publisher` в режиме `--probe`): раз в 60 с входит в служебную комнату, публикует 1 кГц, подписывается сам на себя через SFU и пишет `cord_probe_loss_ratio`, `cord_probe_jitter_ms`, `cord_probe_rtt_ms`; алерт при loss > 2 % или rtt > 150 мс 3 раза подряд. Это отделяет «хост/сеть» от «код» — ровно вопрос R10 | R10, R68 | `services/publisher/probe.go` (новый), `infra/monitoring/alerts.yml`, `docs/observability.md` §3 |
| **Дренаж** вместо «второго SFU»: `scripts/deploy.sh` обновляет LiveKit только когда `lk room list` пуст, иначе ждёт до 15 мин с флагом `--drain` (ядро перестаёт создавать комнаты: `503 MAINTENANCE` на `POST /rooms`) | R68, R69 | `scripts/deploy.sh`, `RoomService.create` |
| **Сторож издателя**: если дорожка «играет», а в канал ушло > 25 кадров тишины подряд (0,5 с) — счётчик `cord_music_underrun_total`, лог причины (ffmpeg stderr, lag позиции); > 5 с — перезапуск ffmpeg с текущей позиции (состояние в SQLite уже есть). Underrun становится **измеримым**, а не «трек лагает» | R02, R04, R09 | `services/publisher/main.go` (`quiet`-ветка рядом с `lead`/`slack`), экспорт через `/metrics` службы |
| **RED на SFU для музыки**: `audio: { active_red_encoding: true }` в генераторе конфигурации. Цена — до ×3 полосы вниз на слушателя музыки (256 → ≤ 768 кбит/с), при 20 слушателях ≤ 15 Мбит/с — укладывается в ёмкость (`docs/capacity.md`). Владелец выбрал качество, не экономию (R05) | R01, R02, R05 | `scripts/configure.mjs` (`livekit.audio`), проверка в SDP подписчика `a=rtpmap:63 red/48000/2` |
| **Приоритет звука при перегрузке** оставить штатный: `congestion_control.allow_pause` (по умолчанию true) ставит на паузу видео, звук — никогда. Не трогаем | R05 | — |
| **Метрики приёма в ядро** (R68): клиент раз в 10 с шлёт сводку по каждой дорожке — `concealedSamples/totalSamples`, `concealmentEvents`, `packetsLost`, `jitterBufferTargetDelay/jitterBufferEmittedCount`, `playoutDelay`; ядро — гистограммы Micrometer; дашборд «слышимые провалы в минуту» | R68 | `web/src/media/call-quality.ts` → `POST /api/v1/rooms/{id}/quality`, `docs/observability.md` §4 |
| **Хост**: SFU и издатель — в отдельный systemd slice с `CPUWeight=1000`, `IOWeight=1000`, `Nice=-10`; ядро/службы/мониторинг — ниже. Это не спасёт от soft lockup гипервизора, но при steal 40 % даст медиа первые свободные такты. Прод — на машине без lockup (`target-2026-10.md` §5.1) | R10 | `infra/*.service`, `docs/deployment.md` |
| **Проверить** `useinbandfec=1` в SDP микрофона (livekit-client должен ставить), иначе — SDP-munging в `session.ts`. RED уже включён (`audio.ts`: 64 кбит/с, `red:true`, `dtx:true`) — верно, оставляем | R01 | `web/src/media/audio.ts`, `session.ts` |

Чего **не** делаем: собственный SFU, Salsa20, второй регион — у Discord это ответ на 2,6 млн пользователей,
у нас на 20 человек ответ — убрать стенд с замирающего хоста.

### 2.2 Go Live: пресеты и превью (R07, R08, R13, R60)

**Discord.** Окно выбора: вкладки **Приложения / Весь экран / Устройства**, снизу пресет «Игры · 720p ·
30fps», сегмент **SD | HD** (HD — Nitro, 1080p60), шестерёнка: режим стрима (Игры / Пользовательские),
«Заглушить аудио стрима», аудиоустройство, расширенные (r103-02, r103-04; ист. 8). До 50 зрителей.
AV1 4K60 за 8 Мбит/с на RTX 40, откат на H.264, если кто-то не декодирует (ист. 11). **Превью** —
настройка «Показывать предпросмотр стрима: показывает зрителям предпросмотр до того, как они
присоединятся» (r103-06); клиент стримера сам загружает снимок `POST /streams/{key}/preview`
(base64 JPEG, ист. 10) — сервер хранит картинку, видео никому лишнему не шлётся. Есть жалобы, что
превью «пропадает, когда окно Discord теряет фокус» — то есть снимок делает клиент из своего окна.

**Открытые аналоги.** LiveKit: simulcast + dynacast (неиспользуемые слои гасятся на отправителе),
adaptiveStream выбирает слой по размеру плитки (ист. 12/14). Самый дешёвый живой слой
`ScreenSharePresets.h360fps3` — 200 кбит/с (ист. 18): всё равно в **25 раз дороже** снимка 10 КБ раз в
10 с (8 кбит/с) и требует третьего кодировщика у стримера.

**Что в Cord.** `web/src/media/screen-preview.ts` уже делает по-дискордовски: 256×144 JPEG, качество
0,5/0,35/0,2, ≤ 14 000 байт, раз в 10 с, `publishData(reliable, topic cord.screen-preview)`, получатель
размывает. «Зелёный фон» (R07) — кадр не снимается: `drawImage(video)` с `<video>`, который не
воспроизводится (`readyState < 2`, `play()` не вызван/отклонён, или элемент не в DOM), даёт пустой
кадр; зелёный — типичный цвет неинициализированной YUV-поверхности при GPU-декодировании.

**Делаем.**

| Решение | Задача | Где |
| --- | --- | --- |
| Снимок — не через `<video>`, а через `MediaStreamTrackProcessor` → `VideoFrame` → `createImageBitmap` → `OffscreenCanvas` (Chromium/Electron; запасной путь — `requestVideoFrameCallback` на играющем `<video>` с `await play()`); тест на «кадр не чёрный и не одноцветный» (дисперсия пикселей > порога) перед отправкой | R07 | `web/src/media/screen-preview.ts` |
| Интервал: **5 с**, пока в комнате есть хоть один, кто не смотрит эту демонстрацию; **0** (не снимаем), когда смотрят все или никого нет. 5 с — компромисс Discord-подобного «понять, что там» и ≤ 3 КБ/с на стримера; 10 с на практике выглядело как «не рисуется» | R07 | `screen-preview.ts` (`PREVIEW_INTERVAL`), `session.ts` |
| Плитка до первого снимка — не зелёная: сначала размытая обложка «готовится показ» по `screen.started` (WP2), затем снимок | R07 | `web/src/ui/Stage.tsx` |
| Окно выбора источника — как r103-02/04: вкладки Приложения / Весь экран / Устройства (камеры-захвата), сегмент **SD · HD** (SD = `capabilities.quality.default` 720p30, HD = `ceiling` 1080p60 с сервера), шестерёнка: «Игры / Текст» (30 fps + приоритет движения ↔ 15 fps + `contentHint: 'text'`), «Звук приложения / весь звук кроме Cord / без звука» (process loopback в `cord-native`). Без Nitro-плашки | R60 | `W/desktop/src/shell/picker.html`, `picker.js`, `web/src/ui/Prejoin.tsx`/`Stage.tsx` (веб — системный диалог + тот же низ) |
| Битрейты экрана — из `ScreenSharePresets` LiveKit: 720p30 — 2 Мбит/с, 1080p30 — 5 Мбит/с, 1080p60 — 7 Мбит/с (`original`-потолок); с simulcast-слоем 360p15 (400 кбит/с) для маленьких плиток | R13, R60 | `web/src/media/profiles.ts` |
| «Уступать показу экрана» — удалить: `stream.media.quality.camera-yields-to-screen` и переключатель; камера и показ — независимые публикации, как у Discord | R08 | `web/src/media/upstream.ts`, `profiles.ts:285`, `Settings.tsx`, `StreamProperties.java` |
| Камера: умолчание 720p30 с сервера, сегменты 480/720/1080 и 30/60 (не список) — уже заложено WP2 | R13 | `web/src/ui/Settings.tsx` `QualityFields`, `media/capabilities.ts` |

### 2.3 Синхронный просмотр и прослушивание (R03, R05, R06)

**Discord.** Watch Together — YouTube-активность: сервер активности — единственный источник состояния
(play/pause/seek рассылаются всем), компенсация задержки. Listen Along (Spotify) печально известен
отставанием в 30–50 с — он управляет чужим плеером, а не отдаёт поток. У нас музыка идёт **одной
WebRTC-дорожкой через SFU** — это заведомо лучше Listen Along: разброс между слушателями равен разнице
их буферов приёма, а не задержке API.

**Открытые аналоги (цифры).**

| Система | Мёртвая зона | Подтяжка скоростью | Перемотка | Часы |
| --- | --- | --- | --- | --- |
| Jellyfin SyncPlay (ист. 22) | < 60 мс | 60–3000 мс: `1 + diff/1000`, 1 с, пол 0,2 | ≥ 400 мс и > 3000 мс | серверное время + половина RTT |
| Syncplay (ист. 23) | < 1 с seek-порог | отстаём > 1,5 с → ×0,95, сброс при < 0,1 с | отстали > 4 с / убежали > 5 с | EMA пинга 0,85 |
| CyTube (ист. 24) | < 2 с | нет | > 2 с | серверный `mediaUpdate` |
| **Cord сейчас** (`web/src/core/watch.ts`) | < 0,3 с | 0,3–2,5 с: ×1,05 / ×0,95 под присмотром | > 2,5 с (+0,4 с запас) | лучший из N ответов, ≤ 5 мс ошибки |

Измерено на проде 19.09: 0,19 с в установившемся режиме, 0,10 с при старте после правок 25.09 — «одна
секунда» для роликов **уже выполняется**; расхождение возвращается только у живого эфира (3,4 с
медиана, общей секунды нет — `docs/INTEGRATIONS.md`).

**Делаем.**

| Решение | Задача | Где |
| --- | --- | --- |
| Кинозал, ролики: подтяжка **пропорциональная**, как у Jellyfin: `rate = clamp(1 + diff/2000, 0.9, 1.1)` вместо фиксированных ±5 %. 0,3 с догоняются за ~6 с вместо 6–12; `preservesPitch` (по умолчанию true) не даёт слышать ±10 %. Мёртвую зону 0,3 с и порог перемотки 2,5 с не трогаем — ниже 0,3 с глаз не видит, а Jellyfin'овские 60 мс дёргают плеер на каждом тике | R03 | `web/src/core/watch.ts` |
| Часы: к «лучшему из N» добавить повтор замера раз в 30 с и **min-фильтр** по последним 8 (EMA Syncplay хуже: усредняет задержанные ответы) | R03 | `web/src/core/watch.ts`, снимок `serverTime` |
| Живой эфир: комната хранит `liveStartedAt` (момент открытия канала по часам сервера) и цель «край − 6 с»; расхождение считается от неё, перемотка к `liveSync.targetLatency` hls.js. Закрывает единственное место, где больше секунды | R03 | `services/cord_services/cinema/routes.py`, `watch.ts`, `web/src/ui/cinema/theater/*` |
| Музыка: **потолок буфера 2500 → 1500 мс**, старт 800 → 600, пол 400 → 300 (`media`-профиль). Обоснование: разброс между слушателями ≤ потолок − пол; при 1500/300 худший случай 1,2 с, типичный (оба у старта) < 0,3 с. Владелец отказался от упора на слабый интернет (R05): всплеск > 1,5 с теперь слышен как короткая заглушка, а не как отставание на 2,5 с у одного из двух. Спуск вниз для музыки — 50 мс / 15 с (было 30 с) | R03, R05, R06 | `web/src/media/playout.ts` (таблица профилей), `playout-control.ts` |
| «Чужое видео» и «Дополнительно» убрать из настроек; режим «Плохая связь» (Авто/Мин. задержка/Макс. устойчивость) **удалить** — остаётся «Авто» с границами выше. Это и есть X3 «зашить оптимум» | R06, R21 | `web/src/ui/Settings.tsx`, `core/preferences.ts`, `media/playout.ts` |
| Диагностика: «Отставание от комнаты» для музыки = мой `playoutDelay` минус медиана по комнате (слушатели шлют свой `jitterBufferTargetDelay/EmittedCount` раз в 10 с тем же каналом данных, что превью, ≤ 20 байт). Это делает «одну секунду» **видимой**, а не ощущаемой | R03, R48 | `web/src/media/call-quality.ts`, `ui/Diagnostics*` |
| `room.playout_delay` LiveKit (видео, 100–2000 мс) **не включаем**: он комнатный и ломает A/V-синхронизацию разговора; для показа экрана достаточно клиентской цели по классу дорожки | R05 | — |
| Издатель: `-frame_duration 20` оставить (Discord — 20 мс; 40/60 мс сократили бы пакеты, но удвоили цену потери); `CORD_MUSIC_PACKET_LOSS=0` оставить (измерено −10 дБ THD+N за FEC) — защита от потерь теперь на SFU (RED, §2.1) | R02 | `services/publisher/main.go` |

### 2.4 Шумоподавление (R52) — см. также §3 «Krisp — ответ владельцу»

**Discord.** Krisp встроен, бесплатен для всех, работает на устройстве, выключен по умолчанию, в
десктопе/браузере/мобильном (ист. 7, r103-21: профили «Изоляция голоса / Студия / Пользовательский»,
«Шумоподавление: Krisp»).

**Варианты для нас.**

| Вариант | Лицензия/цена | Задержка | CPU | Где работает | Вердикт |
| --- | --- | --- | --- | --- | --- |
| RNNoise (`@sapphi-red/web-noise-suppressor`, стоит сейчас) | BSD-3 | ~10 мс | ничтожный (WASM, сотни КБ) | веб + Electron, worklet | **оставить по умолчанию**; слаб на клавиатуре и нестационарном шуме |
| DeepFilterNet3 (`deepfilternet3-noise-filter`, ист. 26/27) | MIT/Apache-2 | 40 мс алгоритм + worklet | RTF 0,04 на Core i5 (≈ 4 % ядра), SIMD-WASM | Chrome 91+/Electron | **добавить как «Усиленное»** в Electron и десктопных Chromium после замера CPU; качество ближе к Krisp |
| DTLN (WorkAdventure/Datadog, ист. 29/30) | MIT | 4–6 мс/кадр (16 кГц) | низкий | веб | запасной вариант, если DFN3 окажется тяжёл; 16 кГц режет верх |
| WebRTC NS браузера (`noiseSuppression:true`) | — | 0 | 0 | везде | уже есть как «браузерное» |
| `voiceIsolation` (Chrome → Windows Voice Focus) | — | 0 | NPU | только Copilot+ (ист. 31) | уже есть как «voice»; оставить, показывать только если `getCapabilities().voiceIsolation` |
| Krisp SDK | по запросу через продажи; «$100k+ в год» (ист. 29) | — | — | есть WASM | **нет** |
| LiveKit Krisp (`@livekit/krisp-noise-filter`) | только LiveKit Cloud (ист. 15) | — | — | — | **нет** (self-hosted) |
| NVIDIA Maxine (ист. 32) | проприетарно, RTX с тензорными ядрами | ~10–20 мс | GPU | Windows | нет: зависимость от вендора |

**Делаем:** меню шумоподавления — три положения как у Discord: «Выключено / Стандартное (RNNoise) /
Усиленное (DeepFilterNet3)», умолчание — Стандартное; «Усиленное» видно только где есть SIMD-WASM и
≥ 4 логических ядер; `TrackProcessor` тот же `CordAudioProcessor` (`web/src/media/audio.ts`), модель
грузится лениво с нашего origin (CSP). Замер приёмки: CPU процесса рендерера до/после, задержка
микрофон→SFU по `getStats`.

### 2.5 Оверлей в играх (R61, R62, R63)

**Discord.** Старый оверлей — инъекция в DirectX/Vulkan («устаревший оверлей доступен для всех
поддерживаемых игр», r103-23). Новый (март 2025, ист. 4): вне процесса, виджеты, «воздушность, скорость…
требуется включение безрамочного дисплея» (r103-23); виджеты: голосовой, быстрые действия, уведомления,
чат, активность, видео, стримы; у голосового — размер аватара, показывать имена/пользователей
(всегда/только говорящих), максимум пользователей 0–25 (r103-24/25); замок оверлея `Shift+`` ` ``,
«режим совместимости», «интерактивные области». Игры: список `applications/detectable` (24 780 записей,
по именам exe, флаги `overlay`/`hook`, ист. 9) + «Зарегистрированные игры» с переключателем на игру и
«Нет вашей игры? Добавьте её» (r103-26).

**Открытые аналоги.** electron-overlay-window (MIT, ист. 33) — то же, что наш `foreground.rs`, но
привязка по заголовку и слежение за перемещением окна; goverlay (ист. 34) и OBS graphics-hook —
инъекция, конфликт с EAC/BattlEye/FACEIT; ow-electron — платформа Overwolf с их условиями. Наш ADR §4.3
уже выбрал класс нового Discord: прозрачное `BrowserWindow`, `screen-saver`-уровень, клики сквозь,
`WDA_EXCLUDEFROMCAPTURE`, `GetForegroundWindow` раз в 300 мс без `OpenProcess`.

**Делаем.**

| Решение | Задача | Где |
| --- | --- | --- |
| По умолчанию **включён**; показывается только в звонке и только когда впереди полноэкранное (borderless) чужое окно — как сейчас, но `overlayEnabled: true` | R61 | `W/desktop/src/main/settings.ts:50`, `app-settings.ts` |
| «Игры» как у Discord без Discord: `cord-native` отдаёт имя exe, класс и заголовок переднего окна; список «Зарегистрированные игры» наполняется **автоматически** при первом совпадении «полноэкранное + не из списка исключений (браузеры, офис, проигрыватели, сам Cord)», у каждой — переключатель «оверлей для этой игры» и «последний запуск»; «Добавить игру» — выбрать процесс из списка окон. Список Discord не встраиваем (условия использования их API не позволяют); эвристика + ручное — достаточно для «различать игры» | R62 | `W/desktop/native/src/foreground.rs` (имя exe берётся из `PROCESSENTRY32.szExeFile` того же Toolhelp-снимка, что уже есть, — по-прежнему без `OpenProcess` на игру), `overlay-policy.ts`, `settings.ts`, веб — раздел «Windows → Оверлей» |
| Виджеты (без аккаунтов): **Голосовой** (кто в звонке, кто говорит), **Быстрые действия** (микрофон, наушники, выйти, начать показ), **Уведомления** (сообщение чата, вход/выход, приглашение), **Превью стрима** (снимок из §2.2). Чат-виджет — вторым этапом. Настройки голосового: размер аватара (S/M/L), показывать имена (всегда/при наведении), показывать (всех/только говорящих), максимум (0–25), угол экрана | R62 | `W/desktop/src/shell/overlay.html/js`, `overlay-policy.ts`, мост `overlay.state` |
| **Замок оверлея**: клавиша (умолчание `Shift+`` ` ``) переводит окно в интерактивный режим (`setIgnoreMouseEvents(false)`, `focusable:true`), подсветка рамки; повторно — обратно. Нужен для быстрых действий | R62 | `W/desktop/src/main/hotkeys.ts`, `overlay-policy.ts` |
| **Моментальная реакция говорящих** (R63). Сейчас `overlay.state` ≤ 10 Гц рождается из `levels.ts`, а тот крутится на `requestAnimationFrame` и **останавливается, когда документ скрыт** — то есть ровно в игре. Переносим: источник — `ActiveSpeakersChanged` LiveKit (сервер: `update_interval` 500 мс, `smooth_intervals` 4 — поставить **200 мс / 2** в `audio` конфигурации) **плюс** локальный `AudioWorklet`-измеритель уровня (не rAF) 25 Гц для своего микрофона и подписанных дорожек; в оверлей уходят только изменения; окно оверлея — `backgroundThrottling:false`, `paintWhenInitiallyHidden:true`. Целевая задержка «голос → кольцо» ≤ 150 мс (локально 40 мс, через сервер ≤ 250 мс) | R63 | `web/src/media/levels.ts` (отвязать от `visible()` для оверлея), `session.ts`, `scripts/configure.mjs` (`livekit.audio`), `W/desktop/src/main/windows/overlay*.ts` |
| Анимации: кольцо говорящего — CSS `transform/opacity` 120 мс ease-out, громкость → ширина кольца через CSS-переменную; никакого layout-thrash; 60 fps в прозрачном окне проверить на RTX/iGPU | R63 | `W/desktop/src/shell/overlay.css` |
| Эксклюзивный полноэкранный режим: оверлей невидим — показываем одно Windows-уведомление «Включите безрамочный режим в игре, чтобы видеть оверлей» (раз на игру), как Discord | R62 | `overlay-policy.ts`, `notifications.ts` |
| Чего не делаем: DLL-инъекции, хуки Present, чтение памяти — ADR §4.3; «устаревший оверлей» Discord не повторяем | — | — |

### 2.6 Клиент Electron как у Discord (R57, R58, R59, R64)

**Discord.** «Свернуть Discord в панель задач: кнопка X сворачивает, но не закрывает» (r103-27),
автозапуск и «запускать свёрнутым» — выключены по умолчанию, аппаратное ускорение включено.

**Что найдено в коде клиента.**

| Дефект | Причина (подтверждена чтением) | Исправление | Файл |
| --- | --- | --- | --- |
| R57: X не уходит в трей | `window.on('close')` всегда `preventDefault` → `requestClose()` → `window.destroy()`; `onClosed` → `quit()` | При `settings.tray` и не `quitting`: `event.preventDefault(); window.hide()`; `window-all-closed` игнорировать; настоящий выход — из меню трея и `before-quit` (`quitting=true`); в звонке — спросить, как сейчас, только при настоящем выходе | `W/desktop/src/main/windows/main.ts:147–156`, `index.ts:250–253` |
| R58: иконка трея прозрачная | `icon()` ищет `build/icon.ico` или `dist/shell/icon.ico`; `electron-builder.yml` упаковывает только `dist/**`, в `dist/shell` есть лишь `icon-256.png` → `nativeImage.createEmpty()` → пустая иконка (ист. 35: «returns an empty image if the path does not exist») | Отдельный `tray.ico` с 16/20/24/32 (100–200 % DPI) и 256 (ист. 35), положить в `dist/shell` сборкой Vite (`publicDir`) или `extraResources` + `process.resourcesPath`; состояние («в звонке», «микрофон выкл.») — ICO-варианты, не SVG-кружок; лог `image.isEmpty()` при старте — чтобы такое не повторилось | `W/desktop/src/main/tray.ts:25–35`, `electron-builder.yml` `files`, `vite.config` оболочки |
| R59: уведомления Windows | `app.setAppUserModelId('Cord')`, а ярлык NSIS получает AUMID = `appId` = `tech.cord.desktop` (ист. 36: «AUMID должен быть равен appId… первым кодом main»); тосты без совпадения идут без иконки/группируются неверно | `app.setAppUserModelId('tech.cord.desktop')` до создания окон; постоянный `setToastActivatorCLSID(<GUID>)` + запись CLSID на ярлык через `installer.nsh` (`WinShell::SetLnkAUMI`/`ToastActivatorCLSID`), чтобы клик по тосту оживлял закрытое приложение; `Notification` с `toastXml` для кнопок «Ответить/Открыть»; звук — системный | `W/desktop/src/main/windows/main.ts:212–214`, `notifications.ts`, `build/installer.nsh` |
| «Трек лагает» в скрытом окне | Главное окно уже `backgroundThrottling:false` (`main.ts:137`); Chromium не троттлит страницы с живым `MediaStreamTrack` (ист. 37); но `requestAnimationFrame` в скрытом окне **стоит** — всё, что на rAF (уровни, анимации плеера), замирает; звук WebRTC не на rAF — не причина лага, причина — §2.1 | Аудит rAF-зависимостей: уровни → worklet (§2.5), таймеры плеера → `setTimeout`; `powerSaveBlocker('prevent-app-suspension')` в звонке (сейчас только `display-sleep`) | `web/src/media/levels.ts`, `W/desktop/src/main/index.ts` |
| Автозапуск | `setLoginItemSettings({openAtLogin, args: ['--hidden']})`, **выкл.** по умолчанию, как Discord; «запускать свёрнутым» — отдельный переключатель, активен только при автозапуске | `W/desktop/src/main/index.ts`, настройки «Windows» в вебе (X4 — переключатели) |
| R64: установщик | `displayLanguageSelector: false` сейчас — включить **выбор языка** мастера (`displayLanguageSelector: true`, `multiLanguageInstaller: true` уже есть), тексты страниц — `LangString` на 8 языков; имена: `productName`/`shortcutName`/`uninstallDisplayName` = «Cord» везде, включая строки `LangString` всех восьми языков; разметка страниц `installerSidebar.bmp` 164×314, `installerHeader.bmp` 150×57 (размеры NSIS MUI2) | `W/desktop/electron-builder.yml`, `build/installer.nsh` |

Обновления — заставка при запуске (ADR §5.1, T58) — совпадает с Discord; без изменений.

### 2.7 Отказоустойчивость в целом (R04, R68, R69)

**Discord.** Изоляция «процесс на гильдию», Semaphore — отказ лишних запросов вместо лавины,
Manifold — распределённый fan-out, request coalescing в data services, draining серверов и куратор (ист.
2, 5, 6). Из этого к нашему масштабу применимы **принципы**, не технологии: изолировать отказы по
границам процессов, отвечать «нет» раньше, чем упасть, измерять медиа синтетикой, обновлять без обрыва.

**Делаем.**

| Решение | Задача | Где |
| --- | --- | --- |
| Границы процессов: SFU, издатель музыки, службы (кинозал/музыка), ядро — отдельные unit'ы с `Restart=always`, `StartLimitBurst`, `WatchdogSec` у издателя (sd_notify из Go раз в 5 с, пока пишутся кадры); падение службы кинозала не трогает SFU и разговор | R04 | `infra/*.service`, `services/publisher/main.go` |
| Издатель: при перезапуске продолжает с позиции из SQLite **и не меняет identity** в комнате (токен тот же, `rejoin`), слушатели видят ≤ 1 с тишины, а не исчезновение дорожки; в вебе — плитка музыки не пропадает при `TrackUnpublished` < 10 с | R04 | `services/cord_services/music/*`, `publisher/main.go`, `web/src/core/meeting.ts` |
| Backpressure в ядре (Semaphore-идея): предел одновременных внешних вызовов (yt-dlp, Яндекс, Twirp) на комнату и на сервер с быстрым `429/503 + Retry-After`, а не очередью; очередь скачиваний уже «по одному на комнату» | R04 | `RoomService`, `services/cord_services/sources.py` |
| Деградация без обрыва: источник трека недоступен → следующий трек и уведомление в чат; кинозал: отказ прокси сегмента → ретрай 3× с 200/400/800 мс, затем переключение уровня, затем «пауза для всех» с причиной | R04 | `services/cord_services/cinema/routes.py`, `web/src/ui/cinema/theater/*` |
| Наблюдаемость медиа (R68): куратор (§2.1), underrun издателя, сводки концилмента с клиентов, `cord_host_soft_lockups_total`; оценка **MOS** по упрощённой E-модели из RTT/потерь/джиттера на дашборде — не для науки, а чтобы «стало хуже» было графиком | R68 | `docs/observability.md` §4–5, `infra/monitoring/*` |
| Circuit breaker на внешние площадки (Яндекс, YouTube, ivi…): 5 ошибок за 60 с → открыт на 2 мин, витрина показывает «временно недоступно» вместо зависающего поиска | R04 | `services/cord_services/cinema/facade.py`, `music/*` |
| Выкатка (R69): деплой с дренажем (§2.1); smoke после выкатки — куратор зелёный 3 раза подряд; откат — предыдущий образ по тегу | R69 | `scripts/deploy.sh` |

### 2.8 LiveKit-специфика: что включено и что докрутить

| Параметр | Сейчас | Решение |
| --- | --- | --- |
| `adaptiveStream: {pixelDensity:'screen'}`, `dynacast: true` | включены (`session.ts:469–470`) | оставить |
| Микрофон: 64 кбит/с, `red:true`, `dtx:true`, моно | `audio.ts:31` | оставить; проверить `useinbandfec=1` в SDP |
| Музыка: Go-издатель, Opus 256 кбит/с стерео, 20 мс, без DTX | `publisher/main.go` | оставить; RED с SFU (`audio.active_red_encoding: true`) |
| `AudioPresets.musicHighQualityStereo` | не нужен (издатель кодирует сам) | использовать только если звук демонстрации в вебе: `forceStereo:true, dtx:false, red:false` (RED для стерео не действует) + `maxBitrate: 128_000` |
| Буфер приёма | `jitterBufferTarget` по классу (`playout.ts`) | музыка 300/600/1500 мс (§2.3); разговор 60/120/500 оставить; видео 80/150/1200 оставить |
| `room.playout_delay` (видео) | не задан | не включать (§2.3) |
| `rtc.congestion_control` | по умолчанию (включён, `allow_pause` true) | оставить; зафиксировать явно в `configure.mjs` |
| `packet_buffer_size_audio/video` | 200/500 | **audio 400**: при RTT 60–120 мс и NACK этого хватает с запасом; видео 500 оставить |
| `pli_throttle` | 500 мс/1 с/1 с | оставить |
| `allow_tcp_fallback` | true | оставить; `tcp_fallback_rtt_threshold: 150` — при RTT < 150 пробовать ICE/TCP, иначе сразу TURN/TLS |
| `audio.update_interval/smooth_intervals` | 500 мс / 4 | 200 мс / 2 для оверлея говорящих (§2.5) |
| Simulcast экрана | `simulcast:true`, слои `chosenHelpers` | слои: 360p15 (400 кбит/с) + выбранный; превью — снимки, не слой |
| NACK для аудио | не проверено | проверить в SDP ответа SFU `a=rtcp-fb:111 nack`; если нет — включить в клиенте |
| `prometheus` порт 6789 | с паролем | добавить `livekit_packet_*`, `nack`, `pli` на дашборд |

## 3. Krisp — ответ владельцу (R52)

**Бесплатен ли Krisp?** Для пользователей Discord — да: Discord лицензирует Krisp и встраивает в свой
клиент, работает на устройстве, по умолчанию выключен (ист. 7). **Для стороннего продукта — нет**: Krisp
продаёт RTC SDK (есть сборка Web/WASM и интеграция с LiveKit), доступ только через отдел продаж, без
публичных цен; одна команда, которая спрашивала, назвала порог «более $100 000 в год» (ист. 25, 29).
LiveKit отдаёт Krisp только в своём облаке — на self-hosted SFU его нет (ист. 15). Поставить Krisp в
Cord бесплатно и законно нельзя.

**Хорош ли наш RNNoise?** Это тот же класс, что у Jitsi (ист. 28): BSD-3, ~10 мс, почти нулевая
нагрузка, хорошо давит постоянный шум (вентилятор, улица, гул), заметно хуже Krisp на клавиатуре,
кликах и втором голосе. Для разговора «как в Discord» он — честный стандарт, не лучший.

**Что ставим.** Три положения, как в Discord: «Выключено / Стандартное / Усиленное». Стандартное —
RNNoise (как сейчас). Усиленное — DeepFilterNet3 (MIT/Apache-2, 48 кГц, задержка 40 мс, ~4 % ядра,
WASM-сборка с готовым `TrackProcessor` для livekit-client, ист. 26/27) — включается в Electron и в
десктопных Chromium с SIMD; на телефонах и слабых машинах пункт скрыт. Профили «Изоляция голоса /
Студия» Discord не копируем: «Студия» = наше «Выключено», «Изоляция» = «Усиленное». Приёмка — замер
CPU рендерера и задержки до SFU; если DFN3 съедает > 10 % ядра на целевой машине владельца — остаётся
RNNoise, DFN3 уходит в «экспериментальное».

## 4. Чего не переносим из Discord

- Всё про **учётные записи**: профиль, вход, «Данные и конфиденциальность», «Разрешения для сообщений»,
  «Конфиденциальность активности», «Подключённые приложения», «Выйти» (r103-22). В Cord личность —
  профиль устройства без аккаунта (`target-2026-10.md` §1.2).
- **Nitro и монетизация**: HD за подписку, «−40 % на Nitro», «Буст сервера», «Подписки», «Склад подарков»,
  «Выставление счетов». HD у нас — потолок сервера для всех.
- **Друзья и активность**: виджеты оверлея «Активность: во что играют друзья», уведомления «Сейчас
  играет», «Игровая активность», Rich Presence, «Listen Along».
- **Звуковая панель, «Lofi Beats с Вампусом»**, стикеры, «Внешний вид» с темами по подписке.
- **Старый оверлей с инъекцией** и «режим совместимости» — у нас только внепроцессный.
- **Собственный SFU/Salsa20/регионы/etcd** — переносим принципы (куратор, дренаж, backpressure), не стек.
- **Список игр Discord** — не встраиваем их данные; свой список по exe + ручное добавление.

## 5. Порядок внедрения (предложение в план волны)

1. R10/R68 — куратор и метрики (без них нельзя доказать R01–R03). 2. R58/R57/R59 — три правки Electron
(день). 3. R07 — захват снимка через `MediaStreamTrackProcessor` + интервал 5 с. 4. `active_red_encoding`,
`packet_buffer_size_audio: 400`, профиль музыки 300/600/1500, сторож издателя (R01/R02/R04/R09).
5. R03 — пропорциональная подтяжка, `liveStartedAt`, «отставание от комнаты» в диагностике. 6. R60/R08/R13
— окно выбора источника, удаление «уступать». 7. R61–R63 — оверлей: умолчание, игры, виджеты, замок,
говорящие через worklet + `ActiveSpeakersChanged`. 8. R52 — DFN3 как «Усиленное». 9. R64 — установщик.
