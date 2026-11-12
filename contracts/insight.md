# Служба аналитики `insight`: контракт (R239)

Проект — `docs/architecture/analytics-v2.md`. `insight` — отдельная служба на Rust (`rust/insight`), слушает
`127.0.0.1:18300` на машине ядра. У неё три входа: события клиента (через шлюз), факты ядра и служб (петля), отчёты
(петля). Таблицы — в схеме `insight` базы продукта, миграции ведёт сама служба.

Версия контракта — `1`. Незнакомые поля и события отбрасываются молча: клиент новее службы не ломает приём.

## 1. События клиента — `POST /api/v1/t`

Шлюз ведёт путь на `insight` с настоящим адресом в `X-Real-IP` и секретом шлюза в `X-Internal-Secret` (без него
`X-Real-IP` не читается). Ручка открыта до пароля сервера.

Запрос — JSON, не больше 32 КиБ, не больше 50 событий:

```json
{
  "v": 1,
  "sid": "pX9…22 знака base64url",
  "profile": "…43 знака…",
  "client": { "kind": "web", "version": "1.4.0" },
  "probe": "…",
  "events": [{ "n": "session_start", "at": 1793612345678, "p": {} }]
}
```

- `sid` — сессия: 16 случайных байт, живёт в `sessionStorage`; 30 минут тишины — новая.
- `profile` — секрет профиля устройства (`contracts/headers.md`); дублирует `X-Cord-Profile`, потому что `sendBeacon`
  заголовков не шлёт. Служба хранит только псевдоним (§4).
- `client.kind` — как `X-Cord-Client`; `client.version` — версия сборки веба или приложения.
- `probe` — подпись своих проверок (§5); дублирует `X-Cord-Probe`.
- `at` — мс эпохи по часам клиента; служба принимает от «сутки назад» до «пять минут вперёд», иначе ставит своё время.

Ответ: `204`; `Set-Cookie: __Host-cord-did=v1.<id>.<подпись>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000`,
когда куки нет или ей больше 30 дней. `400` — не JSON или нет `sid`; `413` — больше 32 КиБ; `429` — больше 60 пачек в
минуту с адреса.

### События и поля

Строки режутся до 64 знаков, если не сказано иное; перечисления — только названные слова, иначе поле отбрасывается.

| `n` | `p` |
| --- | --- |
| `session_start` | `landing`: `home` \| `invite` \| `room` \| `app` \| `tg` \| `download` \| `support` \| `other`; `ref` — домен источника или пусто; `utm`: `{source, medium, campaign}`; `lang`; `tz` (имя пояса); `screen`: `{w, h, dpr, depth}`; `standalone`: bool (установленное приложение-сайт); `wd`: bool (`navigator.webdriver`); `fp`: §1.1 |
| `engaged` | `proof` — ответ на задачу (§1.2); `ms` — мс от начала сессии до первого настоящего действия. Шлётся один раз, когда выполнены все три условия человека: настоящее действие, страница видна ≥ 3 с, задача решена — и **не раньше чем через 3 с после `session_start`** (§6.1) |
| `screen` | `name`: `home` \| `prejoin` \| `meeting` \| `settings` \| `download` \| `support` \| `activity` \| `other`; `tab` — раздел настроек |
| `prejoin` | `from`: `create` \| `invite` \| `code` \| `recent` \| `favorite` |
| `permission` | `device`: `mic` \| `cam` \| `screen`; `result`: `granted` \| `denied` \| `dismissed` \| `error`; `error` — имя ошибки браузера |
| `join_timing` | `ms`, `signal_ms`, `media_ms` — целые; `node` — id узла |
| `feature` | `name` — слово возможности (`screen_share`, `background`, `chat`, `reaction`, `hand`, `pin`, `layout`, `mini`, `hotkey`, `fullscreen`, `noise`, `quality`…); `count` — целое ≥ 1 |
| `integration_view` | `room` — номер встречи (служба заменит псевдонимом); `kind`: `cinema` \| `music` \| `game` \| `board`; `variant` — площадка или игра; `seconds` — сколько была на экране с прошлой отправки; `stalls`, `stall_ms` |
| `error` | `code` — код из `contracts/errors.json` или имя исключения; `scope`: `join` \| `media` \| `device` \| `cinema` \| `music` \| `game` \| `board` \| `chat` \| `update` \| `app`; `screen`; `fatal`: bool; `detail` — до 200 знаков машинного текста (имя ошибки, код ответа), без слов человека |
| `invite` | `how`: `copy` \| `share` \| `qr` |
| `leave` | `reason`: `user` \| `closed` \| `network` \| `removed` \| `ended`; `seconds` |

### 1.1. Признаки отпечатка `fp`

`{canvas, gl, fonts, audio}` — строки-хэши до 64 знаков (клиент хэширует сам; сырые картинки и списки шрифтов не
уходят); `glr` — строка модели видеокарты до 120 знаков (по ней видна программная отрисовка); `hc` — число ядер; `dm` —
память, ГБ; `touch` — точек касания; `plat` — `navigator.platform`. Любого признака может не быть.

### 1.2. Задача «не робот» — `GET /api/v1/t/proof`

Ответ — тот же формат, что у ядра (`X-Cord-Proof`, ALTCHA первой версии, SHA-256): `{algorithm, challenge, maxnumber,
salt, signature}`; в соли — срок (5 минут) и отпечаток адреса; `maxnumber` — 20 000. Решение — в `engaged.p.proof`,
base64 от JSON `{algorithm, challenge, number, salt, signature}`; годится один раз. Решатель в вебе — прежний
`web/src/core/proof-solve.ts`.

## 2. Факты — `POST /internal/facts`

Только с петли; заголовок `X-Insight-Key` — ключ назначения `insight` (HKDF-SHA256 из `INTERNAL_SECRET`, как
`InternalKeys`). Отправитель копит факты и шлёт пачкой не реже раза в 2 с, не больше 500; ответ `204`. Отказ или
молчание службы — повтор с тем же `id`; буфер отправителя ограничен (100 000), сверх — старые выбрасываются со строкой в
журнале. Встреча от аналитики не зависит никогда.

```json
{ "source": "core", "facts": [{ "id": "uuid", "at": 1793612345678, "type": "join", "room": "…", "profile": "…" }] }
```

`id` — уникален: повтор пачки ничего не удваивает. `room` — номер встречи (служба хранит псевдоним). `profile` —
**псевдоним** профиля (§4), а не секрет и не хэш; `null`, если у участника профиля нет.

| `type` | Кто шлёт | Поля |
| --- | --- | --- |
| `join` | ядро, вход удался | `room`, `profile`, `member`, `how`: `create` \| `link` \| `code` \| `saved` \| `rejoin`, `node`, `client` |
| `join_fail` | ядро, отказ двери | `profile`, `how`, `code` — код отказа |
| `media_up` | ядро, участник соединился с узлом | `room`, `profile`, `member`, `node` |
| `media_down` | ядро | `room`, `profile`, `member`, `reason`: `left` \| `lost` \| `removed` \| `ended` \| `moved` |
| `presence` | ядро, раз в 60 с на открытую встречу с людьми на связи | `room`, `node`, `members`: `[{member, profile}]` |
| `meeting_open` | ядро | `room`, `node`, `profile` — кто создал |
| `meeting_close` | ядро | `room`, `reason`: `empty` \| `owner` \| `limit` \| `admin` \| `maintenance`, `peak` |
| `quality` | ядро, из 10-секундной сводки клиента | `room`, `profile`, `mic_s`, `cam_s`, `screen_s`, `bytes_up`, `bytes_down`, `loss`, `rtt`, `freezes`, `relay`: bool, `reconnects` |
| `integration_open` | ядро | `room`, `run` — id запуска, `kind`, `variant`, `profile` — кто открыл |
| `integration_close` | ядро | `room`, `run`, `reason`: `closed` \| `replaced` \| `ended` \| `error` |
| `integration_error` | ядро или службы | `room`, `run`, `kind`, `variant`, `code` |
| `usage` | службы, раз в 30 с на идущий показ или музыку | `room`, `kind`: `cinema` \| `music`, `variant`, `bytes`, `seconds` |
| `node_move` | ядро | `room`, `from`, `to`, `reason` |
| `refusal` | ядро, итог минуты | `code`, `count` — отказы защиты (`RATE_LIMITED`, `PROOF_INVALID`, `BLOCKED`…) |

## 3. Отчёты — `GET /internal/reports/{раздел}`

Только с петли, тот же `X-Insight-Key`. Параметры: `from`, `to` (дни по поясу `ANALYTICS_ZONE`, включительно, период
≤ 400 дней), `view=period|cohort`, `strict=0|1` (без склейки по отпечатку), `compare=0|1` (приложить прошлый период той
же длины). Разделы: `pulse`, `audience`, `acquisition`, `activation`, `retention`, `engagement`, `integrations`,
`quality`, `errors`, `errors/{key}`, `traffic`. Формы ответов — `contracts/insight-reports.md` (ведёт служба; из него
типы пульта).

Пульт получает отчёты через свой канал к машине; через шлюз продукта их нет.

## 4. Псевдонимы и ключи

| Что | Формула | Кто считает |
| --- | --- | --- |
| псевдоним профиля | `base64url(HMAC-SHA256(SESSION_SECRET, "analytics:" + hex(SHA-256(секрет профиля))))` без `=` — как `Secrets.derive` | ядро (в фактах) и `insight` (из `profile` клиента) — должны совпасть |
| псевдоним встречи | `base64url(HMAC-SHA256(SESSION_SECRET, "analytics-room:" + номер))` | `insight` |
| подпись куки устройства | `HMAC-SHA256(SESSION_SECRET, "analytics-device:" + id)`, первые 16 байт | `insight` |
| отпечаток устройства и подсети | `HMAC-SHA256(SESSION_SECRET, "analytics-fp:" + …)`, `"analytics-net:" + /24 или /48` | `insight` |
| ключ фактов и отчётов | HKDF-SHA256(`INTERNAL_SECRET`, соль `cord-internal-secret`, `info = "insight"`), base64url | ядро, службы, пульт, `insight` |

Смена `SESSION_SECRET` рвёт все связи аналитики — секрет переезжает вместе с базой.

## 5. Свои проверки — `X-Cord-Probe`

`<день UTC ГГГГММДД>.<base64url(HMAC-SHA256(ANALYTICS_PROBE_KEY, день))>`; принимается сегодняшняя и вчерашняя. Шлют
автотесты, дымовые и нагрузочные скрипты, пробы мониторинга. Верная подпись — сессия класса `свои`; ключа в окружении
службы нет — заголовок не действует.

## 6. Уточнения реализации (R239, `rust/insight`)

То, чего в первых пяти разделах не было и что нужно знать клиенту, ядру и пульту. Внесено службой при реализации.

### 6.1. `engaged` и три секунды

Служба не видит страницу и проверяет «видна ≥ 3 с» по времени: `engaged` делает сессию человеком, если от первого
появления сессии у службы прошло не меньше 3 с **или** `at` события `engaged` не меньше чем на 3000 мс позже `at`
события `session_start` той же сессии (часы клиента сравниваются сами с собой, их сдвиг не важен). Раньше — событие
принято, но сессия остаётся «неясно» (ответ на задачу при этом не тратится). Поэтому клиент шлёт `engaged` не раньше
3 с от начала сессии.

`engaged` без `proof`, с чужим или уже использованным ответом человеком сессию не делает. Задача привязана к адресу:
спросить её и прислать ответ нужно с одного адреса (IPv4) или из одной сети /64 (IPv6).

### 6.2. Кука устройства

Кука выдаётся в ответе на пачку, пришедшую без верной куки. Возраст куки служба знает только у устройства человека
(строка `an_devices`): ему кука продлевается раз в 30 дней и выдаётся заново, когда он узнан по профилю. Узнаёт служба
в фоне, поэтому такая кука приходит со **следующим** ответом той же сессии. Сессиям «неясно», роботам и своим проверкам
кука не продлевается.

### 6.3. Пределы и коды

- Предел 60 в минуту с адреса — отдельно у `POST /api/v1/t` и у `GET /api/v1/t/proof`; сверх — `429`.
- `POST /api/v1/t` отвечает `204` и тогда, когда очередь службы полна или база лежит: событие отбрасывается со
  счётчиком (`insight_events_dropped_total`), клиенту повторять нечего.
- `POST /internal/facts`: `204` — приняты; `400` — тело не JSON-объект; `401` — нет верного `X-Insight-Key`; `413` —
  больше 2 МиБ; `503` — очередь полна или база не ответила: повторить ту же пачку с теми же `id`. Ответа служба не
  держит дольше 5 с; отправителю всё равно нужен свой таймаут — встреча от аналитики не зависит. Факт с незнакомым
  `type` или без `id` отбрасывается молча, остальные в пачке принимаются.
- `GET /internal/reports/*`: коды — `contracts/insight-reports.md` §1.

### 6.4. Факты: чего ждёт служба

- `at` — мс эпохи по часам отправителя; секунды на связи считаются по `at`, а не по времени прихода.
- `presence` перечисляет **всех**, кто на связи: участника, которого в тике нет, служба считает ушедшим. За один раз
  участнику засчитывается не больше 90 с.
- Человек считается «не один», пока на связи двое и больше участников встречи — с любым `profile`, в том числе `null`.
- `quality`: `loss` — доля потерянных пакетов от 0 до 1, `rtt` — мс; остальное — за 10 секунд сводки.
- `usage` принимается для всех четырёх видов (`cinema`, `music`, `game`, `board`) и прибавляется к идущему запуску
  этого вида в этой встрече; запуска нет — отбрасывается со счётчиком.
- `integration_error` попадает в группу ошибок с областью, равной виду интеграции; `refusal` — с областью `guard`;
  `join_fail` — с областью `join`. Отдельного факта «вышел» нет: событие `leave` от ядра служба строит из `media_down`.
- Встреча, о которой 6 часов нет ни одного факта, закрывается с причиной `unknown`; так же — запуск интеграции.

### 6.5. Ещё две ручки, только с петли

`GET /healthz` — `200 {"status": "ok", "database": bool, "geo": {"country": bool, "asn": bool}}`: служба жива; база и
базы адресов — сведения, а не условие. `GET /metrics` — текст Prometheus (`insight_*`): принятые и отброшенные события
по причинам, сессии по классам, отставание фактов, время записи в базу.

### 6.6. Окружение службы

Из `.env` ядра: `DATABASE_URL` (JDBC), `DATABASE_USER`, `DATABASE_PASSWORD`, `SESSION_SECRET`, `INTERNAL_SECRET`,
`ANALYTICS_ZONE` (по умолчанию `Europe/Moscow`). Свои: `ANALYTICS_PROBE_KEY` (§5; создаёт `scripts/configure.mjs`),
`ANALYTICS_FINGERPRINT=false` — без отпечатка устройства, `INSIGHT_PORT` (18300), сроки хранения в днях —
`ANALYTICS_RETENTION_EVENTS` (90), `ANALYTICS_RETENTION_ROLLUPS` (400), `ANALYTICS_RETENTION_PEOPLE` (400). Каталог баз
адресов на машине — `GEO_DIR` (по умолчанию `.local/geo`, `infra/geo/README.md`).
