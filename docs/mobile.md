# Cord на телефоне: разговор в фоне и поверх других приложений

**Сделано 20.10.2026 (E12):** веб — §7, приложение для Android — §8, план для iPhone — §9. Что из этого
проверено и что ждёт телефона — там же.

19 октября 2026. Исследование к эпику E12 (задача владельца T16: «скрыть в оверлей… чтобы сервис
всегда работал… это должно считаться как полноценный разговор»). Что здесь **проверено**: чтение
первоисточников (WebKit, Chromium, Apple, Google, LiveKit) и исходников `livekit-client` 2.22.3 из
`web/node_modules`. Что **не проверено**: ни одно утверждение о фоне и PiP не прогонялось на
настоящем телефоне. Там, где вывод опирается на старый баг или на чужое наблюдение, это помечено
«проверить» — и попадает в протокол ручной проверки (раздел 6).

## 0. Коротко

- **Android (Chrome и установленное PWA): разговор в фоне держится, пока страница захватывает
  микрофон.** Chrome на время захвата сам поднимает foreground service с типом
  `camera|microphone` и уведомлением «сайт использует микрофон» [10]. Без захвата защиты нет.
- **iPhone, вкладка Safari: держится, пока жив захват микрофона** (Safari, в отличие от
  остальных, оставляет микрофон в фоне) [13][19]. Камера в фоне выключается всегда.
- **iPhone, приложение с экрана «Домой»: в фоне микрофон глушится** — баг WebKit открыт с 2022
  года, последнее подтверждение 2024–2026 [13][14][40]. С iOS 26 любой сайт с экрана «Домой»
  открывается как веб-приложение [20], поэтому наша `InstallHint` ведёт iPhone ровно туда, где
  разговор в фоне хуже. Проверить первым делом.
- **«Скрыть в оверлей»:** PiP для `<video>` по кнопке работает везде (iOS 14+, Chrome Android
  105+) [2][6]. **Автоматический** PiP при сворачивании — только настольный Chrome 120+ [4]. На
  телефоне PiP включается сам только из полноэкранного родного видео [9][23].
- **Карточка звонка на экране блокировки из браузера не получится.** Chromium не делает
  управляемой медиасессию, если в ней только WebRTC-плееры [11]. Кнопки «микрофон/камера/сбросить»
  в Media Session видны только в окне PiP настольного Chrome [8]. В Safari 18.4+ есть
  `togglemicrophone`/`setMicrophoneActive`, а `hangup` нет [1][18].
- **«Полноценный разговор» (экран звонка ОС, входящий при закрытом приложении, без ограничений
  по времени)** — только в нативной оболочке: CallKit+PushKit на iOS [24], Telecom + foreground
  service `phoneCall` на Android [30][31].
- **Рекомендация:** сразу сделать всё веб-возможное (раздел 3). Затем прототип на **Capacitor**
  (тот же веб-клиент). Сначала Android APK, он не требует аккаунтов. iOS — после короткого
  опыта на устройстве: удержит ли WKWebView микрофон в фоне [14][15]. Если нет — iOS на React
  Native + LiveKit RN SDK.

## 1. Что можно в браузере / что только в приложении

| Возможность | iOS Safari | iOS «Домой» (PWA) | Android Chrome | Android PWA (WebAPK) | Только приложение |
|---|---|---|---|---|---|
| Звук в обе стороны при свёрнутом браузере / погашенном экране, **микрофон захвачен** | Да, пока жив захват [13][19]; срок не ограничен документом — проверить | **Нет**: микрофон глушится при уходе с экрана [13][14][40]; собеседник слышен недолго — проверить | Да: foreground service `camera\|microphone` на время захвата [10] | Как Chrome: WebAPK открывает приложение в Chrome [39] | iOS: `UIBackgroundModes` audio/voip [35]; Android: FGS `microphone`/`phoneCall` [30] |
| То же, **микрофон не захвачен** (вошли с выключенным) | Скорее нет: фоновый AudioContext останавливается [16] — проверить | Нет | Не защищено: нет FGS, вкладку могут заморозить или выгрузить [10][12] | Как Chrome | Да |
| Камера в фоне | Нет (ОС + LiveKit гасит камеру на телефоне) [36] | Нет | Нет (LiveKit гасит) [36] | Нет | iOS 18+ с voip-режимом [34][25]; Android FGS `camera` [30] |
| PiP `<video>` по кнопке | Да, iOS 14+: `requestPictureInPicture` и `webkitSetPresentationMode` [2][22]; для потоков камеры чинили в 2024 [21] | Тот же WebKit — проверить | Да, Chrome 105+ [2][6] | Проверить | Да (iOS: PiP для видеозвонков AVKit; Android: PiP активности) |
| Авто-PiP при сворачивании | Только из родного полноэкранного видео, не из inline [23] | Так же | Только полноэкранное видео + «Домой» [9]; `enterpictureinpicture` на Android нет [6] | Так же | Да |
| Document PiP (окно с любым HTML) | Нет [3] | Нет | Нет [3] | Нет | — (на ПК: Chrome 116+, Firefox 151+) |
| Карточка на экране блокировки (Media Session) | API есть (Safari 15+) [1]; для WebRTC карточка не ожидается — проверить | Проверить | Нет: сессия из одних WebRTC-плееров неуправляемая [11] | Нет | iOS: экран CallKit; Android: уведомление звонка |
| `togglemicrophone`, `togglecamera`, `setMicrophoneActive` | Да, Safari 18.4+ (из интерфейса Safari) [1][18] | Проверить | API есть (Chrome 93) [1], интерфейса на Android нет [8] | Так же | — |
| `hangup` | Нет [1] | Нет | Только окно PiP настольного Chrome [8] | Нет | Кнопка «Завершить» системы |
| Входящий звонок при закрытом приложении, экран звонка ОС | Нет | Нет (Web Push — только уведомление) | Нет | Нет | CallKit+PushKit [24]; Core-Telecom [31] |
| Системный признак «идёт разговор» | Индикатор микрофона в строке состояния | Пока на экране | Уведомление Chrome «использует микрофон» [10] | Так же | Зелёная плашка/уведомление звонка |

## 2. Подробности по платформам

**iOS Safari.** Safari оставляет захват микрофона живым в фоне и при блокировке. В баге 239602
это прямо противопоставлено веб-приложениям с экрана «Домой» [13]. Safari 27.0 (iOS 27) чинит
«AudioSession процесса страницы должна оставаться активной, пока жив захват микрофона» [19].
Значит, механизм — именно захват. Что убивает разговор: входящий обычный звонок или FaceTime
(прерывание аудиосессии), другое приложение, которое забирает микрофон, закрытие Safari из
переключателя, выгрузка процесса по памяти. Переключение на другую вкладку Safari — проверить.
Камеру iOS в фоне не даёт, а `livekit-client` на телефоне сам выключает камеру через 5 с после
скрытия страницы (`LocalVideoTrack.handleAppVisibilityChanged`) [36].
Удалённый звук у нас идёт через WebAudio (`webAudioMix: true`, `web/src/media/session.ts:359`).
На iOS фоновый AudioContext уже ломался (баги 203293, 237878) [16]: без захвата он
останавливается. Это гипотеза для опыта W6.

**iOS, экран «Домой».** Веб-приложения на iOS запускаются не как обычные приложения, а как
системный ViewService [42]. У них нет фонового режима `audio`, и WebKit глушит им захват [14]
(комментарий разработчика WebRTC в WebKit: у WKWebView глушение происходит, когда в
`UIBackgroundModes` нет `audio`). Баг 239602 открыт с 2022 года [13]. Независимое наблюдение на
iOS 26.2 (симулятор, 2026) — то же самое [40]. Фоновое проигрывание обычного `<audio>` у таких
приложений починили в iOS 15.4 [17], но микрофона это не касается. С iOS 26 «На экран „Домой“»
по умолчанию создаёт веб-приложение [20]. Wake Lock там работает с iOS 18.4 [18], но держит
экран, а не процесс.

**Android Chrome.** На время захвата `MediaCaptureNotificationService` запускается как foreground
service типа `camera|microphone` (манифест и `MediaCaptureNotificationServiceImpl`) [10]. Это
ровно то, что Android требует от приложения для звонков: процесс с таким сервисом система не
выгружает при обычной нехватке памяти. Таймеры скрытой вкладки с живым `MediaStreamTrack` в
`RTCPeerConnection` не попадают под «интенсивное» троттлинг (раз в минуту) [12]. Карточки на
экране блокировки для звонка не будет. Chromium помечает WebRTC-плееры как `kOneShot`
(`web_media_player_ms.cc`), а `MediaSessionImpl::IsControllable()` возвращает `false`, если других
плееров нет [11]. Что убивает: агрессивная экономия батареи у части производителей, перехват
микрофона обычным звонком, смахивание Chrome из «Недавних» — проверить. PiP по кнопке есть с
Chrome 105 [6]. Сам Chrome уводит в PiP только видео на весь экран при нажатии «Домой» [9].

**Android PWA.** WebAPK — оболочка, контент исполняет Chrome [39], поэтому поведение то же,
включая уведомление о микрофоне. Отдельного выигрыша для фона установка не даёт.

**ПК (для полноты).** Chrome 120+ вызывает обработчик `enterpictureinpicture` без жеста
пользователя, когда вкладка теряет фокус, если страница захватывает камеру или микрофон [4].
Окно PiP при этом может быть и Document PiP [7] с нашими кнопками. С Chrome 134 так же
сворачиваются и страницы, которые просто играют звук или видео [5]. В окне PiP настольный Chrome
показывает кнопки `togglemicrophone`/`togglecamera`/`hangup` [8].

## 3. Что делаем в вебе сразу

**W1. Системные кнопки (Media Session).** Новый модуль `web/src/media/system-controls.ts`.
Классом `MediaSession` его не называть: так уже называется класс в `session.ts`. Создаётся в
конструкторе `Meeting` рядом с `visibilitychange` (`web/src/core/meeting.ts:107`), а
освобождается в `Meeting.dispose()` (`meeting.ts:430`).
- `navigator.mediaSession.metadata = new MediaMetadata({ title: <название комнаты>, artist:
  'Cord · встреча', artwork: [{ src: '/icon-512.png', sizes: '512x512' }] })`.
- Обработчики, каждый в `try/catch`: неизвестное действие бросает `TypeError`, а в Safari до 27
  бросал и `setActionHandler` [19].
  - `togglemicrophone` → `media.toggle('microphone')`;
  - `togglecamera` → `media.toggle('camera')`;
  - `hangup` → `meeting.leave()` (`meeting.ts:409`);
  - `enterpictureinpicture` → W3.
- Подписка на `media.state`: `setMicrophoneActive(state.microphone)` и `setCameraActive(state.camera)`.
  Обратная связь нужна Safari 18.4+: человек может заглушить микрофон из интерфейса Safari [18].
- При выходе: все обработчики в `null`, `metadata = null`.

**W2. Кнопка «Свернуть в окно» (PiP).** Модуль `web/src/media/pip.ts` и выделенный
`<video playsinline muted autoplay>` в `Stage` (`web/src/ui/Stage.tsx`).
- Источник выбирается по порядку:
  1. демонстрация, которую смотрим (`watchScreen`);
  2. камера говорящего (`media.speaking`);
  3. любая чужая камера;
  4. иначе заглушка `canvas.captureStream()` с аватаром и именем. Для iOS это экспериментально.
- Смена источника — `track.detach(pipVideo)` / `track.attach(pipVideo)` с задержкой не меньше 3 с,
  иначе окно будет прыгать. Адаптивный приём `livekit-client` распознаёт элемент в PiP
  (`isElementInPiP` в `RemoteVideoTrack`) и не отписывает видео у скрытой страницы [36].
- Вызов строго из обработчика нажатия: `video.requestPictureInPicture()`. Если его нет, но есть
  `webkitSupportsPresentationMode?.('picture-in-picture')`, то
  `video.webkitSetPresentationMode('picture-in-picture')` [22].
- Видео не должно быть `display:none`, достаточно маленькой видимой плитки. Слушать
  `enterpictureinpicture`/`leavepictureinpicture`.
- Где кнопка: пульт на телефоне и так на пределе ширины (заметка `cord-web-on-phone`). На iPhone,
  где нет полноэкранного режима, кнопка встаёт на его место у `MeetingView.tsx:516`. В остальных
  случаях — пунктом меню «Ещё» рядом с «Полноэкранный режим» (`MeetingView.tsx:491`).

**W3. Авто-PiP там, где разрешено.** Обработчик `enterpictureinpicture` из W1 вызывает то же, что
кнопка W2. Работает в настольном Chrome 120+ [4]. На Android и iOS безвреден и ничего не делает.
На Android можно отдельно попробовать «говорящий на весь экран» (`requestFullscreen` на видео):
тогда «Домой» уводит его в PiP силами самого Chrome [9]. Проверить, принимает ли Chrome это для
потока WebRTC.

**W4. Честно показывать, что телефон заглушил микрофон.** Подписаться на `mute`/`unmute` у
`MediaStreamTrack` локального микрофона и на `TrackEvent.UpstreamPaused`/`UpstreamResumed`:
`livekit-client` ставит отправку на паузу через 5 с после системного `mute` [36]. Место — рядом с
обработчиком `RoomEvent.TrackMuted` в `session.ts:431`. По возвращении показать плашку: «Пока вас
не было на экране, телефон выключал микрофон — вас не слышали с 12:03 до 12:07». Другим
участникам — пометка на плитке «микрофон приостановлен телефоном» через атрибут участника. Это
закрывает худший случай iOS «Домой»: собеседник слышит тишину и не знает почему.

**W5. Держать захват на телефоне, даже когда микрофон «выключен».** Сейчас тот, кто вошёл с
выключенным микрофоном, вообще не захватывает его (`meeting.ts:120`). Значит, на Android его
вкладку ничего не защищает. Заметка `cord-call-in-pocket` («захват у нас всегда включён») здесь
неточна. Предложение для телефонов: захватывать и публиковать дорожку сразу, но держать её
`muted`. `stopMicTrackOnMute` в `livekit-client` по умолчанию `false`, то есть «выключить
микрофон» не останавливает захват [36]. Так ведут себя нативные звонилки. Цена — индикатор
микрофона горит и при выключенном звуке. Решение за владельцем.

**W6. Опыт с `webAudioMix` на iOS.** Сравнить фоновый звук при `webAudioMix: true` (сейчас) и
`false` (обычные `<audio>`). Если без WebAudio фон держится лучше, ставить `webAudioMix: !isIOS`.

**W7. Честные подсказки** (показывать на телефоне один раз при входе и при первом возвращении
из фона):
- **iPhone, Safari:** «Можно свернуть Safari или заблокировать экран — разговор продолжится, пока
  включён микрофон (оранжевая точка вверху). Камера в это время выключается. Разговор
  прервётся, если придёт обычный звонок или iPhone закроет Safari. Чтобы видеть собеседника
  поверх других приложений — „Свернуть в окно“».
- **iPhone, экран «Домой»** (`navigator.standalone === true`): «Здесь iPhone выключает
  микрофон, как только вы уходите с экрана или блокируете телефон. Для разговора в фоне откройте
  встречу в Safari» и кнопка «Скопировать ссылку». Ссылка той же области в веб-приложении не
  откроется в Safari.
- **В `InstallHint` для iPhone** (`web/src/ui/InstallHint.tsx`) добавить фразу: «Разговор в фоне
  держит только Safari или будущее приложение Cord».
- **Android:** «Можно свернуть браузер или погасить экран: пока в шторке висит „… использует
  микрофон“, разговор идёт. Если телефон закрывает браузер в фоне, снимите для Chrome
  ограничения батареи».
- **Везде, где фон не держится:** «На iPhone разговор в фоне полностью держит только
  приложение» — текст из эпика.

**Не делать:**
- не крутить «тихий звук» ради карточки на экране блокировки (хрупко, а действия звонка на
  Android всё равно не показываются [8][11]);
- не ждать фона от Wake Lock (держит экран) и от service worker: он не держит WebRTC, а ОС
  гасит его первым;
- `navigator.audioSession.type = 'play-and-record'` (Safari 16.4+) [1] — только как опыт, фон
  он не обещает.

## 4. «Полноценный разговор»: нативная оболочка

| Вариант | Что переиспользуем | Экран звонка, фон | PiP | Цена (порядок) | Главный риск |
|---|---|---|---|---|---|
| **Capacitor**, WebRTC в WebView | Весь веб-клиент, включая игры, кинозал и музыку | Android: свой FGS `microphone\|phoneCall` + Core-Telecom [30][31]; iOS: `UIBackgroundModes` audio(+voip) + CallKit через плагин [37] | Android: PiP всей активности (наш интерфейс в окне); iOS: PiP `<video>` в WKWebView, авто-PiP из inline нет [23] | Android 3–5 дней прототипа; iOS 2–3 дня опыта + 1–2 недели CallKit/PushKit с сервером | iOS: WKWebView глушит микрофон в фоне — баг 241480 «независимо от прав» открыт [15], но по [14] с `audio` должно работать, а Safari 27 чинил аудиосессию [19]. Решает только опыт. Связка аудиосессии CallKit с процессами WebKit не документирована |
| **Capacitor + нативный LiveKit** (плагин на Swift/Kotlin держит медиа) | Интерфейс веба, кроме плиток | Полный | Полный | +3–6 недель: плитки — нативные вьюхи поверх WebView | Два владельца комнаты: медиа нативно, состояние в вебе |
| **React Native** + `@livekit/react-native` | Логику на `livekit-client`: RN SDK работает поверх него через `registerGlobals` [34]; `session.ts`, `recovery.ts` частично. Интерфейс переписать | CallKit через callkeep; Android FGS; камера в фоне на iOS 18+ с voip [34] | Нативный | 4–8+ недель только на встречу; игры, кинозал и музыка — отдельно | Две кодовые базы интерфейса (веб и RN) |
| **Swift + Kotlin** + LiveKit SDK | Только сервер | Лучший: пример CallKit от LiveKit [33], Core-Telecom [31] | Лучший | Месяцы, три клиента | Цена и скорость развития |

**Рекомендация: Capacitor, по шагам.** Для Android риск низкий: WebView — тот же Chromium,
foreground service свой, PiP — штатный PiP активности, и это сразу «полноценный разговор»
(уведомление звонка, работа в фоне без ограничений). Для iOS сначала короткий опыт на
устройстве (2–3 дня). Если WKWebView держит микрофон 10 минут при заблокированном экране — iOS тоже на
Capacitor + CallKit. Если нет — iOS-приложение на React Native + LiveKit RN SDK, а Android
остаётся на Capacitor. Либо, если владелец хочет одну оболочку, RN для обеих платформ. Чистый
натив не окупается: у Cord слишком много веб-интерфейса (игры, кинозал, музыка).

**Магазины и аккаунты** (цены проверены по официальным страницам 19.10.2026):
- **Apple Developer Program — 99 USD в год**, в местной валюте, где она доступна [26]. Нужен для
  TestFlight, App Store и push (PushKit). Без него — бесплатная Personal Team в Xcode: до 3
  устройств, профиль живёт 7 дней, нужен Mac [26]. Для опыта на телефоне владельца этого
  хватает. С VoIP-push iOS 13+ обязывает сразу показывать звонок через CallKit, иначе PushKit
  нельзя [24]. Риск: на форумах Apple в 2026 году жалуются, что оплата из России не проходит [41].
- **Google Play — 25 USD один раз** [27]. Новый личный аккаунт перед выпуском обязан провести
  закрытое тестирование: не меньше 12 тестировщиков 14 дней подряд [28]. Каждый тип foreground
  service нужно задекларировать в Play Console с видео [29]. APK можно раздавать и с нашего
  сайта, как сборку для Windows. Но с 30.09.2026 в Бразилии, Индонезии, Сингапуре и Таиланде, а с
  2027 года везде Android требует подтверждённого разработчика и для установки не из Play [32].

## 5. План прототипа

**П0 — без аккаунтов, бесплатно.**
1. `mobile/` — Capacitor 8, `server.url = https://meet.nikg.tech`: прототип грузит прод и не
   требует отдельной сборки. Таймеры WebView при сворачивании Capacitor не останавливает:
   `KeepRunning` по умолчанию `true` [38].
2. Android, разрешения: `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `CAMERA`, `POST_NOTIFICATIONS`,
   `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_PHONE_CALL`,
   `MANAGE_OWN_CALLS`.
3. Foreground service поднимается при входе во встречу, пока приложение на экране. Позже
   нельзя: ограничение while-in-use [30]. Гасится при выходе. Плагин —
   `@capawesome-team/capacitor-android-foreground-service` (умеет тип `microphone`) [37] или
   свой, на 50 строк.
4. Регистрация звонка в Core-Telecom (`CallsManager`, FGS `phoneCall`) [31] и PiP активности по
   кнопке и при уходе с экрана (`setAutoEnterEnabled`).
5. Отладочный APK — владельцу.
6. iOS-опыт: Mac + Xcode + бесплатная Personal Team + iPhone владельца.
   - WKWebView с `allowsInlineMediaPlayback`, `allowsPictureInPictureMediaPlayback`,
     `UIBackgroundModes = [audio, voip]`.
   - Мерить: идёт ли голос в обе стороны после блокировки 1, 5 и 10 минут.
   - Затем исходящий звонок через `CXProvider` / `CXStartCallAction` при входе: остаётся ли
     звук WebRTC после активации аудиосессии CallKit.

**П1 — с аккаунтом Apple ($99).**
- TestFlight.
- PushKit: входящее «вас зовут во встречу» → экран звонка CallKit (`@capgo/capacitor-incoming-call-kit`
  или аналог) [37].
- На сервере — новая часть: отправка VoIP-push в APNs.

**П2 — с аккаунтом Google ($25).**
- Закрытое тестирование 12×14 дней [28], декларации foreground service и full-screen intent с
  видео [29].
- Входящий звонок на Android — FCM high-priority + уведомление full-screen intent.

**Критерий готовности прототипа (из эпика):**
- 10 минут разговора с выключенным экраном, звук в обе стороны;
- экран звонка ОС;
- возврат в приложение без переподключения;
- PiP поверх другого приложения.

**Что владельцу сделать заранее** (в `OWNER-ACTIONS.md`):
- есть ли Mac;
- аккаунт Apple Developer (и способ оплаты);
- аккаунт Google Play и 12 тестировщиков;
- решение по W5.

## 6. Протокол ручной проверки (для владельца)

Подготовка. ПК (Chrome) и телефон в одной тестовой комнате. На ПК включить музыку из интеграции:
так непрерывный звук от сервера слышен без помощника. Голос с телефона проверять по индикатору
говорящего на ПК. Записать модель, версию ОС, браузер и версию Cord (из «Диагностики»). Результаты
переносить в `backlog/screens/E12/checklist.md` как таблицу «шаг — ожидалось — получилось —
минута, когда сломалось».

Повторить шаги 1–8 для каждой среды: iPhone Safari, iPhone «Домой», Android Chrome, Android PWA.

1. Войти с **включённым** микрофоном.
   - Ожидание: iPhone — индикатор микрофона в строке состояния; Android — уведомление Chrome
     «… использует микрофон».
2. Свернуть браузер на 1 минуту, сказать фразу.
   - Ожидание: музыку слышно; на ПК горит индикатор говорящего. Для iPhone «Домой» ожидаем, что
     голоса нет.
3. Заблокировать экран на 10 минут, каждые 2 минуты говорить фразу.
   - Записать минуту, когда пропал звук в каждую сторону.
4. Разблокировать и вернуться.
   - Ожидание: остался во встрече, без «Соединение не восстановилось», связь за ≤ 5 с.
5. Повторить 2–4, **войдя с выключенным** микрофоном (проверка W5).
   - Ожидание сегодня: Android и iPhone могут уснуть.
6. Во время шага 3 позвонить на телефон обычным звонком и сбросить.
   - Вернулся ли звук Cord сам? Нужно ли нажимать что-то в Cord?
7. Во время разговора переключиться на другую вкладку браузера на 1 минуту (iPhone Safari,
   Android Chrome).
   - Слышно ли собеседника, слышит ли он вас?
8. Экран блокировки и шторка: есть ли карточка Cord, какие кнопки, что происходит по нажатию на
   уведомление или индикатор.
9. Только Android: во время разговора смахнуть Chrome (или PWA) из «Недавних». Что с разговором
   через 1 минуту?
10. После W2: нажать «Свернуть в окно», уйти на рабочий стол, открыть другое приложение на 3
    минуты.
    - Ожидание: окно с видео говорящего; смена говорящего меняет картинку не чаще чем раз в 3 с;
      звук идёт.
11. После W2: на ПК (Chrome) переключиться на другую вкладку.
    - Ожидание: PiP открылся сам (W3); в окне кнопки микрофона, камеры и «Завершить», и они
      работают.
12. После W4: на iPhone «Домой» уйти с экрана на 1 минуту и вернуться.
    - Ожидание: плашка «телефон выключал микрофон с … по …»; на ПК была пометка на плитке.

Чего этот протокол не заменяет: замеров на разных производителях Android (Xiaomi, Samsung,
Huawei режут фон по-разному) и на iOS 26 против iOS 27: исправление [19] есть только в 27.

## 7. Что сделано в вебе (E12, 20.10.2026)

Всё из §3, кроме W6 (опыт, нужен iPhone). Код — `web/src/media/background.ts`, `platform.ts`,
`system-controls.ts`, `pip.ts`, связка — `media/session.ts`, интерфейс — `ui/BackgroundNote.tsx`,
`ui/useCallInBackground.ts`, пункт «Свернуть в окно» в `ui/CallDock.tsx`.

| Что | Как | Где видно |
|---|---|---|
| Уход с экрана ничего не рвёт | Дорожки, подписки и соединение не трогаются; окно восстановления стоит (`RecoveryWindow.hold`), как и раньше. Камеру в фоне гасит ОС и `livekit-client`, он же поднимает её по возвращении | — |
| Жизненный цикл страницы | `PageLifecycle`: `visibilitychange`, `freeze`/`resume` (Chrome), `pagehide`/`pageshow` с `persisted` (bfcache) → «ушли» и «вернулись» со временем отсутствия. Молчаливую заморозку Safari видно по перерыву в тиках ≥ 10 с. `pagehide` без `persisted` (выгрузка, перезагрузка) ничего не делает: выход из встречи там не шлётся — на телефоне он приходит и при переключении приложений | журнал: `[cord] page returned from a freeze` |
| Быстрое возвращение | Из заморозки — сразу `resume` SDK (`reconnect-plan.ts`, знак `woke`, T50): сигнальный сокет, скорее всего, уже закрыт сервером, ждать таймаута пинга незачем. Просто свернули — без перезапуска ICE (JS работал, обрыв SDK заметил бы сам). Комната перечитывается (`Meeting.refreshOnReturn`) | `simulateScenario('signal-reconnect')` в журнале SDK |
| Звук собеседников после фона | Свой `AudioContext` на всю встречу (`webAudioMix: { audioContext }`): переживает полное переподключение — раньше SDK создавал новый без жеста, и на iOS он молчал. `AudioWaker` будит его по возвращении, после `statechange` (обычный звонок, Siri — `interrupted`) и на любом касании; если без жеста нельзя — кнопка «Включить звук» | кнопка «Включить звук» на сцене |
| Захват микрофона и выключенным (W5) | Телефон, вошедший с выключенным микрофоном, захватывает его сразу и публикует **заглушённым** (`MediaSession.holdMicrophone`, `mute()` до публикации — в комнату не уходит ни отсчёта). «Включить» — `unmute` той же дорожки. После полного переподключения выключенный, но захваченный микрофон публикуется снова (иначе второй захват и горящий индикатор после встречи). Решение архитектора 16 | индикатор микрофона ОС горит и при выключенном |
| Wake Lock | Держится, пока встреча на экране и: есть видео (своя или чужая камера, демонстрация) — на любой платформе; iPhone «Домой»; телефон без захвата микрофона. Голосовой разговор с захваченным микрофоном экран не держит: телефон в кармане — нормальный разговор (`wantsWakeLock`) | экран не гаснет по таймеру при видео |
| Системные кнопки (W1, W3) | Media Session: `togglemicrophone`, `togglecamera`, `hangup`, `enterpictureinpicture`, `setMicrophoneActive`/`setCameraActive`, название встречи в метаданных. Настольный Chrome 120+ сам открывает окно PiP при уходе с вкладки | окно PiP настольного Chrome с кнопками; Safari 18.4+ — микрофон из интерфейса Safari |
| «Свернуть в окно» (W2) | Пункт меню пульта, если есть чья-то картинка и браузер умеет PiP. Свой `<video>` вне React, заряженный заранее: демонстрация, которую смотрим → камера говорящего → любая чужая камера; смена не чаще раза в 3 с. Safari — `webkitSetPresentationMode`, если нет стандартного | меню «…» пульта |
| Честные подсказки (W4, W7) | Один раз на устройстве, через 3 с после подключения: iPhone Safari, iPhone «Домой» (с кнопкой «Скопировать ссылку» — открыть в Safari), Android, телефон без доступа к микрофону. По возвращении — «телефон выключал микрофон, вас не слышали с 12:03 до 12:07» по событиям `mute`/`unmute` дорожки (только когда микрофон был включён человеком). `InstallHint` на iPhone предупреждает, что «Домой» не держит разговор в фоне | плашка над пультом |
| Маяк встречи (E02) | Уход в bfcache — «ушёл», возвращение — «снова здесь»; окончательно прощается только выгрузка | «Вы уже во встрече» в соседней вкладке |
| Мост с приложением | `core/mobile-app.ts`: `window.Capacitor` (без `@capacitor/core` в сборке) + метка `CordApp/` в User-Agent; `CordCall.start/stop`, события `command` | — |

**Не сделано и почему.** Пометка «микрофон приостановлен телефоном» на плитке у других (W4,
вторая половина) — нужен атрибут участника и право его менять в токене; плашка у самого человека
закрывает главное. Заглушка-аватар в окне PiP для голосового разговора (`canvas.captureStream`) — на
iOS экспериментально; без чьей-то камеры пункта «Свернуть в окно» нет. W6 (`webAudioMix: !isIOS`) —
только опытом на iPhone (шаг 14 ниже).

**Проверено:** модульные тесты — `media/background.test.ts` (жизненный цикл, заморозка, Wake Lock,
подсказки, перерывы микрофона, будильник звука), `platform.test.ts`, `system-controls.test.ts`,
`pip.test.ts`, `reconnect-plan.test.ts` (`woke`), `session.test.ts` («разговор в фоне»: свернули —
без resume, заморозка — resume, окно стоит, захват заглушённым до публикации, ПК не захватывает, отказ
в доступе — без ошибки), `core/active-meeting.test.ts` (bfcache), `core/mobile-app.test.ts`,
`ui/background-note.test.tsx`. **Не проверено:** всё, что зависит от настоящего телефона, — протокол
§6 и шаги 13–17 ниже.

**Дополнение к протоколу §6** (те же среды, плюс «приложение Cord для Android»):

13. Войти с **выключенным** микрофоном (W5). Ожидание: индикатор микрофона ОС горит; в комнате
    микрофон выключен; погасить экран на 10 минут — разговор (музыка с ПК) идёт; включить микрофон —
    слышно сразу, без запроса доступа.
14. iPhone Safari, W6: шаги 2–4 в двух вариантах — как есть и с `webAudioMix: false` (сборка с
    правкой в `session.ts`). Записать, где собеседника слышно дольше.
15. Видеозвонок: не трогать экран 2 минуты — экран не гаснет (Wake Lock). Голосовой — гаснет по
    таймеру, разговор идёт.
16. iPhone «Домой»: уйти с экрана на 1 минуту и вернуться — плашка «телефон выключал микрофон
    с … по …»; кнопка «Скопировать ссылку» в подсказке копирует ссылку встречи.
17. Во время разговора принять и сбросить обычный звонок, вернуться в Cord — собеседника слышно сам
    (или по кнопке «Включить звук»), без перезахода.

## 8. Приложение для Android: сборка и проверка

Прототип П0 из §5 — `mobile/`. Capacitor 8.5 (`@capacitor/android`, Gradle 8.14, AGP 8.13, JDK 21),
`minSdk 24`, `targetSdk 36`, пакет `tech.nikg.cord`.

**Как устроено.**
- `capacitor.config.json` → `server.url = https://cord.nikg.tech` (стенд — решение В-6; на прод —
  поменять там и в `www/offline.html` и пересобрать). Интерфейс грузится с сервера: правка веба не
  требует новой сборки APK. `appendUserAgent: CordApp/0.1` — признак приложения для страницы.
- `CordCallPlugin` (`window.Capacitor` → `CordCall`): `start({title, microphone})` поднимает или
  обновляет `CallService`, `stop()` гасит, событие `command` (`hangup`/`microphone`) — нажатия в
  уведомлении. Страница зовёт его из `ui/useCallInBackground.ts`, пока медиа подключено или
  восстанавливается.
- `CallService` — foreground service `microphone` с уведомлением «Идёт разговор · микрофон
  включён/выключен», часами разговора и кнопками «Выключить микрофон» и «Завершить». Стартует, пока
  приложение на экране (while-in-use, Android 14). Обновление уведомления — мимо
  `startForegroundService` (его нельзя звать из фона). Смахнули приложение — служба гаснет. Не
  поднялась (нет `RECORD_AUDIO`) — разговор идёт как в Chrome, в журнале тег `CordCall`.
- `MainActivity` — PiP всего окна при уходе «Домой», пока идёт разговор (Android 12+ сам,
  `setAutoEnterEnabled`; 8–11 — из `onUserLeaveHint`). Страница в окне видима, камера не гаснет.
- Разрешения: `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `CAMERA`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS`. Доступ к микрофону и камере спрашивает
  Capacitor на запрос страницы (`BridgeWebChromeClient`), к уведомлениям — плагин при первом
  разговоре.
- Чего ещё нет (следующий шаг П0): регистрации звонка в Core-Telecom (FGS `phoneCall`,
  `MANAGE_OWN_CALLS`, экран звонка ОС), входящих (FCM, П2), подписи релиза.

**Сборка в CI.** `.github/workflows/android.yml` — на изменение `mobile/**` и вручную
(`workflow_dispatch`): `ubuntu-24.04`, JDK 21, Node 24, `npm ci` → `npx cap sync android` →
`./gradlew assembleDebug` → артефакт `cord-android-debug` (`app-debug.apk`, 14 дней). Скачать:
Actions → «Android app» → прогон → Artifacts, или `gh run download <id> -n cord-android-debug`.

**Сборка руками** (Android Studio или только SDK: `platforms;android-36`, `build-tools;36.0.0`, JDK 21
в `JAVA_HOME`, `ANDROID_HOME` на SDK):

```bash
cd mobile
npm ci
npx cap sync android        # копирует www и конфиг, пишет подключение плагинов
cd android
./gradlew assembleDebug     # → app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

На машине стенда APK не собирался: 7 ГБ памяти, из них свободно около 2 ГБ при пяти параллельных
сессиях, а Gradle с Android SDK просит столько же — сборка выталкивала бы соседей в swap. Java-код
проверен только разбором `javac` без SDK; компиляцию проверяет CI.

**Проверка на телефоне** (протокол §6 для среды «приложение», плюс):
1. Установить APK (разрешить установку из этого источника), открыть, войти во встречу — запрос
   микрофона (и камеры) от Android, затем уведомлений. В шторке — «Идёт разговор» с часами.
2. Погасить экран на 10 минут, говорить каждые 2 минуты — звук в обе стороны всё время (критерий
   эпика). Записать модель: Xiaomi, Huawei, Samsung режут фон по-своему.
3. «Выключить микрофон» в уведомлении — в Cord микрофон выключен, текст уведомления сменился;
   «Завершить» — выход из встречи, уведомление пропало.
4. Во время разговора нажать «Домой» — окно Cord поверх рабочего стола (PiP); открыть другое
   приложение на 3 минуты — разговор идёт; нажать на окно — вернуться без переподключения.
5. Смахнуть Cord из «Недавних» — уведомление пропало, собеседник видит уход (через окно
   восстановления).
6. Звук — из динамика, а не из разговорного (Chromium в WebView сам выбирает устройство вывода;
   если окажется в разговорном — нужен `AudioManager` в плагине).

## 9. iPhone: план (только документ)

По решению архитектора 16 iOS-оболочку не пишем, пока нет опыта с WKWebView на устройстве. Шаги (нужны
Mac с Xcode и iPhone владельца; для опыта хватает бесплатной Personal Team, см. `OWNER-ACTIONS.md`):

1. `npx cap add ios` в `mobile/` (тот же `capacitor.config.json` и `server.url`). В `Info.plist`:
   `UIBackgroundModes = [audio, voip]`, `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`;
   у WKWebView — `allowsInlineMediaPlayback` и `allowsPictureInPictureMediaPlayback`.
2. Опыт: войти, заблокировать на 1, 5 и 10 минут, говорить — слышно ли в обе стороны (баги WebKit
   241480 и 226620, §2). Тот же опыт на iOS 26 и 27 (исправление [19] есть только в 27).
3. Если держит — плагин `CordCall` для iOS: `AVAudioSession` `playAndRecord`/`voiceChat`, исходящий
   звонок `CXProvider`/`CXStartCallAction` при входе, `CXEndCallAction` → событие `hangup` в страницу;
   проверить, что звук WebRTC не рвётся после активации аудиосессии CallKit. Страница уже готова: тот же
   мост `core/mobile-app.ts` (`isNativePlatform`, `nativePromise`, `addListener`).
4. Если не держит — iOS на React Native + `@livekit/react-native` (§4), Android остаётся на Capacitor.
5. С аккаунтом Apple — TestFlight, затем PushKit для входящих (П1).

## 10. Источники

Первоисточники, кроме [40] и [41] (вторичные, помечены).

1. MDN browser-compat-data: Media Session — `togglemicrophone`, `hangup`, `setMicrophoneActive`, `enterpictureinpicture` (рядом `AudioSession.json`, `WakeLock.json`) — https://github.com/mdn/browser-compat-data/blob/main/api/MediaSession.json
2. MDN BCD: `requestPictureInPicture` — Chrome 69, Chrome Android 105, Safari 13.1, Firefox 153 — https://github.com/mdn/browser-compat-data/blob/main/api/HTMLVideoElement.json
3. MDN BCD: Document PiP — Chrome 116, Firefox 151, на телефонах нет — https://github.com/mdn/browser-compat-data/blob/main/api/DocumentPictureInPicture.json
4. Chrome: автоматический PiP для видеозвонков (Chrome 120, ПК) — https://developer.chrome.com/blog/automatic-picture-in-picture
5. Chrome: автоматический PiP при воспроизведении (Chrome 134, ПК) — https://developer.chrome.com/blog/automatic-picture-in-picture-media-playback
6. Chrome Platform Status: `enterpictureinpicture` (ПК 120, Android —) https://chromestatus.com/feature/6245717716238336 · кнопки видеозвонка (ПК 92) https://chromestatus.com/feature/5744304695803904 · PiP API (Android 105) https://chromestatus.com/feature/5729206566649856
7. Chrome: Document Picture-in-Picture — https://developer.chrome.com/docs/web-platform/document-picture-in-picture
8. web.dev: Media Session («video conferencing actions are available only in Chrome … on desktop») — https://web.dev/articles/media-session
9. Chrome: PiP на Android (видео на весь экран + «Домой» → PiP) — https://developer.chrome.com/blog/picture-in-picture
10. Chromium: `chrome/android/java/AndroidManifest.xml` (`MediaCaptureNotificationService`, `foregroundServiceType="camera|microphone"`), `MediaCaptureNotificationServiceImpl.java` — https://source.chromium.org/chromium/chromium/src/+/main:chrome/android/java/AndroidManifest.xml
11. Chromium: `web_media_player_ms.cc` (`kOneShot`), `media_session_impl.cc` (`IsControllable`) — https://source.chromium.org/chromium/chromium/src/+/main:content/browser/media/session/media_session_impl.cc
12. Chrome: Heavy throttling of chained JS timers (исключение для WebRTC) — https://developer.chrome.com/blog/timer-throttling-in-chrome-88
13. WebKit bug 239602: веб-приложения «Домой» теряют микрофон в фоне, Safari — нет — https://bugs.webkit.org/show_bug.cgi?id=239602
14. WebKit bug 226620: WKWebView глушит захват без `audio` в `UIBackgroundModes`; «Домой» сломан (2024) — https://bugs.webkit.org/show_bug.cgi?id=226620
15. WebKit bug 241480: WKWebView теряет микрофон в фоне «независимо от прав» (NEW) — https://bugs.webkit.org/show_bug.cgi?id=241480
16. WebKit bug 237878: AudioContext останавливается на iOS в фоне — https://bugs.webkit.org/show_bug.cgi?id=237878
17. WebKit bug 198277 → 232909: фоновый звук веб-приложений «Домой» (починен в iOS 15.4) — https://bugs.webkit.org/show_bug.cgi?id=198277
18. WebKit Features in Safari 18.4: MediaSession capture mute API, Wake Lock в веб-приложениях «Домой» — https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
19. WebKit Features for Safari 27.0: AudioSession при живом захвате микрофона; `setActionHandler` не бросает — https://webkit.org/blog/18325/webkit-features-for-safari-27-0/
20. WebKit, News from WWDC25 (Safari 26): любой сайт с экрана «Домой» открывается как веб-приложение — https://webkit.org/?p=16993
21. WebKit bug 268732: PiP для потоков камеры на iOS (исправлено в 03.2024); см. также 252765 — https://bugs.webkit.org/show_bug.cgi?id=268732
22. WebKit `HTMLVideoElement.idl` (`webkitSetPresentationMode`) — https://github.com/WebKit/WebKit/blob/main/Source/WebCore/html/HTMLVideoElement.idl
23. Apple Developer Forums, ответ DTS (03.2026): авто-PiP из inline в WKWebView не работает — https://developer.apple.com/forums/thread/819235
24. Apple: Responding to VoIP Notifications from PushKit (iOS 13+: без CallKit PushKit нельзя) — https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit
25. Apple: Accessing the camera while multitasking — https://developer.apple.com/documentation/avkit/accessing-the-camera-while-multitasking-on-ipad
26. Apple Developer Program, 99 USD в год — https://developer.apple.com/programs/whats-included/ · Personal Team — https://developer.apple.com/support/compare-memberships/
27. Google Play Console: регистрация, US$25 один раз — https://support.google.com/googleplay/android-developer/answer/6112435
28. Google Play: тестирование для новых личных аккаунтов (12 тестировщиков, 14 дней) — https://support.google.com/googleplay/android-developer/answer/14151465
29. Google Play: декларация foreground service и full-screen intent — https://support.google.com/googleplay/android-developer/answer/13392821
30. Android: типы foreground service (`microphone`, `phoneCall`, `camera`, while-in-use) — https://developer.android.com/develop/background-work/services/fgs/service-types
31. Android: Core-Telecom (`CallsManager`, FGS `phoneCall`) — https://developer.android.com/develop/connectivity/telecom/voip-app/telecom
32. Android developer verification (30.09.2026 — четыре страны, 2027 — везде) — https://developer.android.com/developer-verification
33. LiveKit Swift SDK, «Integration with CallKit» — https://github.com/livekit/client-sdk-swift · пример — https://github.com/livekit-examples/swift-example-collection/tree/main/callkit
34. LiveKit React Native SDK (поверх `livekit-client`; камера в фоне — voip и iOS 18) — https://github.com/livekit/client-sdk-react-native · https://docs.livekit.io/transport/sdk-platforms/react-native.md
35. LiveKit docs, Swift quickstart (`UIBackgroundModes` audio) — https://docs.livekit.io/transport/sdk-platforms/swift.md
36. `livekit-client` 2.22.3 (`web/node_modules/livekit-client/src`): `room/defaults.ts` (`stopMicTrackOnMute: false`), `track/LocalVideoTrack.ts` (камера на телефоне гаснет в фоне), `track/RemoteVideoTrack.ts` (`isElementInPiP`), `track/LocalTrack.ts` (пауза отправки через 5 с после `mute`)
37. Плагины Capacitor — https://capgo.app/docs/plugins/incoming-call-kit/ · https://capawesome.io/plugins/android-foreground-service/
38. Capacitor `Bridge.java` (`onPause` → `handlePause(keepRunning)`) — https://github.com/ionic-team/capacitor/blob/main/android/capacitor/src/main/java/com/getcapacitor/Bridge.java
39. web.dev: WebAPKs on Android — https://web.dev/articles/webapks
40. *Вторичный:* ghostly PR #1377 (iOS 26.2, симулятор: микрофон веб-приложения «Домой» глушится) — https://github.com/MiguelMedeiros/ghostly/pull/1377
41. *Вторичный:* Apple Developer Forums, оплата программы из России (2026) — https://developer.apple.com/forums/thread/813530
42. WebKit bug 254545: веб-приложения «Домой» — «not UIApplications but ViewServices» (Wake Lock, 2023) — https://bugs.webkit.org/show_bug.cgi?id=254545
