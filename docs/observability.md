# Наблюдаемость, аналитика и аудит Cord

E10-A, исследование, 19.10.2026, ответ на T32 владельца. Что внедрять — в E10-B (план в конце).
**«Замер»** — снято на стенде `cord.nikg.tech` (4 vCPU, 7,8 ГиБ, steal 38–56 %). Остальное — из документации
(ссылки в «Источниках»). Звёзды и даты выпусков — по GitHub API на 19.10.2026.

## Коротко

1. **Платить за мониторинг не нужно.** Всё нужное есть в открытом софте и занимает **≈ 410 МиБ** своей
   памяти рядом со встречами (≈ 440 МиБ с журналами). Платные сервисы дают то же, но данные уходят наружу
   (против П8), а агент на машине нужен всё равно.
2. **Профиль `monitoring`:** VictoriaMetrics, vmalert, Alertmanager (алерты в Telegram), Grafana OSS,
   экспортеры node/postgres/redis, Gatus. Второй очередью — VictoriaLogs и Fluent Bit.
3. **Статистика встреч и аудит — свои,** в ядре и PostgreSQL. Страница «Активность» работает и без профиля
   `monitoring`: у `setup.sh` он по умолчанию выключен.
4. SigNoz, Uptrace, OpenObserve, Sentry self-hosted, PostHog, Plausible и OpenPanel сюда не помещаются:
   ClickHouse или требования от 2 до 16 ГБ.
5. **Машина не сообщит о своей смерти сама.** Нужен внешний сторож: Healthchecks.io (бесплатно,
   20 проверок, Telegram), схема dead man's switch.
6. **Cloudflare.** `meet`/`rtc`/`turn` — DNS only: Cloudflare видит лишь DNS-запросы, трафик встреч идёт мимо
   (проксировать можно только веб-хост, медиа по UDP — нельзя). Своя статистика полнее любой внешней.
7. **Найдено:** включить метрики LiveKit «как есть» — значит открыть их порт в интернет. LiveKit 1.13.6
   слушает его на тех же `bind_addresses` (у нас `0.0.0.0`), а UFW выключен. Включать только с
   `prometheus.username/password` (поддерживается) или с привязкой к 127.0.0.1. **E10-B так и сделал:**
   блок `prometheus` появляется в `livekit.json` только с `LIVEKIT_METRICS_PASSWORD`, порт 6789 закрыт и
   в `scripts/firewall.sh`.
8. **Внедрено в E10-B** — §15: что сделано, чем отличается от плана §14 и что осталось.

## 1. Что есть сейчас

| Что | Состояние (по коду) |
| --- | --- |
| Ядро | `/actuator/prometheus` на 127.0.0.1:8080. Своих метров нет — только JVM, HTTP, Hikari, Tomcat. |
| LiveKit 1.13.6 | Метрик нет: в `livekit.json` из `scripts/configure.mjs` нет блока `prometheus: {port, username, password}`. Старый `prometheus_port` устарел (`pkg/service/server.go`). |
| Шлюз (Caddy 2.11) | `admin off` → эндпоинта `:2019/metrics` нет. Нужны опция `metrics` и директива `metrics /metrics` на отдельном адресе 127.0.0.1. |
| edge (caddy-l4) | Только слой 4, HTTP-метрик нет — не собираем. |
| tusd 2.10 | `/metrics` уже есть (`-expose-metrics` по умолчанию `true`). |
| Службы (FastAPI) | Метрик нет. |
| Журналы | `json-file`, 5×20 МБ на службу, уровень WARN; никуда не собираются. |
| Машина | 4 vCPU, 7,8 ГиБ, своп 4 ГБ, свободно 73 из 95 ГБ. 62 soft lockup за двое суток (`ENV-cord.nikg.tech.md`). |
| Cord в простое | 723 МиБ на стек, +6 МиБ на участника в SFU (`docs/capacity.md`). |

## 2. Техника: метрики, журналы, ошибки, аптайм

**Как мерили:** отдельный контейнер на образ, 2,5 мин прогрева, 12 снимков `docker stats` через 10 с, медиана.
«Своя» память — `anon + kernel` из `memory.stat` cgroup, без кэша страниц (его ядро отдаёт само). ЦП — в % одного
ядра; при steal 40–50 % верна только медиана. Сбор раз в 15 с, стек мониторинга сам дал 8,5 тыс. рядов.

### 2.1 Хранилище метрик

| | Prometheus 3.15.0 | VictoriaMetrics 1.154.0 (single) |
| --- | --- | --- |
| Лицензия, ★, выпуск | Apache-2.0, 66,6 тыс., 25.09.2026 | Apache-2.0, 17,9 тыс., 12.10.2026 |
| Память, замер (8,5 тыс. рядов) | **47 МиБ** (своя 44), через 40 мин — 58 | **63 МиБ** (своя 65), через 40 мин — 74 |
| ЦП, замер | 1,3 % | 1,3 % |
| Память по документации | ≈ 3 КБ на ряд в head (Robust Perception) | «до 7× меньше Prometheus» на миллионах рядов (вендор) |
| Диск | 1–2 байта на точку | «до 7× меньше» (вендор) |
| Срок по умолчанию | 15 дней | 1 месяц (`-retentionPeriod=3` — три месяца) |
| Алерты | встроенные правила + Alertmanager | vmalert (**14 МиБ**) + Alertmanager |

**Вывод.** По памяти на нашем масштабе они равны (15–20 МиБ — шум); выигрыш VictoriaMetrics на миллионах рядов
нам не нужен. Берём её за **диск** (заявлено до 7× меньше места, а прямая запись на стенде — всего 6,7 МБ/с),
срок в месяцах одной опцией, приём Prometheus и OTLP одним бинарником и общую семью с vmalert и VictoriaLogs.
Prometheus со встроенными правилами — равноценная замена (без vmalert, те же дашборды на PromQL). **Объём:**
~10 тыс. рядов Cord раз в 30 с — 29 млн точек в сутки: у Prometheus 2,6–5,2 ГБ за 90 дней, у VictoriaMetrics по
заявлению вендора 0,4–0,8 ГБ. Блоки Prometheus уплотняются раз в 2 ч, поэтому сравнить диск честно можно
только замером за сутки (E10-B).

### 2.2 Журналы

| | Grafana Loki 3.7.8 | VictoriaLogs 1.53.0 |
| --- | --- | --- |
| Лицензия, ★, выпуск | AGPL-3.0, 29,0 тыс., 17.09.2026 | Apache-2.0, 2,4 тыс., 01.10.2026 |
| Память в простое, замер | **60 МиБ** (своя 62) | **22 МиБ** (своя 25), ЦП 0,35 % |
| Заявлено | — | «до 30× меньше памяти и до 15× меньше диска, чем Loki/Elasticsearch» (вендор) |
| Срок по умолчанию | **вечно** (`compactor.retention-enabled` выключен) | 7 дней + потолок `-retention.maxDiskSpaceUsageBytes` |
| Сборщик для docker | Alloy (Promtail устарел) | Fluent Bit / Vector / OTel; `vlagent` — только для Kubernetes |

**Вывод: VictoriaLogs + Fluent Bit 5.1.4.** Fluent Bit читает `json-file` контейнеров; замер — **9 МиБ**
(своя 6), ЦП 0,3 %. Драйвер журналов и потолок 5×20 МБ остаются как есть.

### 2.3 «Всё в одном»

| | Лицензия, ★, выпуск | Состав | Требования (док.) | Вердикт |
| --- | --- | --- | --- | --- |
| SigNoz 0.146 | MIT + ee, 32,4 тыс., 14.10.2026 | ClickHouse + Keeper + PostgreSQL + коллектор | «не меньше 4 ГБ памяти Docker» | не помещается |
| OpenObserve 1.1.1 | AGPL-3.0, 22,4 тыс., 16.10.2026 | один бинарник | memtable и кэш по умолчанию — по 50 % памяти машины; срок — 3650 дней | ужать можно, но экосистема Prometheus/Grafana шире |
| Uptrace 2.1-rc | AGPL-3.0, 4,3 тыс., 07.10.2026 | ClickHouse 26.3+ + PostgreSQL + Redis | малый профиль в доке — 24 vCPU / 48 ГБ | не помещается |

### 2.4 Ошибки фронтенда и бэкенда

| | Лицензия, ★, выпуск | Требования (док.) | Вердикт |
| --- | --- | --- | --- |
| Sentry self-hosted 26.10.0 | FSL (через 2 года — Apache-2.0), 9,6 тыс., 16.10.2026 | **4 ядра, 16 ГБ + 16 ГБ свопа, 20 ГБ диска** | больше всей машины |
| GlitchTip 6.2 | MIT, GitLab, коммиты 16.10.2026 | 256 МБ в all-in-one, рекомендовано 512 МБ; PostgreSQL 14+ | вторая очередь: совместим с Sentry SDK, база — наш PostgreSQL 18 |
| Своё | — | 0 | первая очередь: клиент шлёт в ядро вид ошибки → `cord_client_errors_total` и строка журнала, без текста |

### 2.5 Доступность

| | Лицензия, ★, выпуск | Память, замер | Чем хорош |
| --- | --- | --- | --- |
| Uptime Kuma 2.5.6 | MIT, 92,6 тыс., 09.10.2026 | **174 МиБ** (своя 109) | настройка мышкой, своя база |
| Gatus 5.37.0 | Apache-2.0, 12,3 тыс., 24.09.2026 | **13 МиБ** (своя 14), ЦП 0,04 % | проверки в YAML, которые живут в git; сам отдаёт метрики Prometheus |
| Healthchecks.io | BSD-3, 10,4 тыс. ★; SaaS | 0 на машине | **вне машины;** Hobbyist $0: 20 проверок, Telegram |

Gatus проверяет изнутри то, что видно снаружи: главную по внешнему имени, `/rtc`, TCP 443 и 7881, срок
сертификата. Падение самой машины видит только внешний сторож. Alertmanager раз в минуту пингует его вечно
горящим алертом `Watchdog`. Пингов нет дольше 10 минут — приходит сообщение в Telegram.

### 2.6 Дашборды: Grafana OSS 13.2.4

AGPL-3.0, 77,4 тыс. ★, выпуск 13.10.2026. Открытая редакция — образ `grafana/grafana`: `grafana-oss` на
Docker Hub остановился на 13.0.2. В документации минимум — 512 МБ.

**Замер:** `docker stats` — 557 МиБ, через 45 мин — 387; своей памяти стабильно **256–260 МиБ**, остальное —
кэш файлов плагинов. ЦП в простое 6–9 % — самый дорогой компонент. Ставим с `mem_limit: 384m`, без внешних
плагинов и `GF_ANALYTICS_*`; её собственные **3 458 рядов** не собираем. База — отдельная `grafana` в нашем
PostgreSQL (SQLite документация для прода не советует; так база ничего не стоит и попадает в бэкап Cord).
Алерты держат vmalert и Alertmanager: Grafana можно остановить, оповещения не пропадут. Perses 0.54 — ещё до 1.0.

**OpenTelemetry Collector** на старте не нужен: все источники уже говорят на языке Prometheus. Для трасс позже —
OTLP из Spring Boot 4; VictoriaMetrics принимает OTLP-метрики.

## 3. Метрики LiveKit

Генератор `livekit.json` (`scripts/configure.mjs`) добавляет блок ниже. Секрет делается так же, как
`REDIS_PASSWORD`, и лежит в `.env` (`LIVEKIT_METRICS_PASSWORD`).

```json
"prometheus": { "port": 6789, "username": "metrics", "password": "<LIVEKIT_METRICS_PASSWORD>" }
```

| Метрика (`livekit_…`) | Что показывает |
| --- | --- |
| `room_total`, `participant_total`, `room_duration_seconds` | комнаты и участники в SFU. **Боты считаются** — людей берём у ядра |
| `track_published_total{kind}`, `track_subscribed_total{kind}`, `track_publish_counter{kind,state}`, `track_subscribe_counter{state,error}` | дорожки, подписки, неудачи |
| `packet_total`, `packet_bytes{direction,…}` | пакеты и битрейт (через `rate`) |
| `packet_loss_total`, `packet_loss_percent`, `nack_total`, `pli_total`, `fir_total` | потери и запросы ключевых кадров — главный признак плохой связи |
| `jitter_us`, `rtt_ms`, `forward_latency`, `forward_jitter` | задержка и дрожание |
| `quality_score`, `quality_rating` | оценка качества от LiveKit |
| `session_join_latency_ms`, `connection_total`, `participant_join_total` | время и попытки входа |
| `node_messages`, `node_service_operation`, `node_twirp_request_status` | здоровье узла |

У всех метрик есть метки `node_id`/`node_type`. У пакетных ещё и `country`. GeoIP у нас не настроен — пусть
так и остаётся: иначе это лишние ряды и лишние данные о людях. Метрики LiveKit считаются по узлу целиком и
не говорят, в какой встрече плохо. Это скажет ядро по отчётам клиентов (§4).

## 4. Метрики ядра (Micrometer) — что добавить

**Правило:** в метках только перечисления. Никаких `room_id`, id участника, имени, IP, URL — ради
приватности и числа рядов. Неизвестный тип команды → `other`. Вместе с JVM выйдет около 1 100 рядов.

| Метр | Тип | Метки | Где считать |
| --- | --- | --- | --- |
| `cord_rooms_active` | gauge | `state=waiting\|live` (live — двое людей, П7) | снимок `RoomService` |
| `cord_participants_active` | gauge | — (**только люди**) | `RoomState` |
| `cord_bots_active` | gauge | `kind=music\|…` | `RoomState` |
| `cord_meetings_started_total` | counter | — | момент `startedAt` (П7) |
| `cord_meetings_ended_total` | counter | `reason=empty\|closed\|expired\|draining` | `Lifecycle` |
| `cord_meeting_duration_seconds` | histogram 5м/15м/30м/1ч/2ч/4ч | — | при завершении |
| `cord_meeting_peak_participants` | histogram 2…20 | — | при завершении |
| `cord_joins_total` | counter | `result=ok\|room_full\|room_limit\|code_invalid\|password_invalid\|forbidden\|draining\|rate_limited\|error`, `client=web\|desktop\|telegram` | вход (`SessionController`, `RoomService`) |
| `cord_join_seconds` | timer | — | от выдачи токена до вебхука `participant_joined` |
| `cord_rate_limiter_fallback_total` | counter | `reason=timeout\|connection\|other\|paused` | `RateLimits`: шаг предела сосчитан в памяти ядра — Redis не ответил (R106, Р-28; `paused` — 5 с после сбоя Redis не спрашивают) |
| `cord_leaves_total` | counter | `reason=leave\|removed\|timeout\|switched\|closed` | `RoomService`, `MediaService` |
| `cord_commands_total` | counter | `type` (≈55 известных + `other`), `result=ok\|error` | `CommandDispatcher.execute` |
| `cord_errors_total` | counter | `code` (`Problem.code`, ≈45), `status` | `ApiErrors` |
| `cord_integration_sessions_total` | counter | `kind=poker\|durak\|chess\|gartic\|watch\|music\|telegram` | `*.open`, `watch.open`, бот |
| `cord_integrations_active` | gauge | `kind` | `RoomState` |
| `cord_messages_total` | counter | — (только счёт) | `message.send` |
| `cord_attachments_total`, `cord_attachment_bytes_total` | counter | `result` | `TusGateway` |
| `cord_screens_active` | gauge | — | `screen.started` / завершение |
| `cord_media_reconnects_total` | counter | `outcome=lost\|restored` | `media.lost` / `media.restored` |
| `cord_room_sockets` | gauge | — | `RoomSocket` |
| `cord_livekit_webhooks_total` | counter | `event` | `MediaService` |
| `cord_retention_deleted_total` | counter | `kind=room\|event\|attachment\|audit\|stats` | уборка |
| `cord_client_errors_total` | counter | `kind=js\|media\|socket`, `client` | новый `POST /api/client-report` |
| `cord_client_rtt_seconds`, `cord_client_loss_ratio`, `cord_client_jitter_seconds` | histogram | `kind=audio\|video\|screen`, `path=udp\|tcp\|turn` | раз в 30 с из `web/src/media/diagnostics.ts` |
| `cord_build_info` | gauge = 1 | `version` (`CORD_BUILD`) | подписи выкаток на графиках |

Службы (FastAPI, `prometheus_client`): `cord_music_sessions_active`,
`cord_cinema_resolve_total{result,source=youtube|direct|page|other}` (без ссылки), `cord_sniffer_pages_total{result}`.
Доступность площадок кинозала с этого сервера (R112, `cinema/reach.py`; метки — только `provider` и `state`):
`cord_cinema_reachable{provider}` (1 — отвечает, 0 — признана недоступной), `cord_cinema_reach_changes_total{provider,state=open|closed}`,
`cord_cinema_unreachable_refusals_total{provider}` (отказы сразу, без площадки), `cord_cinema_deadline_total{provider}`
(вопросы за сроком 25/30 с) и `cord_cinema_ytdlp_threads{provider}` (занятые площадкой потоки yt-dlp, не больше 6).
Поиск и треки YouTube у музыки идут тем же автоматом: их отказы и сроки считаются в те же `…{provider="youtube"}`.

## 5. Цели сбора и экспортеры

Все контейнеры работают в `network_mode: host`, как остальной Cord, и слушают только 127.0.0.1.

| Цель | Адрес | Что сделать | Память |
| --- | --- | --- | --- |
| Ядро | 127.0.0.1:8080/actuator/prometheus | метры из §4 | 0 |
| LiveKit | :6789 + basic auth | блок `prometheus` (§3) | 0 |
| Шлюз Caddy | 127.0.0.1:2019/metrics | опция `metrics` + сайт `http://127.0.0.1:2019 { metrics /metrics }` | 0 |
| tusd | 127.0.0.1:1080/metrics | уже есть | 0 |
| Службы | 127.0.0.1:18100/metrics | `prometheus_client` | единицы МиБ |
| node_exporter 1.12.1 | 127.0.0.1:9100 | `pid: host`, корень только на чтение, textfile-счётчик soft lockup (§8) | **9–11 МиБ, замер** |
| postgres_exporter 0.20.1 | 127.0.0.1:9187 | роль с `pg_monitor` | не замерялся (Go, ожидаемо 10–20) |
| redis_exporter 1.94.0 | 127.0.0.1:9121 | `REDIS_PASSWORD` | не замерялся (Go, ожидаемо ~10) |
| cAdvisor 0.60.6, по желанию | 127.0.0.1:8081 | `--housekeeping_interval=30s --docker_only`, урезанный `--disable_metrics` | **15–16 МиБ**, замер без нагрузки сбора |

## 6. Рекомендуемый стек и бюджет

| Служба профиля `monitoring` | Версия | `docker stats` | Своя память | ЦП, медиана | `mem_limit` |
| --- | --- | --- | --- | --- | --- |
| VictoriaMetrics | 1.154.0 | 63–74 МиБ | 65–68 МиБ | 1,3 % | 256m |
| vmalert | 1.154.0 | 13–14 МиБ | 14 МиБ | 0,1 % | 64m |
| Alertmanager | 0.34.1 | 22–26 МиБ | 23 МиБ | 0,3 % | 64m |
| Grafana OSS | 13.2.4 | 387–557 МиБ | 256–260 МиБ | 6–9 % | 384m |
| node_exporter | 1.12.1 | 9–11 МиБ | 9 МиБ | 0,8 % | 64m |
| postgres_exporter + redis_exporter | 0.20.1 / 1.94.0 | — | ~30 МиБ (оценка) | — | по 64m |
| Gatus | 5.37.0 | 13–17 МиБ | 14 МиБ | 0,1 % | 64m |
| **Итого, первая очередь** | | **≤ ~560 МиБ** под лимитами | **≈ 410 МиБ** | **≈ 10 % одного ядра** | сумма лимитов 1024m |
| VictoriaLogs + Fluent Bit (вторая очередь) | 1.53.0 / 5.1.4 | 31–42 МиБ | 31 МиБ | 0,6 % | 256m + 64m |
| **Итого с журналами** | | | **≈ 440 МиБ** | | |

Цель «< 600 МиБ» выполнена: весь Cord в простое — 723 МиБ, мониторинг — **~6 % памяти машины**. Для
сравнения: Prometheus + Loki вместо VictoriaMetrics + vmalert + VictoriaLogs — те же ~105 МиБ (44 + 62 против
65 + 14 + 25); Uptime Kuma — 174 МиБ (своя 109, в 8 раз тяжелее Gatus); Umami — 160 МиБ (своя 132) плюс база.
Числа сняты в простое при 8,5 тыс. рядов; после выкатки — замер на живом проде за сутки, медиана и p95.

## 7. Архитектура

```
 интернет ─► edge (caddy-l4 :443) ─► gateway (Caddy) ──► core :8080 ──► PostgreSQL / Redis
                                        │  /ops/grafana/  (forward_auth → core, ADMIN_PASSWORD)
 ┌───────────── профиль monitoring, всё на 127.0.0.1 ───────────────────────────────────┐
 │ VictoriaMetrics :8428 ◄─ раз в 30 с: core, LiveKit :6789, Caddy :2019, tusd, службы, │
 │      ▲    │             node/postgres/redis-экспортеры, Gatus                         │
 │      │    └─► vmalert ─► Alertmanager ─► Telegram (бот Cord, чат владельца)           │
 │      │                       └─► Healthchecks.io (Watchdog раз в минуту, вне машины)   │
 │ Grafana :3000 — дашборды и источники из файлов infra/monitoring/, auth.proxy          │
 │ VictoriaLogs :9428 ◄─ Fluent Bit (tail /var/lib/docker/containers/*/*-json.log)       │
 └────────────────────────────────────────────────────────────────────────────────────────┘
 «Активность» в Cord: ядро → PostgreSQL (встречи, аудит) + HTTP API VictoriaMetrics, если он есть
```

## 8. Алерты в Telegram и урок `vm-host-stalls`

Хост замирает на 20–55 с; мониторинг не должен на каждое замирание кричать «всё упало» и молчать об отбое.
- **«Не отвечает» — не мгновенно:** `max_over_time(up[5m]) == 0` и `for: 5m`; замирание короче 5 мин не будит.
- **Замирание — отдельный алерт `HostStalled`.** Таймер systemd раз в минуту считает soft lockup в
  `journalctl -k -b` и пишет `cord_host_soft_lockups_total` в textfile-коллектор node_exporter. Срабатывает,
  если счётчик вырос за 15 мин или steal > 30 % десять минут; через `inhibit_rules` гасит `*Down`,
  `JoinFailures`, `ErrorRate` — вместо десятка сообщений одно: «хост замирал N раз, steal X %».
- **Отбой обязателен:** `send_resolved: true`; `group_wait: 1m`, `group_interval: 5m`, `repeat_interval: 6h`.
- **Правила:** `CoreDown`, `SfuDown`, `PostgresDown`, `RedisDown`; `DiskFree < 15 %`, `MemAvailable < 10 %`,
  `CertExpiry < 14d`; `JoinFailures` (доля `cord_joins_total{result!="ok"}` > 20 % за 10 мин), `ErrorRate5xx`;
  `PacketLoss` (`livekit_packet_loss_percent` > 5 % десять минут при живых встречах); `HostStalled`, `Watchdog`.
- **Куда:** `telegram_configs` Alertmanager; бот — уже существующий бот Cord, чат — `ALERT_TELEGRAM_CHAT_ID`
  в `.env` (действие владельца).

## 9. Продуктовая аналитика

| | Лицензия, ★, выпуск | Состав и требования (док.) | Память, замер | Вердикт |
| --- | --- | --- | --- | --- |
| Umami 3.4.0 | MIT, 39,5 тыс., 17.09.2026 | Node, только PostgreSQL ≥ 12.14, без cookie | **160 МиБ** (своя 132) + база | по желанию, только публичные страницы (`/`, `/download`) |
| Plausible CE 3.2.1 | AGPL-3.0, 29,5 тыс., 15.05.2026 | ClickHouse + PostgreSQL, «≥ 2 ГБ», SSE 4.2 | — | не помещается |
| Matomo 5.14.1 | GPL-3.0, 22,0 тыс., 04.10.2026 | PHP 8 + MySQL/MariaDB; малый сайт — 2 CPU / 2 ГБ / 50 ГБ | — | тяжело и не про встречи |
| PostHog (hobby) | MIT + ee, 40,3 тыс. | ClickHouse, Kafka, ZooKeeper, Redis, MinIO; **4 vCPU / 16 ГБ**; официально без поддержки | — | не помещается |
| OpenPanel 3.4 | AGPL-3.0, 7,2 тыс. | ClickHouse + PostgreSQL + Redis (+ Redpanda), «≥ 4 ГБ» | — | не помещается |

**Вывод — своя статистика из событий ядра.** Учётных записей нет, и всё действие идёт через ядро: вход,
команды, интеграции, вебхуки LiveKit. Веб-трекер не видит ни встреч, ни SFU, ни клиента Electron. Своя
статистика стоит ноль памяти и не выносит данные наружу. Миграция `V8__activity.sql`:

```sql
-- Одна строка на встречу в смысле П7: от «двое живых людей» до конца. Ни названия, ни текста.
CREATE TABLE meeting_stats (
    room_id VARCHAR(36) NOT NULL,                  -- без FK: статистика переживает комнату
    started_at BIGINT NOT NULL, ended_at BIGINT,   -- мс, как в остальных таблицах
    peak_humans SMALLINT NOT NULL,
    unique_devices SMALLINT NOT NULL,              -- различных профилей устройства за встречу
    human_seconds BIGINT NOT NULL, screen_seconds BIGINT NOT NULL DEFAULT 0,
    integrations TEXT[] NOT NULL DEFAULT '{}',     -- {'poker','watch',...}
    messages INT NOT NULL DEFAULT 0,               -- только счёт
    reconnects INT NOT NULL DEFAULT 0, end_reason VARCHAR(16),
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (room_id, started_at)
);
CREATE INDEX meeting_started ON meeting_stats(started_at);
CREATE INDEX meeting_expiry ON meeting_stats(expires_at);
-- Итоги дня. Уникальные устройства считает HyperLogLog в Redis (PFADD хэша с суточной солью):
-- идентификаторы не хранятся нигде, в базу ложится только число.
CREATE TABLE activity_daily (
    day DATE PRIMARY KEY,
    unique_devices INT NOT NULL, joins INT NOT NULL, join_failures INT NOT NULL,
    meetings INT NOT NULL, human_seconds BIGINT NOT NULL
);
```

## 10. Аудит: своя таблица в PostgreSQL

```sql
CREATE TABLE audit_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at BIGINT NOT NULL, expires_at BIGINT NOT NULL,   -- at + stream.retention.audit; уборка как у room_events
    action VARCHAR(48) NOT NULL,         -- перечисление ниже
    outcome VARCHAR(8) NOT NULL DEFAULT 'ok',  -- ok | denied | error
    code VARCHAR(48),                    -- Problem.code при отказе
    room_id VARCHAR(36), target_id VARCHAR(36),  -- без FK
    actor_kind VARCHAR(12) NOT NULL,     -- participant | creator | bot | system | admin
    actor_id VARCHAR(36),                -- id участника из токена
    actor_name VARCHAR(64),              -- отображаемое имя на момент события
    ip_hash CHAR(22),                    -- base64url(HMAC-SHA256(AUDIT_IP_KEY, ip)), первые 22 знака
    details JSONB                        -- только перечислимые поля: kind, reason, имена ключей
);
CREATE INDEX audit_at ON audit_events(at DESC, id DESC);
CREATE INDEX audit_room ON audit_events(room_id, at DESC);
CREATE INDEX audit_action ON audit_events(action, at DESC);
CREATE INDEX audit_expiry ON audit_events(expires_at);
```

| Группа | События |
| --- | --- |
| Сервер | `server.started`, `server.draining`, `deploy.applied` (версия `CORD_BUILD`), `admin.login`, `admin.login_failed`, `access.password_failed` (не чаще раза в минуту на `ip_hash`) |
| Встреча | `room.created`, `room.settings_changed` (только имена ключей), `room.closed` (кем или `system`), `room.expired` |
| Участие | `participant.joined` (`outcome` + `code`: `ROOM_FULL`, `CODE_INVALID`…), `participant.left` (`reason`), `participant.removed` (кто кого), `microphone.muted_by`, `session.switched` (П13) |
| Приглашения | `invite.created`, `invite.revoked`, `invite.used` |
| Интеграции | `integration.opened` / `integration.closed` (`kind`), `music.bot_joined` / `music.bot_left` |
| Файлы | `attachment.uploaded` (размер и класс типа, **без имени**), `attachment.deleted`, `attachment.expired` |
| Связь | `media.lost` / `media.restored` — для разбора T38 вместе с `HostStalled` |

**Объём:** 200 встреч в сутки × ~30 событий × ~250 байт ≈ 1,5 МБ в сутки, за 3 месяца с индексами ~150 МБ.
Секционирование не нужно. **Сроки — словами,** рядом с остальными (`config/Term.java`):

```yaml
  retention:
    # Журнал аудита: кто что сделал во встрече. Трёх месяцев хватает на разбор жалобы.
    audit: ${AUDIT_RETENTION:3 months}
    # Строки встреч для графиков «за период». Год — чтобы сравнивать с прошлым сезоном.
    meeting-stats: ${MEETING_STATS_RETENTION:1 year}
    # Итоги дня — только числа, без людей.
    activity-daily: ${ACTIVITY_DAILY_RETENTION:never}
```

Сроки профиля `monitoring` — тоже словами в `.env` (`METRICS_RETENTION=3 months`, `LOGS_RETENTION=14 days`);
`configure.mjs` переводит их во флаги `-retentionPeriod=3` / `14d` и добавляет журналам потолок 2 ГиБ.

## 11. Приватность

- **Никогда не собираются** (ни в метрики, ни в журналы, ни в аудит, ни в статистику): текст сообщений, имена
  и содержимое файлов, ссылки, названия и запросы кинозала и музыки, ходы и чат игр, названия комнат.
- **Метки метрик** — только перечисления (§4). Имена и id людей — только в аудите и только на его срок.
- **IP.** В аудите — HMAC-SHA256 с секретом `AUDIT_IP_KEY` из `.env` (генерирует `configure.mjs`). Обычный
  хэш с солью не годится: IPv4-адресов всего 2³², при известной соли такой хэш перебирается за минуты.
  Уникальных считаем с суточной солью, как Plausible (`hash(daily_salt + …)`, соль удаляется через 24 ч),
  через HyperLogLog. Сами IP не хранятся.
- **Журналы.** Lua-фильтр Fluent Bit вырезает IPv4/IPv6 и URL (кроме путей Cord) до VictoriaLogs; главное же —
  службы не пишут ссылки кинозала в журнал вовсе (E10-B проверяет grep-тестом).
- **Доступ.** «Активность» и `/ops/grafana/` открываются только по `ADMIN_PASSWORD` — подписанным токеном
  по механизму `ServerAccess`. Grafana работает в `auth.proxy` за `forward_auth` Caddy. VictoriaMetrics,
  VictoriaLogs и Alertmanager наружу не публикуются.
- **Закон.** IP и отображаемое имя могут быть персональными данными (152-ФЗ, GDPR). Поэтому у них короткий
  срок, названная цель (безопасность и разбор жалоб) и описание здесь. Это не юридическая консультация.

## 12. Страница «Активность» (для владельца сервера)

Адрес `/activity`, API `/api/admin/activity/*`, вход по `ADMIN_PASSWORD` с ограничением частоты. «Сейчас» —
живой `RoomState`; «за период» и журнал — PostgreSQL (§9–10), поэтому работают без профиля `monitoring`;
«Сервер» — HTTP API VictoriaMetrics, если профиль включён (иначе подсказка «включите monitoring»). Графики —
по скиллу `dataviz`.

| Вкладка | Что на ней |
| --- | --- |
| Сейчас | Плитки: встречи `live`/`waiting`, люди, боты, демонстрации, идущие интеграции. Таблица живых встреч: код, длительность от `startedAt`, люди, значки интеграций, качество (потери и RTT от клиентов). |
| Встречи | Период 24 ч / 7 д / 30 д / свой. Плитки: встречи, человеко-часы, уникальные устройства, медиана длительности, пик одновременных. Графики: столбцы по дням, линия одновременных людей, гистограмма длительности. |
| Интеграции | Сессии и доля встреч с интеграцией по `kind` (горизонтальные столбцы), тренд по неделям. |
| Качество | Доля минут с потерями > 5 %, медиана и p95 RTT (клиенты и LiveKit), переподключения, доля TURN. |
| Входы и ошибки | Входы по результату (столбцы с накоплением), топ-10 кодов ошибок, ошибки клиента по виду. |
| Журнал | `audit_events`: фильтры (период, группа, код встречи, участник, исход), страницы по `(at, id)`, выгрузка CSV. |
| Сервер | ЦП с отдельной линией steal, память, диск, soft lockup за сутки, версия сборки, сроки хранения словами, ссылка на Grafana. |

## 13. Платить или нет

| Сервис | Бесплатно | Платно (официальный прайс) | Для Cord |
| --- | --- | --- | --- |
| Grafana Cloud | 10 тыс. рядов, 50 ГБ журналов и трасс, 14 дней, 3 пользователя | Pro $19/мес + $6,50 за 1 тыс. рядов сверх 10 тыс.; журналы $0,05/ГБ обработка + $0,40/ГБ запись | ~10–15 тыс. рядов → $19–52/мес; данные встреч в облаке |
| Datadog | — | Infrastructure Pro $15/хост/мес за год или $18 помесячно; журналы $0,10/ГБ + $1,70 за 1 млн индексированных (15 дней); APM Pro $35/хост | от $15/мес за то, что VictoriaMetrics делает даром |
| Better Stack | 10 проверок, 1 статус-страница, 3 ГБ журналов на 3 дня | Responder $29/мес за год или $34 помесячно; журналы $0,10–0,15/ГБ | Telegram в прайсе не указан (только webhook) |
| Sentry (облако) | Developer: 5 тыс. ошибок, 1 пользователь | Team $26/мес | GlitchTip даёт то же у себя |
| UptimeRobot | 50 проверок раз в 5 мин; с 2024 — только некоммерческое использование | Solo от €9/мес, раз в минуту | для продукта бесплатный тариф не годится |
| Healthchecks.io | Hobbyist: 20 проверок, Telegram | Business $20/мес | **берём бесплатный** — сторож вне машины |

**Честный ответ.** Платить за мониторинг сейчас не нужно. Открытый стек занимает ~6 % памяти машины, держит
данные у себя (П8) и не ограничивает ни ряды, ни пользователей. Платные выигрывают в одном: они живут вне
машины, и эту часть закрывает бесплатный Healthchecks.io. Если тратить деньги, то **на хост без steal**:
мониторинг не вылечит замирания на 20–35 с, он их только покажет и посчитает. Вернуться к вопросу стоит, когда
серверов Cord станет несколько: тогда — центральный VictoriaMetrics на отдельной машине или Grafana Cloud Pro.

## 14. План E10-B

1. **Ядро:** метры §4 и `POST /api/client-report`; миграции `meeting_stats`, `activity_daily`, `audit_events`,
   сроки словами, уборка в `Lifecycle`; `ADMIN_PASSWORD` по механизму `ServerAccess`; тесты — метки только из
   перечисления, текст сообщений в аудит не попадает.
2. **Источники:** блок `prometheus` в `livekit.json` с паролем из `.env`, `metrics` в Caddyfile на 127.0.0.1:2019,
   `prometheus_client` в службах.
3. **Профиль `monitoring` в `compose.yaml`:** службы §6 — `network_mode: host`, только 127.0.0.1, `mem_limit`,
   `logging: *default-logging`, образы по digest; `setup.sh --monitoring` (по умолчанию выключен), `update.sh`
   сохраняет `COMPOSE_PROFILES` в `.env`.
4. **Как код в `infra/monitoring/`:** `scrape.yml`, `rules/*.yml`, `alertmanager.yml` из `configure.mjs`
   (Telegram, inhibit), провиженинг Grafana («Сервер», «SFU», «Встречи», «Качество связи», «Интеграции»,
   «Ошибки клиента»), таймер soft lockup.
5. **Страница «Активность»** (§12); e2e: без секрета — 403, с секретом — открывается.
6. **Внешний сторож:** владелец создаёт проверку Healthchecks.io и кладёт URL в `.env` (`OWNER-ACTIONS.md`).
7. **Вторая очередь:** VictoriaLogs + Fluent Bit с фильтром приватности; по желанию — GlitchTip и Umami.
8. **Замер на проде за сутки:** медиана и p95 памяти и ЦП каждого контейнера, число рядов, рост диска →
   `docs/capacity.md`. Готово, когда дашборды показывают живую встречу, «Активность» открывается только с
   секретом и замер записан.

Предлагаемая запись в `DECISIONS.md` («Решено агентом»):

> E10-A: стек `monitoring` — VictoriaMetrics + vmalert + Alertmanager (Telegram) + Grafana OSS + экспортеры
> + Gatus; журналы второй очередью (VictoriaLogs + Fluent Bit). Статистика встреч и аудит — свои, в
> PostgreSQL. Внешний сторож — Healthchecks.io free. Платного нет. Простой ≈ 410 МиБ (`docs/observability.md`).

## 15. Внедрено (E10-B, 20.10.2026)

Ключи и команды — `docs/deployment.md` → «Наблюдаемость». Решения — `backlog/DECISIONS.md` → «E10-B».

**Ядро.**
- **Метры** `cord_*` (`activity/Metrics.java`): встречи `live`/`waiting`, люди на местах и на связи, боты,
  демонстрации, интеграции по виду, начатые и завершённые встречи по причине (`host`, `empty`, `unused`,
  `ceiling`, `server`), длительность и пик (гистограммы), входы по двери и исходу, отказы по коду,
  блоки, версия сборки. Метки — только перечисления; тест `ActivityTest.meterLabelsAreOnlyEnumerations`.
  Живые числа считаются по комнатам не чаще раза в 10 с.
- **V9**: `meeting_stats` (§9, но интеграции — словами через пробел, а не `TEXT[]`: одна и та же миграция
  должна работать на H2 тестов), `activity_daily` (итоги дня по UTC, пересчёт за сегодня и вчера раз в
  5 мин), `audit_events` (§10). Человеко-секунды досчитываются при каждом изменении числа людей на связи,
  поэтому перезапуск ядра посреди встречи их не теряет. Уникальные устройства — HyperLogLog Redis на
  сутки (отпечатки не хранятся нигде).
- **Журнал** пишет: создание и завершение встречи, входы и отказы во входе (отказ — не чаще раза в
  минуту на адрес и код), исключение ведущим, крупные загрузки (размер, без имени), вход владельца и его
  рычаги, блоки и автоблоки. Тест: ни название встречи, ни текст сообщения, ни сам адрес в таблицы не
  попадают.
- **V10 `blocks`**, автоблок, `AdminAccess` и страница «Активность» — `docs/abuse-model.md` §5, §9.
- **Квота загрузок на адрес** (A10), «Вы ещё здесь?» и `idle-integrations` (A2) — там же.

**Страница «Активность»** (`/activity`, §12): вкладки «Сейчас» (плитки и таблица живых встреч с
рычагами), «Встречи» (сутки / 7 / 30 дней: встречи, человеко-часы, медиана, пик, устройства, входы;
столбцы по дням, по длительности и по интеграциям), «Журнал» (фильтры: что, исход, код встречи; страницы;
«Заблокировать» у строки), «Блокировки» (снять), «Сервер» («щит», автоблок, сроки, версия, как открыть
Grafana). Работает без профиля `monitoring`.

**Профиль `monitoring`** — §6 целиком, кроме второй очереди: VictoriaMetrics 1.154.0, vmalert,
Alertmanager 0.34.1, Grafana OSS 13.2.4, node/postgres/redis-экспортеры, Gatus 5.37.0; образы по digest,
`network_mode: host`, только 127.0.0.1, `mem_limit`. Сбор — `infra/monitoring/scrape.yml` (ядро, LiveKit
с паролем, шлюз Caddy на 127.0.0.1:2019, tusd, службы `/metrics`, машина, база, Redis, Gatus, сам
мониторинг). Алерты — `infra/monitoring/rules/cord.yml` по §8; Alertmanager — из `configure.mjs` (Telegram
бота Cord и Healthchecks.io из `.env`, `HostStalled` гасит только `JoinFailures` и `GatewayErrors5xx` — постоянный steal этой машины иначе глушил бы всё). Дашборды — генератор
`infra/monitoring/grafana/dashboards.mjs`; CI проверяет профиль теми же образами (`-dryRun`, `amtool`).

**Отличия от плана §14 — и почему.**
- **Grafana — через SSH-туннель, не `/ops/grafana/` за `forward_auth`.** Путь через шлюз требовал бы
  куки владельца (браузер не ставит заголовок на переход по ссылке), своей CSP для Grafana рядом с CSP
  Cord и `auth.proxy`. Туннель не открывает ничего нового наружу; страница «Активность» говорит, как
  его открыть.
- **База Grafana — SQLite в томе, не отдельная база в нашем PostgreSQL.** Дашборды и источник — из git,
  в базе Grafana остаются только пароль и пользовательские мелочи; отдельная роль и база в PostgreSQL —
  лишний шаг установки ради этого.
- **Отдельного `AUDIT_IP_KEY` нет.** Адрес в журнале, блоках и `rooms.state.createdFrom` — один и тот же
  отпечаток `Secrets.address` (HMAC-SHA256 секретом сервера): поэтому «заблокировать создателя этой
  встречи» и «заблокировать адрес из строки журнала» — одно действие, а ключом меньше в `.env`. Цена:
  смена `SESSION_SECRET` обнуляет и блоки по адресу — она и так завершает все сессии.
- **`HostStalled` — по steal**, без таймера soft lockup в textfile-коллекторе: steal виден node_exporter
  сам, а замирание хоста и есть отнятое процессорное время.
- **Срок рядов — `METRICS_RETENTION=90d`** (формат VictoriaMetrics), а не словами: перевод слов во флаг
  потребовал бы генерировать `compose.yaml`.

**Качество связи от браузеров (хвосты функций, 21.10.2026).**
- `POST /api/v1/rooms/{id}/client-report` — итог звонка одного входа, в конце звонка (конец встречи, уход
  со страницы, `pagehide`; `keepalive`): секунды, медиана оборота, средние потери и джиттер приёма, битрейт
  приёма, замирания картинки, секунды с потерями > 5 %, путь (`direct-udp|direct-tcp|relay-udp|relay-tcp|
  unknown`) и кодек картинки (`vp8|vp9|h264|h265|av1|other`). Ни имён, ни адресов, ни номеров участников.
  Пропуск — участника (годится и после выхода); один итог на вход, 30 в минуту с адреса; заход короче 10 с
  итога не шлёт (`web/src/media/call-quality.ts`, копится из опроса буфера, своего getStats нет).
- Отличие от плана §4: не метры раз в 30 с от каждого клиента, а один итог на вход — он и ложится в
  статистику встречи. Комнату в адресе выбрали, потому что итог принадлежит встрече и проверяется пропуском
  участника.
- **V12** — столбцы качества в `meeting_stats` (суммы и число итогов по каждой величине, худший оборот,
  секунды с потерями, замирания, итоги через TURN, кодеки словами); звонок одного человека встречей не был
  (П7) — его итог принят и забыт. Метры `cord_client_reports_total{path}`, `cord_client_rtt_seconds`,
  `cord_client_jitter_seconds`, `cord_client_loss{path}`, `cord_client_freezes_total`.
- «Активность» → «Качество» (`GET /api/v1/admin/quality?from&to&tz`): средний и худший оборот, потери, доля
  времени с потерями > 5 %, джиттер, приём, замирания в час, доля TURN; оборот по дням, кодеки, последние
  встречи с итогами. Переподключений и оборота LiveKit здесь нет — они в Grafana.

**Не сделано (следующий шаг).**
- Вторая очередь: VictoriaLogs + Fluent Bit с фильтром приватности; GlitchTip.
- Замер памяти и ЦП профиля на проде за сутки (§14 п. 8) — после выкатки; E10-A мерил стек по отдельности.
- Аудит хостов «По ссылке» (A9) — в службе, вместе с E07.

## Источники

- Prometheus, хранение: https://prometheus.io/docs/prometheus/latest/storage/ · память на ряд: https://www.robustperception.io/how-much-ram-does-prometheus-2-x-need-for-cardinality-and-ingestion/
- VictoriaMetrics single-node (ёмкость, срок, `-promscrape.config`): https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/ · бенчмарк вендора: https://valyala.medium.com/prometheus-vs-victoriametrics-benchmark-on-node-exporter-metrics-4ca29c75590f
- VictoriaLogs: https://docs.victoriametrics.com/victorialogs/ · Loki, сроки: https://grafana.com/docs/loki/latest/operations/storage/retention/
- Grafana, требования и образ: https://grafana.com/docs/grafana/latest/setup-grafana/installation/ · https://grafana.com/docs/grafana/latest/setup-grafana/installation/docker/
- SigNoz: https://signoz.io/docs/install/docker/ · OpenObserve: https://openobserve.ai/docs/environment-variables/ · Uptrace: https://uptrace.dev/get/hosted/install
- Sentry self-hosted: https://develop.sentry.dev/self-hosted/ · GlitchTip: https://glitchtip.com/documentation/install · Gatus: https://github.com/TwiN/gatus · Uptime Kuma: https://github.com/louislam/uptime-kuma · Healthchecks.io: https://healthchecks.io/pricing/
- Alertmanager `telegram_config`: https://prometheus.io/docs/alerting/latest/configuration/#telegram_config
- LiveKit 1.13.6: https://github.com/livekit/livekit/blob/v1.13.6/pkg/service/server.go · https://github.com/livekit/livekit/tree/v1.13.6/pkg/telemetry/prometheus · https://github.com/livekit/livekit/blob/v1.13.6/config-sample.yaml
- Caddy без admin API: https://caddyserver.com/docs/metrics · https://caddyserver.com/docs/caddyfile/directives/metrics · tusd: https://github.com/tus/tusd/blob/v2.10.0/cmd/tusd/cli/flags.go
- Umami: https://docs.umami.is/docs/install · Plausible CE: https://github.com/plausible/community-edition · суточная соль: https://plausible.io/data-policy
- Matomo: https://matomo.org/faq/on-premise/matomo-requirements/ · PostHog: https://posthog.com/docs/self-host · OpenPanel: https://openpanel.dev/docs/self-hosting/self-hosting
- Цены: https://grafana.com/pricing/ · https://www.datadoghq.com/pricing/list/ · https://betterstack.com/pricing · https://sentry.io/pricing/ · https://uptimerobot.com/pricing/
