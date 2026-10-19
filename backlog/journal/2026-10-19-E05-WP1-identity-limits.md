# E05 шаги 6–7 + E02 (ядро) — WP1 «Личность и пределы»: профиль устройства, одна встреча (T52), 20 человек и 10 в избранном (T06), `startedAt`

19.10.2026, сессия Claude (Opus 5.5), worktree `.claude/worktrees/agent-aed85d9fb49ab3504`, ветка
`worktree-agent-aed85d9fb49ab3504` от локального `main` bdc817b. Источник решений —
`docs/architecture/target-2026-10.md` §1.2, §1.3, §2.1, §3.1 (строки 2–5), §4.3 WP1. Решения, где архитектура
молчит или где пришлось отступить, — `DECISIONS.md` → «Решено агентом — WP1».

## Что сделано

**Ядро.**
- `access/Identity` + `access/Entrant`: `X-Cord-Profile` → `profileHash = SHA-256(секрет)`, `X-Cord-Leave` →
  `roomId`; не похожее на секрет/UUID — как отсутствие. Пять дверей (`create`, `join`, `joinCode`, `rejoin`,
  `joinSaved` через `/favorites/{id}/join`) получают `Entrant`; старые сигнатуры остались для служб и тестов.
- T52 — `RoomService.oneMeeting` после `lockGlobal()` и проверки места: живое участие профиля
  (`RoomState.engages`: место занято и срок восстановления не вышел) в другой открытой встрече →
  `409 ALREADY_IN_MEETING {roomId, title}`; `X-Cord-Leave`, называющий ровно её, — обычный выход (`depart`, как
  по кнопке; `room.changed` + `RoomChanged` той встрече) и вход в одной транзакции. Профиль — в
  `RoomState.profiles`, не в `Member` (откат, WP1-1); `Member` получил `ignoreUnknown`.
- T06: `max-participants: 20` считает только людей (`Member.human()`, `RoomState.seatedHumans()`), бот музыки
  места не занимает; `@Max(50)`; текст `ROOM_FULL` с числом. `max-rooms: 8` считает встречи с человеком на связи
  или моложе 30 с (`RoomState.busy`). Избранное — `stream.favorites.max-saved: 10` под общим замком →
  `409 FAVORITES_FULL {max}`; сохранённое сверх предела не удаляется. `capabilities.favoritesMax`.
- `startedAt` (T35, П7): `RoomState.markStarted` — второй человек `CONNECTED` (`media.restored`, вебхук
  `participant_joined`, проход `observe`); сброс при повторном открытии сохранённой встречи; `RoomState` NON_NULL,
  `Snapshot.startedAt` NON_NULL / nullable / не required.
- `Problem` несёт свойства, `ApiErrors` кладёт их в ответ RFC 7807.
- `application.yml`: `max-participants ${STREAM_MAX_PARTICIPANTS:20}`, `max-rooms ${STREAM_MAX_ROOMS:8}`,
  `favorites.max-saved ${FAVORITES_MAX_SAVED:10}`, `meeting.one-active-per-profile ${ONE_ACTIVE_MEETING_PER_PROFILE:true}`.
- `scripts/configure.mjs`: LiveKit `room.max_participants` = `STREAM_MAX_PARTICIPANTS` (20) + 4; локальный
  `infra/livekit.local.yaml` — 24; `smoke.mjs` ждёт 20. Миграции нет: профиль живёт в JSON комнаты, избранное и
  так ключуется `profile_hash` (V8–V11 не тронуты).

**Веб.**
- `core/identity.ts` — секрет профиля (`cord:profile:v1`, бывший `favoriteProfile`), `entryHeaders(leave?)`,
  `alreadyInMeeting(error)`. `api/client.ts`: входы шлют `X-Cord-Profile` (+ `X-Cord-Leave`), остальные запросы —
  нет; `ApiError.problem` — весь ответ отказа. `favoriteApi.join(…, leave?)`.
- `ui/MeetingElsewhere.tsx` на `Dialog`/`Button` набора E16: «Вы уже во встрече «X»» — «Перейти туда» (недавние
  или избранное, иначе «идёт в другой вкладке или окне») и «Выйти оттуда и войти сюда» (тот же вход с
  `X-Cord-Leave`). `Prejoin` — одна дверь `admit(leave)` на форму и автовход; `App.goElsewhere`.
- Панель встречи: «В ЭТОЙ ВСТРЕЧЕ · N ИЗ 20» из `capabilities.maxParticipants` (люди без ботов).
- `api/types.ts`: `Snapshot.startedAt?`, `Capabilities.favoritesMax?` — руками до регенерации.
- `home.test.tsx`: образец `capabilities` с обязательным `quality` — `tsc -b` падал на `main` после регенерации
  контрактов E05 (не от WP1).

**Найдено по дороге.** Перегрузки без `Entrant`, зовущие `@Transactional`-соседа внутри бина, обходят прокси:
транзакции и общего замка нет — `admissionIsAtomicForEverySeat` поймал дубль `room_events`. Перегрузки помечены
`@Transactional` сами.

**Ревью субагентом** (`feature-dev:code-reviewer`, по диффу `bdc817b..HEAD`): серьёзных ошибок нет; блокер
слияния — нерегенерированные контракты (так и задумано, очередь 3.2). Поправлено по трём мелким находкам:
в `create` «одна встреча» теперь до подсчёта слотов (выход освобождает слот себе же); `App.goElsewhere`
считает «Перейти туда» удавшимся, только если прежний вход действительно открылся (`recent` возвращает
`boolean`), иначе пробует избранное и окно говорит про другую вкладку; `Contracts.Snapshot` и `Admission`
получили `ignoreUnknown` — расписка входа со `startedAt` при откате на следующие образы не падает (на образ
до WP1 — по-прежнему, как и с `you`).

**Слияние `main` с E02 (5a21b11)** по просьбе координатора. Конфликт в `FavoriteService` (группы избранного,
V8): предел десяти комнат стоит в новом `FavoriteService`, `key()` пакетный и разбирает профиль через
`Identity`; текст `FAVORITES_FULL` — словами подсказки звезды E02 «В избранном уже 10 комнат. Уберите одну,
чтобы добавить эту» (слово согласуется с числом настройки). В вебе: «Перейти туда» сначала ищет встречу в
соседней вкладке (`findActiveMeeting` в `core/active-meeting.ts` E02) и переносит её сюда тем же участником
(`requestHandover`, как «Вернуться» на главной); нет вкладки — недавние, избранное, а иначе окно говорит, что
в этом браузере встреча не открыта. Счётчик людей в панели — через `core/people.ts humans()` E02. Образец
`capabilities` в `home.test.tsx` правили обе ветки — слияние оставило два `quality`, дубль убран. Миграции у
WP1 по-прежнему нет; V8 занята E02.

## Проверки

| Проверка | Код выхода | Примечание |
| --- | --- | --- |
| `./mvnw -B -o -pl server test -Dtest=MeetingLimitsTest,RoomServiceTest,PermissionsTest` | 1 → 0 | первый прогон — ошибка самовызова (см. выше), после правки 116 тестов, BUILD SUCCESS |
| то же для `MeetingLimitsTest` с `-Dstream.meeting.one-active-per-profile=false -Dstream.favorites.max-saved=1000` | 1 (ожидаемо) | 7 из 13 краснеют: тесты T52 и избранного действительно держат правила |
| `./mvnw -B -o -pl server test -Dtest=ArchitectureTest,ContractsValidationTest,FavoriteOrderTest,NewGamesIntegrationTest,GameVisualEventsTest` | 0 | 25 тестов; `room` → `access` разрешено |
| `docker run … maven:3.9.11-eclipse-temurin-25 mvn -o -pl server com.spotify.fmt:fmt-maven-plugin:format`, затем `:check` | 0 | 7 файлов переформатировано; `check` — 80 файлов, 0 несоответствий (`./mvnw` с хоста плагин не находит офлайн) |
| `node --test scripts/configure.test.mjs` | 0 | 2 теста, `max_participants` = 24 |
| `npx vitest run --pool=forks --maxWorkers=1 --testTimeout=60000` identity, client, favorites, meeting-elsewhere | 0 | 4 файла, 19 тестов |
| то же: home, favorite-reorder, core/session | 0 | 3 файла, 14 тестов |
| `npx prettier --check` на 14 тронутых файлах веба | 0 | |
| `npx tsc -b` | 1 → 0 | первый — только `home.test.tsx` (образец без `quality`, с `main`), после правки чисто |
| после ревью: `fmt:check`; `-Dtest=MeetingLimitsTest,RoomServiceTest,PermissionsTest,ContractsValidationTest`; `prettier --check src/App.tsx`; `tsc -b` | 0 / 0 / 0 / 0 | 118 тестов ядра |
| после слияния E02: `fmt:check` | 1 → 0 | одна строка javadoc в `FavoriteService`, `fmt:format` |
| после слияния: `-Dtest=MeetingLimitsTest,RoomServiceTest,PermissionsTest,FavoriteGroupsTest,FavoriteOrderTest,ContractsValidationTest,ArchitectureTest` | 0 | 133 теста |
| после слияния: vitest active-meeting, identity, client, favorites, meeting-elsewhere, home | 0 | 6 файлов, 37 тестов; home отдельно ещё раз после правки образца — 10 |
| после слияния: `prettier --check` на тронутых; `tsc -b` | 0 / 1 → 0 | `tsc` — двойной `quality` в образце `home.test.tsx` после слияния, убран |

Нагрузка хоста во время работы — load average 20–32 на 4 vCPU; `RoomServiceTest` шёл 96–210 с.

## Изменения контракта (для интегрирующей сессии)

`contracts/openapi.json` и `web/src/api/generated.ts` **не** перегенерированы (очередь 3.2, шаг 2):
- `Snapshot.startedAt` — `int64`, nullable, **не** required (`OpenApiConfig`: убран из required, добавлен в nullable).
- `Capabilities.favoritesMax` — `int32`, required (Capabilities целиком в required-списке).
- Тела запросов не менялись. Заголовки `X-Cord-Profile`, `X-Cord-Leave` и отказы `409 ALREADY_IN_MEETING
  {roomId, title}`, `409 FAVORITES_FULL {max}` — вне схем тел, описаны в `contracts/headers.md`.
- После регенерации ручные объявления в `web/src/api/types.ts` (`startedAt`, `favoritesMax`) можно убрать.

## Не проверено

- **Живой прогон двумя вкладками одного профиля** против стенда (вход во вторую → окно → «Выйти оттуда и войти
  сюда»; первая вкладка видит свой выход) и скриншоты окна на 390/1440 в обеих темах — ядро на стенде не
  выкатывалось (инструкция: не пушить и не выкатывать). Команда, когда выкатят:
  `PLAYWRIGHT_BASE_URL=https://cord.nikg.tech npx playwright test` + два `page` одного `context`.
- Полные наборы (`mvn verify`, `npm test`, `vite build`) — в финальной волне.
- Клиент Windows 0.7.x и службы шлют входы без `X-Cord-Profile` — по замыслу работают как раньше; живьём не
  проверено. LiveKit с `max_participants: 24` на стенде не перевыпускался (`configure.mjs --refresh`).
- e2e на 20 участников (E05 шаг 6 «Готово») — нужен нагрузочный стенд, здесь только тест ядра 20/21.
