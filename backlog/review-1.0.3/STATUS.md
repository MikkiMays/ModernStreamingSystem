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
| R11 | W0, W2 | готово в ветке `review/W2` (22.10), ждёт I4 | `Settings.test.tsx` «открыто мышью — фокус на заголовке…»; `focus-modality.spec` 8/8 против ветки |
| R12 | W2 | готово в ветке `review/W2` (22.10), ждёт I4 | `scroll-spy.test.ts` (числа CODEMAP), `Settings.test.tsx` «щелчок по якорю…», e2e `settings-accounts` «подсветка подраздела» |
| R13 | — | заменена R78 (владелец, 22.10) | — |
| R14 | W0, W2 | готово в ветке `review/W2` (22.10), ждёт I4 | шаг 1 у всех ползунков настроек; `Settings.test.tsx` «ползунок (R14)», `preferences.test.ts`; `scripts/slider-perf.mjs`: 0 кадров > 50 мс, ≤ 1 запись/кадр — `screens/R103/W2/after/slider-perf.{json,png}` (с blur(6px) — 177 кадров > 50 мс: `slider-perf-with-blur6.*`) |
| R15 | W2 | готово в ветке `review/W2` (22.10), ждёт I4 | e2e `settings-accounts` «окно по центру, крестик в строке заголовка» (Δy ≤ 2, вне прокрутки); `screens/R103/W2/after` |
| R16 | W2 | готово в ветке `review/W2` (22.10), ждёт I4 | `Settings.test.tsx` «группы не сворачиваются (R16)»; `screens/R103/W2/after` |
| R17 | W0 | готово, выкачено (22.10, `768aef9`) | `scroll-activity.test.ts`, e2e полоса ≤ 10 px; `screens/R103/W0/after/scrollbars/*` |
| R18 | W2 | готово в ветке `review/W2` (22.10), ждёт I4 | `screens/R103/W2/{before,after}` 390/1024/1440 обе темы и 1280×720/1440×720 |
| R19 | W2 | готово в ветке `review/W2` (22.10), ждёт I4; Electron 125–150 % — живое (OWNER-ACTIONS) | e2e `settings-accounts`: центр ±2 px — главная 1280×800/1920×1080, встреча, it |
| R20 | W3, W5 | готово в ветке `review/W3` (22.10), ждёт I5 | PING строкой в потоке: подвал главной (HomeShell/DesktopHome), строка о встрече; e2e `desktop.spec` «строка под входом, position static»; `meeting-header.test.tsx` «PING — в строке о встрече» |
| R21 | W2 | готово в ветке `review/W2` (22.10), ждёт I4 | `sections.test.ts` «лишних строк нет», `appearance-bots` удалён; поле `showIntegrationPanel` читается как «да», чтение во встрече убирает W3 |
| R22 | W2, WD2 | веб готово в ветке `review/W2` (22.10): плашки нет, коды → `hotkeyStatusText` ×8; коды в оболочке — WD2 | `Settings.test.tsx` «плашки … нет», `desktop.test.ts` «состояние сочетания — кодом оболочки» |
| R23 | W0, W2 | готово в ветке `review/W2` (22.10), ждёт I4 | `focus-modality.spec` «запись сочетания»; второй щелчок — R24 |
| R24 | W2 | готово в ветке `review/W2` (22.10), ждёт I4 | `Settings.test.tsx` «второй щелчок по «Esc — отмена» отменяет запись» |
| R25 | W2 | готово в ветке `review/W2` (22.10), ждёт I4 | `Settings.test.tsx` «одна кнопка «Сбросить»», `desktop-section.test.tsx` (оверлей: «Сбросить» = снять) |
| R26 | W0 | готово, выкачено (22.10, `768aef9`) | e2e `focus-modality.spec.ts` 8/8 против стенда (на старом main 6 из 7 падали); `ui/input-modality.test.ts` 35; скрины `backlog/screens/R103/W0/{before,after}/focus-*` |
| R27 | W3, W5 | встреча — готово в ветке `review/W3` (22.10), ждёт I5; игры (покер, дурак) — W5 | убраны invite-hint, OnceHint ×2, liveUpdating (в журнал), советы фона android/iosSafari/noMicrophone, «до 23:00», «кинозал 80 %», retention на телефоне; `background-note.test.tsx`, `onboarding*.test`, `notices.test.tsx`; `screens/R103/W3/{before,after}/meeting-one-390-*` |
| R28 | W0 (+ владельцы экранов) | частично: проход 1 выкачен (`768aef9`) — токены значков/волосков, `Button`/`IconButton` 16/20/24; проход 2 — владельцы экранов | `kit.test.tsx`, `Menu.test.tsx`; `screens/R103/I3/meeting-*` |
| R29 | W6, W2, W7, W4 | ждёт | |
| R30 | W3 | готово в ветке `review/W3` (22.10), ждёт I5 | `stage-overlay.test.tsx` (8): чипы по снимку, пустой слой `aria-hidden`, без дубля того, что на сцене; слот `children` под мини-плеер W4 |
| R31 | W4 | ждёт | |
| R32 | W4 | ждёт | |
| R33 | W4 | ждёт | |
| R34 | W3, WD2 | веб — готово в ветке `review/W3` (22.10), ждёт I5; живое (перетаскивание, 125–150 %) — WD2/OWNER-ACTIONS | `core/titlebar.test.ts`, e2e `titlebar-overlay.spec.ts` (зелёный против стенда через `scripts/stand-dev.mjs`) |
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
| R45 | W5 | ждёт | |
| R46 | W5 | ждёт | |
| R47 | W6 | ждёт | |
| R48 | W6 | ждёт | |
| R49 | W6 | ждёт | |
| R50 | W6 | ждёт | |
| R51 | W6 | ждёт | |
| R52 | исследование | готово как решение (22.10): `docs/research/2026-10-21-discord-study.md` §3, DECISIONS Р-8; DFN3 отложен | |
| R53 | W7 | ждёт | |
| R54 | W7 | ждёт | |
| R55 | W7 | ждёт | |
| R56 | W7 | ждёт | |
| R57 | WD1 | готово (22.10): релиз `desktop-v1.0.4`, зеркало `/downloads/windows/desktop/latest.yml` = 1.0.4; живая проверка на Windows — OWNER-ACTIONS | CI `desktop.yml` 39752311530 (test-installer: «Крестик: Cord жив, окно спрятано в трей», tray.ico 5+1 записей, AUMID `tech.cord.desktop`) |
| R58 | WD1 | готово (22.10): релиз `desktop-v1.0.4`, зеркало `/downloads/windows/desktop/latest.yml` = 1.0.4; живая проверка на Windows — OWNER-ACTIONS | CI `desktop.yml` 39752311530 (test-installer: «Крестик: Cord жив, окно спрятано в трей», tray.ico 5+1 записей, AUMID `tech.cord.desktop`) |
| R59 | WD1, W3 | оболочка — релиз 1.0.4; веб — готово в ветке `review/W3` (22.10), ждёт I5; toast вживую — OWNER-ACTIONS | `core/desktop-notify.test.ts` (14), `core/meeting.test.ts` «уведомления Windows», `core/desktop-bridge.test.ts` (схема `contracts/desktop-bridge.v2.schema.json`) |
| R60 | W7, WD2 | ждёт | |
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
| R72 | W7 | ждёт | |
| R73 | W7 | ждёт | |
| R74 | W7 | ждёт | |
| R75 | W0 | готово, выкачено (22.10, `768aef9`) | `focus-modality.spec` «меню избранного» |
| R76 | W7 | ждёт | |
| R77 | W3 | готово в ветке `review/W3` (22.10), ждёт I5 | `call-dock.test.tsx` (класс danger, MonitorX), e2e `screens.spec` (кнопка красная); на телефоне — красная кнопка на своей плитке; `screens/R103/W3/after/meeting-share-*` |
| R78 | W1c, W2, W7 | медиа готово (22.10); UI настроек готов в ветке `review/W2` (сегменты 720/1080/1440 × 30/60, `QualityFields {kind,value,onChange,ceiling}`, `CAMERA_DEFAULT`); окно показа — W7 | `Settings.test.tsx` «Видео (R100, R78)», `preferences.test.ts` «камера: умолчание 720p30…», e2e `return-and-settings` (радио) |
| R79 | W6 | ждёт | |
| R80 | W1c, W7, W2 | медиа готово (22.10); переключатель «Превью показа» в «Видео» — в ветке `review/W2`; окно показа — W7 | `Settings.test.tsx` «Видео…» (`preferences.screen.preview`) |
| R81 | W1c | готово, выкачено (22.10, `5b4858d`) | screen-stop: 127 мс; `journal/2026-10-22-review-I1.md` |
| R82 | W7, W2, WD2 | ждёт | |
| R83 | W3 | готово в ветке `review/W3` (22.10), ждёт I5 | корень: в сетке закрепление ставило лишь `inset`-рамку, которую закрывал кадр, а «Открепить» не было; `core/meeting.test.ts`, `stage-pin.test.tsx` (5), e2e `stage-pin.spec.ts` двумя браузерами через SFU — зелёный; `screens/R103/W3/after/meeting-pinned-*` |
| R84 | W3 | готово в ветке `review/W3` (22.10), ждёт I5 (живой телефон — OWNER-ACTIONS) | e2e `stage-pin.spec.ts` на 390: крупная плитка и лента в viewport, «Открепить» ≥ 44 px, 0 переполнения, «Говорящий»; двое в сетке — две половины |
| R85 | W1c | частично (22.10) | медиа-часть выкачена; нативный путь — WD2 по воротам |
| R86 | W5 | ждёт | |
| R87 | W3 | готово в ветке `review/W3` (22.10), ждёт I5 | `core/meeting.test.ts` «непрочитанные в чате», `call-dock.test.tsx` (кружок, «9+», телефон — на «ещё») |
| R88 | W1c | частично (22.10) | кодек/режимы выкачены; живой показ с GPU — у владельца |
| R89 | W1c | частично (22.10) | как R88 |
| R90 | W1c | готово (22.10) | MEDIA-DIAGNOSIS §9 — ответ |
| R91 | W1c | готово, выкачено (22.10, `5b4858d`) | `hold.ts`/`upstream.ts` удалены, `maintain-resolution`, один слой |
| R92 | W1c | готово (22.10) | MEDIA-DIAGNOSIS §9 — ответ |
| R93 | WD2 | ждёт | |
| R94 | W4 | ждёт | |
| R95 | W1c, W7 | частично (22.10) | режимы в профиле выкачены; UI — W7 |
| R96 | W1c | частично (22.10) | MEDIA §9 решения внедрены; нативный путь — WD2 |
| R97 | W1c | готово, выкачено (22.10, `5b4858d`) | `MediaRoomCloser` afterCommit; RoomServiceTest, MediaRoomCloserTest |
| R98 | W1c | готово, выкачено (22.10, `5b4858d`) | screen-latency: 1150 мс; `journal/2026-10-22-review-I1.md` |
| R99 | W1c, WD2 | частично (22.10) | ворота WD2 |
| R100 | W2 | готово в ветке `review/W2` (22.10), ждёт I4 | `Settings.test.tsx` «Звук (R100)», «Видео (R100, R78)», «камера недоступна», «закрытие окна отпускает камеру»; `screens/R103/W2/after/settings-*-звук-*`, `*-видео-*` |
| R101 | W2 | готово в ветке `review/W2` (22.10), ждёт I4 | e2e `settings-accounts` «каждый раздел помещается в окно без прокрутки» (1280×800, 1440×900); `screens/R103/W2/after/report.json` `contentOverflowY` = 0 и при 1280×720 |
| R102 | W1c | готово (22.10) | учтено в §9 |
| R103 | WD2 | ждёт | |
| R104 | WD2 | ждёт | |
| R105 | WD2 | ждёт | |
| R106 | W1b | ждёт | |

## Сквозные правила

| № | Состояние | Доказательство |
| --- | --- | --- |
| X1 | ждёт (проверяется на каждой точке интеграции) | |
| X2 | ждёт | |
| X3 | ждёт | |
| X4 | ждёт | |
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
| I5 | W3 → `main`, выкатка №5 | ветка `review/W3` готова (22.10), ждёт слияния архитектором |
| I6 | W1b → `main`, выкатка с дренажем | ждёт |
| I7 | W7 → `main`, выкатка №7 | ждёт |
| I8 | W4 → `main`, выкатка №8 | ждёт |
| I9 | W6 → `main`, выкатка №9 | ждёт |
| I10 | W5 → `main`, выкатка №10 | ждёт |
| I11 | WD2 → `main` обеих реп, выкатка №11, релиз 1.0.5 | ждёт |
| I12 | W-int: полные прогоны, документы, финал | ждёт |
