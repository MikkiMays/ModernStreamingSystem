# Ревью 1.0.3 — состояние задач

План — `PLAN.md` (потоки W, очередь §3, матрица §4). Состояния: `ждёт` / `в работе (агент, дата)` / `готово (дата)` / `частично: …` / `ждёт владельца: …`. Доказательство — путь к скринам `backlog/screens/R103/<поток>/`, имя теста/спека, ссылка на прогон, запись живого замера.

| № | Поток | Состояние | Доказательство |
| --- | --- | --- | --- |
| R01 | W1 | готово, выкачено (22.10, `5b4858d`) | music-sync: заглушка 0 %, замороженный слушатель вернулся; `journal/2026-10-22-review-I1.md` |
| R02 | W1 | готово, выкачено (22.10, `5b4858d`) | music-sync: 160 кбит/с ровно, без провалов; `journal/2026-10-22-review-I1.md` |
| R03 | W1, W4 | готово, выкачено (22.10, `5b4858d`) | music-sync: разброс буфера 2–65 мс; кинозал — подтяжка `nudgeRate`; `journal/2026-10-22-review-I1.md` |
| R04 | W1, W1b | частично (22.10) | издатель/служба переживают обрыв и замирание (975f0c5, c03a6b5); метрики и зонд — W1b |
| R05 | W1b, W1 | ждёт | |
| R06 | W1 | готово, выкачено (22.10, `5b4858d`) | блоки удалены (a6f428f), запас зашит 500/600/1000 |
| R07 | W1 | готово, выкачено (22.10, `5b4858d`) | screen-preview: превью дошло через ядро; `journal/2026-10-22-review-I1.md` |
| R08 | W1 | готово, выкачено (22.10, `5b4858d`) | удалено из логики и настроек (a36aeaf, a6f428f) |
| R09 | W1, W6 | готово, выкачено (22.10, `5b4858d`) | 1 Кбит/с = тишина издателя (метки RTP по стенным часам); сейчас 160 кбит/с; `journal/2026-10-22-review-I1.md` |
| R10 | W1b | ждёт | |
| R11 | W0, W2 | готово, выкачено (22.10, `44bd785`) | `Settings.test.tsx`, `focus-modality.spec` против стенда |
| R12 | W2 | готово, выкачено (22.10, `44bd785`) | `scroll-spy.test.ts`, e2e «подсветка подраздела» |
| R13 | — | заменена R78 (владелец, 22.10) | — |
| R14 | W0, W2 | готово, выкачено (22.10, `44bd785`) | `live-value.ts`, `scripts/slider-perf.mjs`: ≤ 1 записи на кадр, 0 кадров > 50 мс |
| R15 | W2 | готово, выкачено (22.10, `44bd785`) | e2e: |Δy| заголовка и крестика ≤ 2 px |
| R16 | W2 | готово, выкачено (22.10, `44bd785`) | тест «группы не сворачиваются (R16)» |
| R17 | W0 | готово, выкачено (22.10, `44bd785`) | см. W0 |
| R18 | W2 | готово, выкачено (22.10, `44bd785`) | скрины `backlog/screens/R103/W2/{before,after}` |
| R19 | W2 | готово, выкачено (22.10, `44bd785`) | e2e: центр ±2 px (ru, it, главная, встреча) |
| R20 | W3, W5 | готово, выкачено (24.10, `f893a81`) | PING строкой в потоке: подвал главной (HomeShell/DesktopHome), строка о встрече; e2e `desktop.spec` «строка под входом, position static»; `meeting-header.test.tsx` «PING — в строке о встрече» |
| R21 | W2 | готово, выкачено (22.10, `44bd785`) | убран «Боты справа от встречи» |
| R22 | W2, WD2 | готово, выкачено (22.10, `44bd785`) | плашки нет; статусы оболочки кодами (`desktop.test.ts`) |
| R23 | W0, W2 | готово, выкачено (22.10, `44bd785`) | отмена мышью без кольца (S1) |
| R24 | W2 | готово, выкачено (22.10, `44bd785`) | второй щелчок отменяет запись (`Settings.test.tsx`) |
| R25 | W2 | готово, выкачено (22.10, `44bd785`) | «Сбросить» ×8 |
| R26 | W0 | готово, выкачено (22.10, `768aef9`) | e2e `focus-modality.spec.ts` 8/8 против стенда (на старом main 6 из 7 падали); `ui/input-modality.test.ts` 35; скрины `backlog/screens/R103/W0/{before,after}/focus-*` |
| R27 | W3, W5 | встреча — готово, выкачено (24.10, `f893a81`); игры (покер, дурак) — готово, выкачено (24.10, `d178c87`) | игры: с сукна покера ушли `.poker-linger` и лобби-`Waiting`, у дурака — `durak.hint.{watch,paused}`; `poker-seating.test.tsx`, `durak-table.test.tsx` (R27), e2e `poker-results` (срок в шапке) против стенда через `stand-dev`; `review-1.0.3/shots/poker-*`. Встреча: убраны invite-hint, OnceHint ×2, liveUpdating (в журнал), советы фона android/iosSafari/noMicrophone, «до 23:00», «кинозал 80 %», retention на телефоне; `background-note.test.tsx`, `onboarding*.test`, `notices.test.tsx`; `screens/R103/W3/{before,after}/meeting-one-390-*` |
| R28 | W0 (+ владельцы экранов) | частично: проход 1 выкачен (`768aef9`) — токены значков/волосков, `Button`/`IconButton` 16/20/24; проход 2 — владельцы экранов | `kit.test.tsx`, `Menu.test.tsx`; `screens/R103/I3/meeting-*` |
| R29 | W6, W2, W7, W4 | ждёт | |
| R30 | W3 | готово, выкачено (24.10, `f893a81`) | `stage-overlay.test.tsx` (8): чипы по снимку, пустой слой `aria-hidden`, без дубля того, что на сцене; слот `children` под мини-плеер W4 |
| R31 | W4 | ждёт | |
| R32 | W4 | ждёт | |
| R33 | W4 | ждёт | |
| R34 | W3, WD2 | веб — готово, выкачено (24.10, `f893a81`); живое (перетаскивание, 125–150 %) — WD2/OWNER-ACTIONS | `core/titlebar.test.ts`, e2e `titlebar-overlay.spec.ts` (зелёный против стенда через `scripts/stand-dev.mjs`) |
| R35 | W5 | ждёт | |
| R36 | W5 | ждёт | |
| R37 | W6 | ждёт | |
| R38 | W6 | ждёт | |
| R39 | W4 | ждёт | |
| R40 | W4 | ждёт | |
| R41 | W4 | ждёт | |
| R42 | W4 | ждёт | |
| R43 | W4 | ждёт | |
| R44 | W4 | ждёт | |
| R45 | W5 | готово, выкачено (24.10, `d178c87`) | у не севшего нет `.poker-controls`; «Раздать можно, когда двое» — `title`/`aria-describedby` кнопки; проверка раздачи — в «Настройках игры»; `poker-seating.test.tsx` (3 новых), e2e `poker`, `poker-phone` против стенда (`stand-dev`); `review-1.0.3/shots/poker-spectator-*` |
| R46 | W5 | готово, выкачено (24.10, `d178c87`) | `ui/poker/table-status.ts` + `table-status.test.ts` (7); `[data-table-status]` в шапке, на телефоне — второй строкой; e2e `poker-results` 1/1 против стенда; `review-1.0.3/shots/poker-bar-*` |
| R47 | W6 | готово, выкачено (24.10, `0b5bcac`, `gateway`) | `c88bed7`: подзаголовка нет, ключ `diagnostics.description` убран ×8; `ui/diagnostics.test.tsx` «без подзаголовка», e2e `diagnostics-help.spec.ts` (1/1 против стенда через `stand-dev`); `review-1.0.3/shots/r47-diagnostics-*` |
| R48 | W6 | готово, выкачено (24.10, `0b5bcac`, `gateway`) | `c88bed7`, `cb74aaa`: окно набора `Dialog lg`, «Подробности аудио и видео» — раздел с `<h3>`, дорожки карточками, сводки «подпись — значение» двумя колонками, отступы токенами (`ui/diagnostics.css`), подвал с «Помощью» всегда на виду (kit: части окна по своим строкам сетки); `ui/diagnostics.test.tsx` (без `details/summary`, дорожка карточкой), e2e `diagnostics-help.spec.ts`; `review-1.0.3/shots/r48-details-*` |
| R49 | W6 | готово, выкачено (24.10, `0b5bcac`, `gateway`) | `c88bed7`: одно окно «Помощь» на корне (`ui/support/HelpHost.tsx`, `help.ts`), открывшее окно закрывается само — диагностика, настройки («О программе»), выдвижная панель телефона; во встрече окна — одно состояние `layer`; `support/help-host.test.tsx` (5), `home.test.tsx` (панель), e2e `diagnostics-help.spec.ts` (1/1 против стенда через `stand-dev`: диагностика закрыта, помощь — верхнее окно `elementFromPoint`, фокус в ней, обращение (подменённое) ушло, «Открыть диагностику» — обратно); `review-1.0.3/shots/r49-help-*` |
| R50 | W6 | готово, выкачено (24.10, `0b5bcac`, `gateway`) | `6254d41`: строка, ключи `settings.about.{author,telegram}`, `settings.rows.about-author` ×8 и строка карты убраны; `Settings.test.tsx` «О программе»; `review-1.0.3/shots/r50-about-*` |
| R51 | W6 | ждёт | |
| R52 | исследование | готово как решение (22.10): `docs/research/2026-10-21-discord-study.md` §3, DECISIONS Р-8; DFN3 отложен | |
| R53 | W7 | готово, выкачено (24.10, `0b5bcac`, `gateway`) | `f04bdb9`: окно набора с «Сохранить» в подвале (выключена и выглядит выключенной, без «Ничего не поменялось»), «Кто может войти» — сегмент + строка выбранного, щит в строку; `ui/meeting-settings.test.tsx` (4), e2e `diagnostics-help.spec.ts`; `review-1.0.3/shots/r53-meeting-settings-*` |
| R54 | W7 | готово, выкачено (24.10, `0b5bcac`, `gateway`) | `f04bdb9`: `meeting.settings.description` убран ×8; `meeting-settings.test.tsx`, e2e |
| R55 | W7 | готово, выкачено (24.10, `0b5bcac`, `gateway`) | `f04bdb9`: `Switch` вместо галочки в настройках встречи и на предвходе, X4 — «Приложить диагностику», «Автоподключение» (окно и меню комнаты); `meeting-settings.test.tsx`, `favorite-settings.test.tsx`, `home.test.tsx`, `support.test.tsx`, e2e `meeting` (предвход), `support`, `desktop`; `review-1.0.3/shots/r55-{prejoin,support}-*` |
| R56 | W7 | готово, выкачено (24.10, `0b5bcac`, `gateway`) | `f04bdb9`: «Иначе кинозал и музыку добавляете и убираете только вы.» ×8 (как на предвходе), без «галочки» и «Громкость каждый…»; `meeting-settings.test.tsx`, e2e |
| R57 | WD1 | готово (22.10): релиз `desktop-v1.0.4`, зеркало `/downloads/windows/desktop/latest.yml` = 1.0.4; живая проверка на Windows — OWNER-ACTIONS | CI `desktop.yml` 39752311530 (test-installer: «Крестик: Cord жив, окно спрятано в трей», tray.ico 5+1 записей, AUMID `tech.cord.desktop`) |
| R58 | WD1 | готово (22.10): релиз `desktop-v1.0.4`, зеркало `/downloads/windows/desktop/latest.yml` = 1.0.4; живая проверка на Windows — OWNER-ACTIONS | CI `desktop.yml` 39752311530 (test-installer: «Крестик: Cord жив, окно спрятано в трей», tray.ico 5+1 записей, AUMID `tech.cord.desktop`) |
| R59 | WD1, W3 | оболочка — релиз 1.0.4; веб — готово, выкачено (24.10, `f893a81`); toast вживую — OWNER-ACTIONS | `core/desktop-notify.test.ts` (14), `core/meeting.test.ts` «уведомления Windows», `core/desktop-bridge.test.ts` (схема `contracts/desktop-bridge.v2.schema.json`) |
| R60 | W7, WD2 | веб — готово в ветке `review/prejoin` (24.10), не выкачено (`ef27202`); оболочка — окно выбора удалено в `review/desktop-wd2a` (`2ad92d7`) | окно показа — единственное: вкладки «Приложения · Весь экран · Устройства» (камеры, кроме своей; карта захвата — как показ, со своим звуком), «Звук компьютера» слева, сводка, «Чёткость / Плавность», шестерёнка (качество 720/1080/1440 × 30/60, превью, режим звука), одна «Показать»; выбор помнится в `preferences.screen` (+ `audio`); `ui/capture-picker.test.tsx` (8), `core/preferences.test.ts`, `media/capture.test.ts` (`deviceCapture`); e2e `capture-picker.spec.ts` (мост v2 подменён) против стенда через `stand-dev` 1/1; `review-1.0.3/shots/r60-picker-{before,after}-*` (1440, 768, обе темы) |
| R61 | WD1 | готово (22.10): релиз `desktop-v1.0.4`, зеркало `/downloads/windows/desktop/latest.yml` = 1.0.4; живая проверка на Windows — OWNER-ACTIONS | CI `desktop.yml` 39752311530 (test-installer: «Крестик: Cord жив, окно спрятано в трей», tray.ico 5+1 записей, AUMID `tech.cord.desktop`) |
| R62 | WD2 | ждёт | |
| R63 | WD2 | ждёт | |
| R64 | WD1, WD2 | частично: установщик с выбором языка → `Bootstrap.language` в 1.0.4; веб — контракт и проверка порядка языков в ветке `review/W3`; `oneClick` (R105) — WD2 | `core/desktop-bridge.test.ts` «язык из установщика» |
| R65 | W5 | ждёт | |
| R66 | исследование | готово (21.10): `docs/research/2026-10-21-discord-study.md`; §2.9 — W1c | |
| R67 | W-CI | готово (22.10): `main` `5333578`, CI зелёный | прогон `verify.yml` после `5333578` |
| R68 | W1b | ждёт | |
| R69 | W-int | ждёт | |
| R70 | W5 | ждёт | |
| R71 | W5 | ждёт | |
| R72 | W7 | готово в ветке `review/prejoin` (24.10), не выкачено (`da9c0c2`) | зонтичная — R73, R74, R76; «Перед разговором» — kit `Dialog` не выше окна, без подзаголовка, качество сегментами (R78); `ui/prejoin.test.tsx` (5: 720p · 30 по умолчанию, отказ устройства под превью, команда создания); `review-1.0.3/shots/r72-settings-{before,after}-*` |
| R73 | W7 | готово в ветке `review/prejoin` (24.10), не выкачено (`da9c0c2`) | в 1280×714 всё в окне, кнопка входа видна, превью и форма с одной линии (разница верхов ≤ 8 px), полоса `html` не нужна; e2e `meeting.spec` «предвход помещается в любое окно…»; `review-1.0.3/shots/r76-prejoin-{before,after}-1280x714-*` |
| R74 | W7 | готово в ветке `review/prejoin` (24.10), не выкачено (`da9c0c2`) | ×8 убраны «айбрау», «Проверьте, как вас видят…», «Название можно будет поменять…», пояснения под доступом, «Иначе кинозал…», «Это можно поменять и потом…», наушники, заметка о разрешении (отказ — строкой под превью после отказа), «Ссылка и QR…», подзаголовок «Перед разговором»; «Кто может войти» — сегмент «Сразу по ссылке / С подтверждения», интеграции — `Switch`; `ui/prejoin.test.tsx`, e2e `meeting.spec`, `return-and-settings.spec` (радио «С подтверждения») |
| R75 | W0 | готово, выкачено (22.10, `768aef9`) | `focus-modality.spec` «меню избранного» |
| R76 | W7 | готово в ветке `review/prejoin` (24.10), не выкачено (`da9c0c2`) | `ui/prejoin.css`: размеры плавно от ширины (`cqi`) и высоты (`dvh`), одна точка 2 → 1 колонка (контейнер 720), кнопка входа `sticky` к низу окна; e2e `meeting.spec`: 46 размеров 320…2560 × 480/600/714/720/900 + 2560×1440 — без горизонтальной прокрутки, кнопка в окне целиком, колонки с одной линии, превью в окне; проходы шагом 10 px по ширине (320→2560) и высоте (480→1440, 390×480→1000) — скачков > 25 px нет, кроме перехода колонок; против стенда через `stand-dev` и в CI 40121394385 (зелёный); `review-1.0.3/shots/r76-prejoin-{before,after}-{1440,390,1280x714}-*` |
| R77 | W3 | готово, выкачено (24.10, `f893a81`) | `call-dock.test.tsx` (класс danger, MonitorX), e2e `screens.spec` (кнопка красная); на телефоне — красная кнопка на своей плитке; `screens/R103/W3/after/meeting-share-*` |
| R78 | W1c, W2, W7 | медиа готово (22.10); UI настроек готов в ветке `review/W2` (сегменты 720/1080/1440 × 30/60, `QualityFields {kind,value,onChange,ceiling}`, `CAMERA_DEFAULT`); окно показа — W7 | `Settings.test.tsx` «Видео (R100, R78)», `preferences.test.ts` «камера: умолчание 720p30…», e2e `return-and-settings` (радио) |
| R79 | W6 | ждёт | |
| R80 | W1c, W7, W2 | медиа и «Видео» — выкачено; переключатель в окне показа — готово в ветке `review/prejoin` (24.10), не выкачено (`ef27202`) | «Показывать превью зрителям» в шестерёнке окна показа — то же поле `preferences.screen.preview`; `ui/capture-picker.test.tsx` (R80), e2e `capture-picker.spec.ts` (выключенное превью ушло в профиль показа) |
| R81 | W1c, W7 | готово, выкачено (22.10, `5b4858d`); «Остановить показ» во время разгона показа — готово в ветке `review/prejoin` (24.10), не выкачено (`ef27202`) | screen-stop: 127 мс; `journal/2026-10-22-review-I1.md`; нажатие до кадра целевого размера раньше пропадало (`screenBusy`) — `media/session.test.ts` «Остановить показ во время разгона…» (красный до правки), e2e `capture-picker.spec.ts` |
| R82 | W7, W2, WD2 | частично: n05 (окно показа Телемоста) — готово в ветке `review/prejoin` (24.10), не выкачено (`ef27202`); n04, n06–n11 — WD2, n08/n09 — W2 | сетка миниатюр, выбранная — обводкой акцента, «Звук компьютера» слева внизу, одна главная кнопка; `review-1.0.3/shots/r60-picker-after-*` |
| R83 | W3 | готово, выкачено (24.10, `f893a81`) | корень: в сетке закрепление ставило лишь `inset`-рамку, которую закрывал кадр, а «Открепить» не было; `core/meeting.test.ts`, `stage-pin.test.tsx` (5), e2e `stage-pin.spec.ts` двумя браузерами через SFU — зелёный; `screens/R103/W3/after/meeting-pinned-*` |
| R84 | W3 | готово, выкачено (24.10, `f893a81`) (живой телефон — OWNER-ACTIONS) | e2e `stage-pin.spec.ts` на 390: крупная плитка и лента в viewport, «Открепить» ≥ 44 px, 0 переполнения, «Говорящий»; двое в сетке — две половины |
| R85 | W1c | частично (22.10) | медиа-часть выкачена; нативный путь — WD2 по воротам |
| R86 | W5 | ждёт | |
| R87 | W3 | готово, выкачено (24.10, `f893a81`) | `core/meeting.test.ts` «непрочитанные в чате», `call-dock.test.tsx` (кружок, «9+», телефон — на «ещё») |
| R88 | W1c | частично (22.10) | кодек/режимы выкачены; живой показ с GPU — у владельца |
| R89 | W1c | частично (22.10) | как R88 |
| R90 | W1c | готово (22.10) | MEDIA-DIAGNOSIS §9 — ответ |
| R91 | W1c | готово, выкачено (22.10, `5b4858d`) | `hold.ts`/`upstream.ts` удалены, `maintain-resolution`, один слой |
| R92 | W1c | готово (22.10) | MEDIA-DIAGNOSIS §9 — ответ |
| R93 | WD2 | ждёт | |
| R94 | W4 | ждёт | |
| R95 | W1c, W7 | режимы в профиле выкачены (22.10); UI — готово в ветке `review/prejoin` (24.10), не выкачено (`ef27202`) | сегмент «Чёткость / Плавность» в окне показа, сводка «Чёткость · 1080p · до 60 fps»; `ui/capture-picker.test.tsx` |
| R96 | W1c | частично (22.10) | MEDIA §9 решения внедрены; нативный путь — WD2 |
| R97 | W1c | готово, выкачено (22.10, `5b4858d`) | `MediaRoomCloser` afterCommit; RoomServiceTest, MediaRoomCloserTest |
| R98 | W1c | готово, выкачено (22.10, `5b4858d`) | screen-latency: 1150 мс; `journal/2026-10-22-review-I1.md` |
| R99 | W1c, WD2 | частично (22.10) | ворота WD2 |
| R100 | W2 | готово, выкачено (22.10, `44bd785`) | `AudioSection`, `VideoSection` с превью камеры; скрины `backlog/screens/R103/W2/{before,after}` |
| R101 | W2 | готово, выкачено (22.10, `44bd785`) | e2e: каждый раздел без прокрутки 1280×800 и 1440×900 |
| R102 | W1c | готово (22.10) | учтено в §9 |
| R103 | WD2 | оболочка — ветка `review/desktop-wd2a`; сторона ядра — готово в ветке `review/prejoin` (24.10), не выкачено (`1322be8`) | веб шлёт `state.language` (i18n.resolvedLanguage, `core/desktop-state.ts`), `chat.open` открывает чат встречи (`ui/useTrayChat.ts`); схема `contracts/desktop-bridge.v2.schema.json`: `chat.open`, `$defs/state` с `language`, `appSettings.notifications`, `hotkeysStatus` с кодами global / global-raw / taken / duplicate / window-only — сверено с `bridge.ts`, `tray-menu.ts`, `hotkeys.ts` ветки оболочки; `core/desktop-bridge.test.ts` (R103), `core/desktop.test.ts`, `ui/tray-chat.test.tsx` |
| R104 | WD2 | ждёт | |
| R105 | WD2 | ждёт | |
| R106 | W1b | готово, выкачено (24.10, `1df8ec5`) | `RateFallbackTest` (5); метрика `cord_rate_limiter_fallback_total`, алерт `RateLimiterFallback` |
| R107 | W1 | готово, выкачено (24.10, `1df8ec5`; livekit пересоздан с cpu_shares 4096); полностью — после выделенных ядер (R10) | `e2e/media/voice-probe.spec.ts`: 3 % потерь + 40±30 мс — заглушка 0,08 %, обрывов > 60 мс нет, переподписок 0; «пробка» — переподписка в паузе; `MEDIA-DIAGNOSIS.md` §10. Клиенту 1.0.6 — RED с двумя копиями (`force-fieldtrials`) |
| R108 | durak | готово, выкачено (24.10, `d178c87`); на стенде e2e durak и poker зелёные после выкатки | ядро: `awaited` вместо `canThrow`, нет `cornered`/`AUTO_TAKE_MS`/`DurakSeat.auto`, срок хода всегда полный; `DurakTest` «стол одинаков, есть ли у игрока что подкинуть» (два стола, одна скрытая карта — равные снимки на каждом шаге) и ещё 5; на старом ядре 11 новых тестов красные; веб без подписей и `data-auto`; e2e `durak` 1/1 против стенда (веб ветки через `stand-dev`, ядро стенда ещё старое); T07 отменено в `DECISIONS.md` |
| R109 | durak | готово, выкачено (24.10, `d178c87`) | `useVoiceTier` → `data-speaking`/`data-voice` у места дурака, оттенки — общие с покером (`ui/seat-rings.css`); `durak-table.test.tsx` (R109); `review-1.0.3/shots/durak-rings-*` |
| R110 | durak | готово, выкачено (24.10, `d178c87`; время хода 30 с по умолчанию, 15/30/45 — `27743d3`) | общий `ui/TurnRing.tsx` (покер и дурак) от `actionAt`/`deadline` и `serverNow()`; кольцо у каждого, кого ждут, видно зрителям; 30 с по умолчанию, выбор 15/30/45 (`Durak.TURN_STEPS`, чужое значение — к ближайшей ступени); `DurakTest` (2), `durak-table.test.tsx` (3), `poker-seating.test.tsx` (кольцо); `review-1.0.3/shots/durak-rings-*` |
| R111 | durak | готово, выкачено (24.10, `d178c87`) | выход по очереди опустевших рук (`Seat.emptied`), ничьей нет — дурак последний избавившийся; `draw` убран из снимка и итогов (старые записи читаются); `DurakTest` — 8 концовок (2 и 3 игрока, перевод, старая запись); веб и история без «ничьей» ×8 |
| R112 | W4 | продуктовая часть готова, выкачено (24.10, `f008ef1`, `services gateway`): на стенде `cord_cinema_reachable` = 1 у всех пяти площадок, e2e против стенда `cinema-catalog`, `cinema-link`, `watch` — 13/13 (7 из них — перепрогоном после лимита новых встреч за час); выход YouTube для Москвы через `CINEMA_PROXY_YOUTUBE` — отложен владельцем | службы: `cinema/reach.py` — автомат площадки (2 пробы подряд по 2,5 с или 3 сбоя/срока подряд → `503 CINEMA_UNREACHABLE` сразу, без yt-dlp; проверка через 30 с…5 мин; проба через прокси площадки), срок 25 с каталог / 30 с разбор, полоса yt-dlp 6 из 8 потоков, `providers.code`, метрики `cord_cinema_reachable` и др.; `test_cinema_reach.py` (31), все 802 теста служб (`--network none`); веб: отметка вкладки и плитки, «Повторить», срок браузера 30/35 с, 8 языков; `ui/cinema/reach.test.tsx`, vitest 1327/1327; живьём: служба ветки в контейнере с «чёрной дырой» на `CINEMA_PROXY_YOUTUBE` — YouTube отказ за 0,01 с через ~10 с после старта, Rutube 0,4 с, VK 0,9 с, Twitch 0,3 с; без дыры YouTube поиск 2,9–3,9 с, разбор 3,2 с; e2e через `stand-dev` (веб ветки, службы стенда): `watch` 2/3 (первый — пульт уснул до клика гостя после 2 мин настоящего YouTube), `cinema-catalog` 2/2, `cinema-panel` «unavailable» 1/1, `cinema-rutube` и `cinema-vk` — обход каталога и «VK catalogue is down» 3/3; живой прогон ветки: Rutube 1,4 с, VK 3,0 с, YouTube 5,6 с, отказ «YouTube недоступен с этого сервера» с «Повторить», срок браузера 30,9 с; `review-1.0.3/shots/r112-*` |
| R113 | W1 | готово, выкачено (24.10, `1df8ec5`) | на стенде после выкатки: баланс ушей 0 дБ, заглушка 0 %, обрывов 0; voice-probe с `--left-only` + RNNoise: разница ушей 0 дБ, публикация моно; `downmix.test.ts`, `audio.test.ts` |
| R114 | settings-texts | готово, выкачено (24.10, `0b5bcac`, `gateway`) | `73f7aaf`: «Звук» → «Микрофон» ×8 (прежнее имя — в ключевых словах поиска), частые вопросы ведут в «Видео» / «Микрофон» / «Микрофон → Динамики»; `sections.test.ts`, `Settings.test.tsx`, `screens.test.tsx` (en, zh-Hans), e2e `settings-accounts` 6/6 через `stand-dev`; `review-1.0.3/shots/r114-settings-*` |
| R115 | settings-texts | готово, выкачено (24.10, `0b5bcac`, `gateway`) | `f5b7f35`, `cef9a50`: прокручивать нечего — остаётся выбранный щелчком, у низа — последний, у верха — первый, иначе линия трети; `scroll-spy.test.ts` (три группы), `Settings.test.tsx` (разметка окна), e2e `settings-accounts` «без прокрутки — выбранный щелчком»; `review-1.0.3/shots/r115-{bottom,fits}-*` |

## Сквозные правила

| № | Состояние | Доказательство |
| --- | --- | --- |
| X1 | ждёт (проверяется на каждой точке интеграции) | |
| X2 | ждёт | |
| X3 | ждёт | |
| X4 | частично: готово, выкачено (24.10, `0b5bcac`, `gateway`) — последние галочки бинарного выбора (предвход, настройки встречи, обращение, избранное: окно и меню) → `Switch`/`MenuSwitchItem`; вид своих переключателей покера и дурака — R28 | `f04bdb9` |
| X5 | ждёт | |
| X6 | ждёт | |
| X7 | ждёт | |
| X8 | ждёт | |
| X9 | ждёт | |
| X10 | ждёт | |
| X11 | действует с 22.10 (очередь `PLAN.md` §3) | |

## Точки интеграции

| Точка | Что | Состояние |
| --- | --- | --- |
| I0 | W-CI → `main` | готово (`5333578`) |
| I1 | W1 → `main`, выкатка №1 | готово (22.10): `5b4858d`, `deploy.sh core gateway services`, livekit RED; замеры — `journal/2026-10-22-review-I1.md` |
| 1.0.4 | WD1 → релиз, зеркало | готово (22.10): `abb8aac`, релиз `desktop-v1.0.4`, зеркало обновлено |
| I2 | W1c → `main`, выкатка №2 | объединено с I1 (`5b4858d`) |
| I3 | W0 → `main`, выкатка №3 | готово (22.10): `768aef9`, `deploy.sh gateway`; против стенда focus-modality, kit, home-shell, meeting — 16/16; vitest 1215/1215; заодно `efd1f8a` — тест HLS под новую настройку (красный CI после I1) |
| I4 | W2 → `main`, выкатка №4 | ветка `review/W2` готова (22.10), ждёт слияния архитектором |
| I5 | W3 → `main`, выкатка №5 | готово (24.10): `775e503`/`f893a81`, `deploy.sh gateway`; против стенда stage-pin, meeting, screens, focus-modality, home-shell — 17/17 |
| I6 | W1b → `main`, выкатка с дренажем | ждёт |
| I7 | W7 → `main`, выкатка №7 | ветка `review/prejoin` готова (24.10): R72–R74, R76, R60 (веб), R80, R82 (n05), R95 (UI), R103 (ядро); выкатка — `gateway` |
| I8 | W4 → `main`, выкатка №8 | ждёт |
| I9 | W6 → `main`, выкатка №9 | ждёт |
| I10 | W5 → `main`, выкатка №10 | ждёт |
| I11 | WD2 → `main` обеих реп, выкатка №11, релиз 1.0.5 | ждёт |
| I12 | W-int: полные прогоны, документы, финал | ждёт |
