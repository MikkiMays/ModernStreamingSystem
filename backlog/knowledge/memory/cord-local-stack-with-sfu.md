---
name: cord-local-stack-with-sfu
description: "Как поднять рядом с продом Cord полный второй стенд со своим SFU и проверять на нём медиа, ничего не трогая"
metadata: 
  type: reference
---

К [[cord-ui-checks-on-prod]] есть важное дополнение: «встреча на dev-сервере живёт 20 секунд»
обходится не терпением, а **вторым SFU** на своих портах, отличных от продовых: LiveKit ничего
общего с продовым не имеет, пока порты не совпали.

Три контейнера рядом с продом, ничего общего с ним (номера портов и адреса — свои, свободные;
готовые значения — в `web/.local/stack.sh`):

```bash
# 1. SFU на своих портах (конфиг: свои port / rtc.tcp / rtc.udp, привязка к локальному адресу,
#    enable_loopback_candidate: true, keys.devkey = 32-байтный секрет)
docker run --rm -d --name cord-poker-sfu --network host \
  -v /путь/livekit.yaml:/etc/livekit.yaml:ro livekit/livekit-server:v1.13.6 --config /etc/livekit.yaml

# 2. Ядро из свежесобранного образа: H2 в памяти, свой порт, PUBLIC_URL = адрес vite
docker run --rm -d --name cord-poker --network host \
  -e SPRING_PROFILES_ACTIVE=local -e SERVER_PORT=<порт ядра> -e PUBLIC_URL=<адрес vite> \
  -e LIVEKIT_URL=<адрес SFU> -e LIVEKIT_INTERNAL_URL=<адрес SFU> \
  -e DATABASE_PASSWORD=x -e FILES_ROOT=/tmp/uploads \
  -e SPRING_DATASOURCE_URL='jdbc:h2:mem:poker;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1' \
  modern-streaming-core:latest

# 3. Веб: vite на свободном порту, который и назван в PUBLIC_URL
CORD_DEV_API=<адрес ядра> npx vite --host <локальный адрес> --port <порт vite> --strictPort
```

Дальше **обычный Playwright**, включая спеки из `web/e2e`:
`PLAYWRIGHT_BASE_URL=<адрес vite> npx playwright test e2e/poker.spec.ts`. 20.09.2026 так
прошёл полный сценарий покера с двумя камерами за 22 секунды.

Что здесь важно и неочевидно:

- **Ключ SFU задаёт не окружение, а профиль `local`.** `application-local.yml` жёстко ставит
  `livekit-key: devkey` и тестовый `livekit-secret`, и переменные
  `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` его не перебивают. В `livekit.yaml` должна стоять ровно
  та же пара ключей, иначе встреча доходит до «Возвращаемся в разговор», а в журнале SFU —
  `invalid authorization token`. Там же в профиле уже прописан адрес SFU стенда, так что
  `LIVEKIT_URL` можно не передавать.
- **Springdoc можно включить прямо на стенде** (`-e SPRINGDOC_API_DOCS_ENABLED=true`) и
  генерировать контракты с него же: `API_SCHEMA_URL=<адрес ядра>/api/openapi npm run
  generate:api`. Отдельный контейнер ради схемы ([[cord-openapi-regeneration]]) тогда не нужен.
- **`PUBLIC_URL` обязан совпадать с адресом vite** до буквы. `RequestGuard` сравнивает `Origin`
  строкой, а `EventConfig` отдаёт его же в `setAllowedOrigins` для WebSocket. Имя хоста и
  числовой адрес — разные строки.
- Стандартный порт vite часто занят **забытыми dev-серверами** (`ps -eo cmd | grep vite`).
  Проще взять другой порт, чем разбираться, чей он.
- Медиа-вебхуки LiveKit в такой связке не доходят (шлюза, который ставит `X-Internal-Secret`,
  нет) — и это ничего не ломает: «В эфире» включает команда `media.restored` от самого клиента.
- Образ собирается `docker compose build core` и берётся по тегу `modern-streaming-core:latest`;
  прод при этом продолжает работать на **старом** образе, пока его не перезапустили.
- Прибрать за собой: `docker rm -f cord-poker cord-poker-sfu` и убить свой vite.

Проверка выкатки — Playwright против `https://meet.nikg.tech`.

**Готовый скрипт стенда кинозала (25.09.2026):** `web/.local/stack.sh up [--services] | status | down` в
прод-checkout (каталог gitignored): свои SFU, ядро, служба, vite и плеер страниц в отдельной
подсети за той же стеной, что у прода. `up`/`down` снимают и ставят стену dev-подсети и сносят
чужие контейнеры `cord-dev-*` — два агента параллельно на нём не работают. Рядом: `parity/` (эталоны вида
каталога YouTube/Twitch и пульта), `live-*.mjs` (живые проверки площадок против прода), `recorded/`
(фикстуры ответов площадок).
