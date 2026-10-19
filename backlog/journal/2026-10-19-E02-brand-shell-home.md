# E02 — бренд, шапка, главная (T24, T01, T25, T35, T40, T41, T46, T52-интерфейс)

19.10.2026, сессия Claude (Opus 5.5), worktree `.claude/worktrees/agent-a5bc99c36e73c41a6`, ветка
`worktree-agent-a5bc99c36e73c41a6` от `main` c44ec64 (затем слит `main` d6f75fc). Спецификация —
`docs/superpowers/specs/2026-10-19-brand-shell-home.md`, решения — `DECISIONS.md` → «Решено агентом — E02».
Параллельно идёт WP1 (личность, `409 ALREADY_IN_MEETING`, пределы, `Snapshot.startedAt`): веб E02 написан
против контракта и читает новые поля защитно.

## Что сделано

**Ядро (T40, V8)** — субагент Opus по заданному контракту, без коммитов; свёл и закоммитил я.
`V8__favorite_groups.sql`, `room/FavoriteGroupService`, `api/FavoriteGroupController`; в `FavoriteService` —
только запись `Favorite` (+`groupId`, `pinned`, `alias`) и чтение списка через `LEFT JOIN` (висячая группа →
`null`), `key()` стал пакетным. OpenAPI: `groupId`/`alias` nullable. Ручки и коды — в спецификации и
`docs/architecture.md` → «Избранное».

**Веб.**
- T24/T01: все места E02 берут марку из `ui/brand`; `public/favicon.svg` перерисован геометрией `AppIcon`
  (раньше полосы стояли вертикально), цвета манифеста — фон загрузки. Бургер и марка узкой главной на одной оси.
- T25: `ui/MeetingHeader.tsx` — без «В эфире»; состояния у названия; `data-media-status` на `.meeting-page`;
  17 файлов e2e ждут атрибут вместо текста (кинозальные `.cinema-live` не тронуты — это другое «В эфире»).
- T35: время рядом с кодом от `startedAt` по `serverNow()`; `core/people.ts` — люди без ботов.
- T41: `ThemeButton` удалён отовсюду; тема — в настройках.
- T40: `ui/home/*` — боковая панель с группами, меню на ПКМ/касании/«…», перетаскивание, Alt+↑/↓,
  «N из 10», подтверждение «Убрать»; `useFavoriteShelf` — оптимистичные правки поверх TanStack Query
  (идущее чтение отменяется до правки — иначе ответ, ушедший раньше, затирал новую группу).
- T46: `home-sidebar` 240–400/280 и `meeting-panel` 320–480/360 — `usePanelWidth` + `ResizeHandle` набора.
- T52: `core/active-meeting.ts` + `ui/useMeetingBeacon.ts` + `ActiveMeetingNotice` — «вы здесь» и «Вернуться»
  (перенос встречи из соседней вкладки тем же участником). Диалог на 409 — за WP1.
- Миграция на токены/набор по E16 §7: шапка встречи, главная, вход, `DesktopHome`, подключение, скачивание.
  В новых и переписанных файлах (`home.css`, `shell.css`, `meeting-header.css`, `home-entry.css`,
  `desktop-home.css`) нет ни hex, ни `rgb()`, ни `!important`, ни литеральных размеров шрифта. Мёртвые
  правила прежней главной и шапки удалены из `styles.css`, `accessibility.css`, `room-layout.css`,
  `room-polish.css` (скриптом по списку классов, которых больше нет в TSX). `css-audit` по всему `web/src`:
  hex 616 → 596, размеров шрифта 597 → 591.
- Удалены `ui/favorite-reorder.tsx` и его тест: порядок теперь — общий порядок разделов (`place`, `nudge`).

## Счётчики участников (что каждый теперь считает)

| Место | Было | Стало |
| --- | --- | --- |
| Значок «Участники» в пульте, пункт меню на телефоне | `!p.service` (с ждущими) | `humans()` — то же правило из одного места |
| Подсказка «Самое время пригласить своих» | `participants.length === 1` — бот музыки прятал её | `humans().length === 1` |
| Список «В этой встрече» (`Sidebar.tsx`) | `!p.service` | не тронут (E04 переписывает панель) — правило совпадает |
| Плитки (`Stage.tsx`), кинозал (`ad-breaks.ts`), звуки (`room-cues.ts`) | свои фильтры `service` | не тронуты, правило совпадает с `core/people.ts` |
| Telegram, витрина интеграций | в службе | не в этой ветке |

## Проверки

| Проверка | Код выхода | Примечание |
| --- | --- | --- |
| `npx vitest run --pool=forks --maxWorkers=1 --testTimeout=60000` tokens, breakpoints, download, home, meeting-header, favorite-groups, active-meeting, meeting-clock, people | 0 | 9 файлов, 61 тест |
| Ядро: `mvn -B -pl server fmt:check test -Dtest='FavoriteGroups*,FavoriteOrderTest,ContractsValidationTest,ArchitectureTest'` | 0 | 26 тестов; Postgres-вариант в этом запуске пропущен (Ryuk) |
| Ядро: то же с `--network host -e TESTCONTAINERS_RYUK_DISABLED=true -Dtest=FavoriteGroupsPostgresTest` | 0 | 9/9 на PostgreSQL 18 (`knowledge/memory/cord-testcontainers-on-host.md`) |
| то же после правок по ревью: home, meeting-header, tokens, breakpoints | 0 | 4 файла, 27 тестов |
| `npx tsc -b` | 0 | первый прогон — 1: тест главной без обязательного `quality` (исправлено слиянием `main` 9015602) |
| `npx prettier --check` по всем тронутым файлам веба и e2e | 0 | |
| `node scripts/shots.mjs --screens home,download --widths 360,768,1024,1440,2560` (dev-сервер + мок ядра с группами) | 0 | 20 снимков, переполнения нет (`backlog/screens/E02/after/`, каталог в `.gitignore` — снимки локальные) |
| Шапка встречи: dev-сервер против стенда, 1440/768/360 | — | состояние «Связь восстанавливается…» у названия, переполнения нет; на 360 найдено и исправлено: длинное название залезало под звезду |

e2e не запускались (финальная волна): `e2e/home-shell.spec.ts` (новый), `return-and-settings.spec.ts`
(избранное из панели), 17 файлов с ожиданием эфира.

## Ревью

Субагент-ревьюер (`feature-dev:code-reviewer`) по диффу веба нашёл, исправлено: пункт «Автоподключение»
не перерисовывался и оставлял меню открытым (e2e повис бы на подложке меню) — своё состояние и
`closeOnClick`; меню на телефоне открывались под выдвижной панелью (панель была на слое диалога 50, меню
— 40) — панель и подсказка установки на `--z-dock`; Alt+↓ терял фокус (React переносит узел строки) —
фокус возвращается после шага; незавершённое нажатие навсегда выключало перетаскивание — заменяется
новым, отпущенная кнопка сбрасывает; заголовок встречи ведущего внутри кнопки переставал быть заголовком
для диктора — `h1` отдельно, карандаш-кнопка поверх строки.

## Ждёт WP1

- `Snapshot.startedAt` — без него времени в шапке нет; e2e «часы идут» пропускается сам.
- `Capabilities.favoritesMax` и `409 FAVORITES_FULL` — счётчик и звезда уже читают `favoritesMax` (без поля —
  10); текст подсказки звезды («В избранном уже 10 комнат. Уберите одну, чтобы добавить эту») сверить с
  `detail` ядра.
- `409 ALREADY_IN_MEETING` + `X-Cord-Leave` — диалог делает WP1; `core/active-meeting.ts` даёт ему, какая
  встреча идёт в соседней вкладке.
- При слиянии с WP1 возможен конфликт в `FavoriteService` (запись `Favorite`, `list()`, `key()`); группы —
  в отдельных классах. Регенерация контрактов — очередь 3.2, после WP1 и E08: схемы `Group`, `GroupTitle`,
  `GroupOrder`, `FavoriteSettings`, поля `Favorite.groupId|pinned|alias`; после неё `core/favorite-groups.ts`
  может брать типы из `generated.ts` вместо защитного чтения.

## Не проверено

- e2e против стенда, живые группы на стенде (ядро с V8 не выкачено).
- Перетаскивание мышью вживую (только код и e2e-сценарий); долгое касание на телефоне для меню.
- Шапка встречи в состоянии «всё хорошо» со временем — на стенде нет `startedAt`, а dev-сервер не доходит
  до эфира.
- Клиент Windows (WinUI): `DesktopHome` перекрашен на токены, но в WebView не смотрелся.
