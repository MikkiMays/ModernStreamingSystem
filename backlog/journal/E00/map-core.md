# Карта ядра (server/) — E00, 19.10.2026

Сверено с кодом на `main` (cd29eda). Классы под `server/src/main/java/dev/mikki/stream/<pkg>/`, имя
файла уникально. Стек: Spring Boot 4.1.1, Java 25, `JdbcClient` (без JPA), Flyway, Redis, LiveKit SDK
0.15.1, springdoc 3.1.0. CI: `mvnw -pl server fmt:check verify`.

## Пакеты

| pkg | файлы (строки) | роль |
|---|---|---|
| room/ | RoomService 1488, Lifecycle 381, Contracts 308, RoomState 221, FavoriteService 145, RoomRepository 98, GameClock, GameTicker | домен, транзакции; комната — JSON в `rooms.state` |
| game/ | Table 1858 (покер), Durak 1396, Gartic 794, Chess 589, Standings, Hands, DurakStandings, DurakView 160, Cards, TableView, GameSummary, GarticView, DurakSummary, ChessView, GameVisualEvent | правила и виды на зрителя |
| api/ | ApiController 225, RequestGuard 117, InternalController 102, FavoriteController 59, ServiceController 56, SessionController, RoomSettingsController, ApiErrors, ClientAddress, IntegrationSettingsController | REST, фильтр, ошибки |
| application/ | CommandDispatcher 39 | команда → RoomService → побочные эффекты LiveKit |
| access/ | RateLimits 57, ServerAccess 75, Secrets 48 | лимиты, пароль сервера, HMAC |
| media/ | MediaService 182, MediaGateway 92, MediaReconciler 76 | токены LiveKit, вебхуки, сверка |
| events/ | RoomSocket 188, EventConfig 38 | WebSocket `/api/v1/events`, Redis pub/sub |
| attachment/ | AttachmentService 304, TusGateway | файлы |
| config/ | OpenApiConfig 175, Term, StreamProperties 85 | конфиг, сроки словами |
| shared/ | Problem 28, Json 38 | ошибка, ObjectMapper |

`ArchitectureTest.java:10-26`: room не зависит от api/events/media/livekit/spring-web.

## RoomState и снимок

- `RoomState.java:15` `@JsonIgnoreProperties(ignoreUnknown=true)` (откат образа). Поля 17-30: id, title,
  code, createdAt, closedAt, emptySince, everConnected, mediaDrained, approvalRequired,
  `integrationsAllowed=true`, sequence, members, invites, messages; `watch` 33; игры NON_NULL 49-70.
- Хранение — свой ObjectMapper без NON_NULL (`Json.java:8-11`): **новое поле — `@JsonInclude(NON_NULL)`**.
- Статусы 133-141: WAITING, JOINING, CONNECTED, RECOVERING, LEFT, EXPIRED, REMOVED. `Member` 143-179,
  **`service` (152) — признак бота** (сейчас только `"music"`, `RoomService.java:361`).
  `occupiesSeat()` 169-174, `mediaAllowed()` 176-178. Javadoc 8: «at most ten members».
- Снимок `Contracts.Snapshot` 234-268 — **нет `you` уровня комнаты и нет `startedAt`**. Три конструктора:
  `RoomService.java:528` (`snapshot()` 486-547), `admission()` 392, `snapshotFor()` 599.
- OpenAPI: `OpenApiConfig.java:37-87` всё required; новые поля убирать из required 90-100 (Snapshot 94),
  nullable 115-146 (Snapshot 122-123). CI сверяет `contracts/openapi.json` и `web/src/api/generated.ts`.
- `you.actions` есть только у игр: покер `TableView.java:129-152`, дурак `DurakYou` (take/pass + `plays`)
  `DurakView.java:126-142`, Gartic `GarticYou`.
- `startedAt` встречи: нет. Есть `createdAt`, `serverTime`, `everConnected` (ставится на трёх переходах в
  CONNECTED: `MediaService.java:101,171`, `RoomService.java:1060`). Повторное открытие из избранного
  сбрасывает `closedAt` (`RoomService.java:171-175`) — там же сбрасывать `startedAt`.

### Кто считает участников

| место | ботов считает? |
|---|---|
| `RoomService.java:63-71` занятые комнаты при create vs maxRooms | да |
| `RoomService.java:233-242` лимит комнат в checkSeat | да |
| `RoomService.java:243-245` ROOM_FULL vs maxParticipants, текст «десять» | **да — бот занимает место**; `RoomServiceTest.java:261-286` это закрепляет |
| `RoomService.java:487-489` участники снимка | с ботами и WAITING |
| `RoomState.java:124,129` lastSeenAt | только люди |
| `Lifecycle.java:143-144,161-165,216-220,252-263,374-380` | только люди |
| `Lifecycle.java:299-311` emptySince и автозакрытие | **да** — комната с одним ботом здесь не закрывается |
| `MediaService.java:49-51` лимит экранов | показывающие |

## Жизненный цикл и пределы

- `application.yml:25-64` → `StreamProperties.java:12-40`: **max-participants 10 с `@Max(10)` (стр. 27)**,
  max-screens 2 (`@Max(2)`), **max-rooms 5**, recovery-seconds 20, join-seconds 120, empty-room-seconds 60,
  unused-room-seconds 300, retention.*, file-max-bytes 100 MiB, room-max-bytes 1 GiB, total-max-bytes 10 GiB.
- Входы: create `RoomService.java:53-86`, по приглашению 268-295, по коду `joinCode` 122-144, rejoin →
  `returnMember` 163-228, из избранного `FavoriteService.java:127-144` → `joinSaved` 155-161. Все
  `@Transactional` + `lockGlobal()` (`RoomRepository.java:17-19`).
- `checkSeat` 230-265: DRAINING, ROOM_LIMIT, ROOM_FULL, SESSION_LIMIT. `newMember` 371-384.
- Восстановление: → CONNECTED (вебхук, сверка, `media.restored`), → RECOVERING (вебхук, отсутствие,
  `media.lost`), → EXPIRED (`Lifecycle.java:117-124`). `generation++` на каждом переходе.
- Планировщики: sweep 1 с, reconcile 2 с, GameTicker 200 мс, RoomSocket catch-up 1 с.

### Профиль устройства и T52

- Профиль — 32 случайных байта base64url в `localStorage cord:profile:v1` (`web/src/core/favorites.ts:8-26`),
  уходит **только** в `/api/v1/favorites` как Bearer; сервер хранит SHA-256 (`FavoriteService.java:22-26`).
- create/join/join-by-code/rejoin профиля **не получают**, у `Member` поля профиля нет → нужен
  необязательный заголовок и `Member.profileHash` (NON_NULL) в `newMember`. Проверка — сразу после
  `lockGlobal()`; RECOVERING — то же участие; возврат в ту же комнату исключается сам (старый member LEFT).

## Избранное

`FavoriteController.java`: GET, PUT /{id}, PUT /order, DELETE /{id} (без лимита частоты), POST /{id}/join.
**Предела нет** (`FavoriteService.java:66-68`, `docs/architecture.md:116` «без ограничения числа») —
место для предела 10: между 65 и 69 под уже взятой блокировкой (54).
Миграции `server/src/main/resources/db/migration/`: V1 room_ledger … V7 favorite_order. **Следующая — V8.**
Должны идти и на Postgres, и на H2 (MODE=PostgreSQL).

## Права

- `owner()` 1094-1096; `integrations()` **1106-1108** (`!owner && !integrationsAllowed → 403`): watch.*,
  poker.open, durak.open, chess.open, gartic.open. `dealer` 1274-1278, `fool` 1287-1291, `gameHost` 1229-1232.
- `Contracts.COMMAND_TYPES` 57-58 (тип `@Size(max=30)`), тест всех типов `RoomServiceTest.java:1265`.
- Служба зовёт ядро с `X-Internal-Secret` и `X-Service-Secret` (одинаковый секрет); Caddy ставит
  X-Internal-Secret на каждый браузерный `/api/v1` — на `/api/v1` он ничего не доказывает.

## Игры (дурак)

Константы `Durak.java:37-74` (SEATS 6, HAND 6, MAX_ATTACKS 6, FIRST_ATTACKS 5, AWAY_ACT 3 с, ход 15-120 с).
`startBout` 694-702: `limit = min(cap, defender.hand.size())`. `validateAttack` 745-757 (DURAK_LIMIT 751).
**`transfer` 873-889 пересчитывает `limit = min(cap, attacks.size() + next.hand.size())` (886)** —
вероятная причина T51 в переводном: после перевода у нового защитника H карт, на столе A; предел A+H, а
отбиться он может максимум H. Ничто не заканчивает бой, когда у защитника кончились карты посреди боя.
`acting` 925-932 молча исключает тех, кому нечего подкинуть — метки «нечего подкинуть» нет.
`tick` 1124-1145: таймаут защитника → авто-взятие; атакующих → все пасуют. `DurakSeat.held` — число карт
каждого места уже есть.

## Ошибки, лимиты, метрики

- `Problem(status, code, message)` → RFC 7807, `detail` по-русски + свойство `code` (~100 кодов строками).
- `RateLimits.java`: окно 60 с в Redis; create/join/rejoin 30/мин на IP, join-by-code 10/мин на IP,
  избранное 60/мин на профиль. **Нет лимитов на профиль, в час, на открытые комнаты.**
- `capabilities` (`ApiController.java:73-87`): resolutions `[720,1080,1440]` и frameRates `[15,30,60]`
  зашиты в коде, **настроек качества в yml нет**, веб их не читает.
- **Логов и своих метрик в основном коде нет**; actuator (`health,prometheus`) только на 127.0.0.1.
