# 2026-10-21 — хвосты безопасности (A14, A12, A5, A6, A8, E13, A9)

Ветка `worktree-agent-a5ec51b28f2ccbae4` от `main` (`92e5704`), слита с `main` (`3ba7207`: хвосты функций,
E15-B, визуальная волна, E01-B3 веб). Исполнитель — Opus 5.5 по заданию главной сессии, без субагентов. Поток
один раз встал на десять минут (на «Now InternalKeysTest»); главная сессия сохранила работу WIP-коммитом
`f36bf43`, дальше — с него. Решения с причинами — `DECISIONS.md` → «хвосты безопасности» (ST-1…ST-7),
состояние угроз — `docs/abuse-model.md` §9, ключи — `docs/deployment.md` → «Антибот и пределы».

## Что сделано (по порядку задания)

1. **A14 — ключи по назначению.** `server/.../access/InternalKeys.java` и `services/cord_services/keys.py`:
   HKDF-SHA256 (RFC 5869) из `INTERNAL_SECRET`, соль `cord-internal-secret`, назначения `service`, `actor`,
   `cinema-sign`, `sniffer`, `fernet`. Служба шлёт ядру только `X-Service-Secret` = ключ `service` (сам секрет и
   `X-Internal-Secret` — больше нет); ядро открывает им `/internal/`, пароль сервера и `X-Cord-Actor`, а сам
   секрет в этом заголовке — 403. Актор бота — HMAC ключом `actor`; подписи кинозала — ключом `cinema-sign`;
   плеер страниц — ключом `sniffer` (копия формулы в `services/sniffer/sniffer/entry.py`); сейф входов —
   `MultiFernet`: пишет ключом `fernet`, читает и прежним (SHA-256 секрета). Шлюз по-прежнему ставит сам секрет
   в `X-Internal-Secret` (ST-1). Без прокладок (В-2): ядро и службы — одной выкаткой.
2. **A12 — TURN не открытый relay.** `scripts/turn-guard.mjs`: `deny_peer_cidrs` — всё IPv4, кроме адреса
   узла (32 сети), и весь IPv6; узел в частной сети — `allow_restricted_peer_cidrs`; правило проверки LiveKit
   1.13.6 повторено (`permits`). `configure.mjs` пишет их в `turn`. `scripts/turn-relay-check.mjs` — свой
   STUN/TURN-клиент: учётка из `join` сигналинга, Allocate без учётки (401), с учёткой, CreatePermission к SFU и
   к запретным адресам. `scripts/turn-relay-check.sh` гоняет его против LiveKit образа compose в изолированной
   сети и вторым прогоном без правил доказывает, что проверка видит дыру. Шаг CI `deployment-config`.
   **Находка:** без правил relay открыт не только к публичным адресам, но и к CGNAT `100.64.0.0/10` (Go не
   считает его частным).
3. **A5 — ожидающие вне мест.** `RoomState.seatedHumans` не считает WAITING; место или зал ожидания решает
   `RoomService.seat` после того, как ясен статус входящего (ссылка, код, возврат, избранное);
   `stream.meeting.waiting` (10, `409 WAITING_FULL`), `per-ip.waiting-per-room` (2, `429 WAITING_LIMIT`,
   отпечатки в `RoomState.waitingFrom`), ведущий впускает (`participant.approve`) только при свободном месте.
4. **A6 — чат на адрес.** `per-ip.chat-messages: 60 per minute` (`429 CHAT_RATE_IP`): адрес отправителя идёт от
   REST (`ClientAddress.entrant`) и сокета (`Connection.address`) через `CommandDispatcher` до `chatAllowed`.
5. **A8 — плашка 80 %.** Служба (`cinema/guard.py` → `Traffic`) говорит ядру порог `CINEMA_TRAFFIC_WARN_AT` и
   потолок (`POST /internal/services/{id}/cinema-traffic {percent}`), один раз на уровень, в фоне; отказ сверх
   потолка напоминает раз в 5 минут. Ядро — `RoomState.cinemaTraffic` → `Snapshot.cinemaTraffic` +
   `room.changed`. Веб — `CinemaTraffic` в `ui/abuse/Notices.tsx`, одна строка в `MeetingHeader.tsx` рядом с
   «Встреча завершится». Тексты `meeting.cinemaTraffic`, `meeting.cinemaStopped` — ru и семь языков.
6. **E13 — кнопки статуса в Telegram.** `support.py`: обращение уходит с кнопками «В работу» / «Решено»
   (`support:<id>:open|done`); `telegram.py`: `callback_query` в `allowed_updates`, `support_status` зовёт
   `PUT /internal/support/{id}/status {status, chat}`, правит кнопки (выбранная — «✓»), отвечает
   `answerCallbackQuery`; повтор апдейта не меняет статус дважды. Ядро меняет статус тем же `setStatus`, что
   «Активность», только если чат — чат поддержки, иначе 403 (ST-6).
7. **A9 — решение.** Модель держит A9 в P2. Сделан дешёвый рычаг `CINEMA_LINK_HOSTS_DENY` (сайт и поддомены,
   отказ словами до yt-dlp, `cinema/facade.py`); аудит хостов «По ссылке» отложен (ST-7).

## Изменения контрактов, схемы и настроек (регенерацию делает интегратор)

- `Snapshot.cinemaTraffic` — `Integer`, `NON_NULL`; в `OpenApiConfig` убран из required, nullable. Веб читает его
  приведением (`readCinemaTraffic`), `generated.ts` не трогался.
- Внутреннее: `POST /internal/services/{roomId}/cinema-traffic {percent: 1..100}` → 204;
  `PUT /internal/support/{id}/status {status: NEW|OPEN|DONE, chat}` → `{id, number, status}` (403 — чужой чат,
  404 — нет обращения).
- Поля комнаты (JSON в базе): `waitingFrom` (NON_EMPTY), `cinemaTraffic` (NON_NULL). Миграций нет (V13 свободна).
- Заголовки (`contracts/headers.md`): `X-Service-Secret` — ключ `service`, а не секрет; `X-Internal-Secret`
  ставит только шлюз; `X-Cord-Actor` — HMAC ключом `actor`.
- Коды (`contracts/errors.json` пересобран `scripts/errors_registry.py`, каталог — `sync-errors.mjs`):
  `CHAT_RATE_IP` 429, `WAITING_FULL` 409, `WAITING_LIMIT` 429; переводы — семь языков.
- Настройки ядра: `stream.meeting.waiting` (`MEETING_WAITING`, 10), `stream.abuse.per-ip.waiting-per-room`
  (`ABUSE_IP_WAITING_PER_ROOM`, 2), `stream.abuse.per-ip.chat-messages` (`ABUSE_IP_CHAT_MESSAGES`,
  `60 per minute`). Служба: `CINEMA_LINK_HOSTS_DENY`. Новых секретов нет.
- `infra/generated/livekit.json` (порождается): `turn.deny_peer_cidrs` (+ `allow_restricted_peer_cidrs` у узла в
  частной сети). На стенде — после `node scripts/configure.mjs --refresh` и перезапуска `livekit`.
- Бот: `allowed_updates` + `callback_query`.

## Проверки

Хост в начале работы был под нагрузкой 40–55 (пять агентов), к концу — 2–14 (один агент). Тяжёлое — по одному.

| Что | Команда | Итог |
| --- | --- | --- |
| ядро, A14 | `mvn -B -o -pl server fmt:check test -Dtest='InternalKeysTest,ServerAccessTest,SignalingGateTest'` (docker, офлайн) | exit 0, 17 тестов |
| ядро, после A5/A6/A8/E13 | `-Dtest='AbuseLimitsTest,SupportTest,MeetingLimitsTest,RoomServiceTest,ServerAccessTest,OwnerAccessTest,InternalKeysTest,ContractsValidationTest,ArchitectureTest'` | 140/141: `RoomServiceTest#returnCannotBypassPendingApprovalRemovalOrCapacity` заполнял места ожидающими (комната с допуском) — по A5 они мест не занимают; тест получил «допуск выключен» перед заполнением |
| ядро, повтор | `-Dtest='RoomServiceTest,AbuseLimitsTest,SupportTest,MeetingLimitsTest'` | exit 0, 118 тестов |
| ядро, итог (после слияния `main`) | `mvn -B -o -pl server fmt:check test -Dtest='InternalKeysTest,ServerAccessTest,SignalingGateTest,OwnerAccessTest,AbuseLimitsTest,SupportTest,RoomServiceTest,MeetingLimitsTest,ContractsValidationTest,ArchitectureTest'` | exit 0, 143 теста, `fmt:check` чисто |
| службы, по модулям | `python -m unittest test_keys test_accounts test_cinema_sniff test_support test_cinema_traffic test_cinema_abuse test_cinema_link_deny` в образе `modern-streaming-services`, код и тесты только для чтения, `--network none` | OK (61 + 32 + 3) |
| службы, целиком | `python -m unittest discover -s /tests` там же | первый прогон — 97 ошибок: общий фиктивный ядро `test_services.Fixture` проверял `x-internal-secret` = сам секрет; теперь — ключ службы и отсутствие шлюзового заголовка. Повтор: 767 тестов, 2 падения по времени при нагрузке 7–8 (`AvailabilityTests…silent_check…`, `ThroughTheRealWay…takes_too_long…`); отдельно — OK, 2/2 |
| плеер страниц | `python -m unittest test_capture.Key` в образе `modern-streaming-sniffer`, код только для чтения | OK, 2 |
| ruff | `ruff check cord_services/cinema sniffer tests/test_cinema*.py --line-length 110 --extend-select E501`; `ruff check` по `keys.py`, `support.py`, `core.py`, `accounts.py`, `test_keys.py`, `test_support.py` | All checks passed |
| TURN | `node --test scripts/turn-guard.test.mjs scripts/configure.test.mjs` | 7/7, 3/3 |
| TURN живьём | `bash scripts/turn-relay-check.sh` (LiveKit 1.13.6 образа compose, подсеть 203.0.113.0/24 `--internal`) | exit 0: с правилами — 401 без учётки, relay к SFU есть, к 8.8.8.8, 1.1.1.1, 127.0.0.1, 10.0.0.1, 172.17.0.1, 192.168.1.1, 169.254.169.254, 100.64.0.1 — 403; без правил — 8.8.8.8, 1.1.1.1 и 100.64.0.1 открыты |
| веб | `vitest run --pool=forks --maxWorkers=1 src/ui/abuse/notices.test.tsx src/ui/meeting-header.test.tsx` | 8/8 (первый прогон поймал общий документ двух тестов — запросы своим контейнером) |
| веб, типы и формат | `npx tsc -b`; `npx prettier --check` по тронутому | exit 0; чисто после `--write` Notices.tsx |
| переводы | `node scripts/i18n/coverage.mjs`; `sync-errors.mjs --check`; `check.mjs`; `python3 scripts/errors_registry.py --check` | 2428/2428 у семи языков, замечаний 0; 0; 162 при базе 162; 0 (144 кода) |
| голос продукта | `node scripts/product-voice.mjs` | чисто |

## Не сделано и не проверено

- **A5:** «Отклонить всех ожидающих» и свой срок ожидания (`waiting-expires`) — не в задании; срок ожидания —
  прежний `unused-room-seconds`.
- **A9:** аудит хостов «По ссылке» на «Активности» — отложен (ST-7).
- **A14:** шлюз ставит сам секрет в `X-Internal-Secret`; запасной ключ `cord-cinema` в коде кинозала остался
  (служба без секрета не стартует, поэтому он недостижим на сервере).
- Живьём на стенде ничего не выкатывалось (задание): правила TURN, кнопки бота в чате владельца и плашка
  кинозала проверены тестами и одноразовым LiveKit. После выкатки — ядро и службы вместе (A14), затем
  `configure.mjs --refresh` и перезапуск `livekit` (A12).
- Полные наборы тестов ядра и веба — финальная волна.

## Скиллы и инструменты

`cord-server-tests` (docker Maven офлайн, `fmt-maven-plugin:format`, `fmt:check`), `cord-i18n` (каталог, семь
языков, `sync-errors`, `coverage`). Исходники `pkg/service/turn.go` LiveKit 1.13.6 и `base62` — WebFetch
(порядок проверок `permissionHandler`, формат учётки TURN). Субагентов не было.
