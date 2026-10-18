---
name: cord-local-stack-with-sfu
description: "Как поднять рядом с продом Cord полный второй стенд со своим SFU и проверять на нём медиа, ничего не трогая"
metadata: 
  type: reference
---

К [[cord-ui-checks-on-prod]] есть важное дополнение: «встреча на dev-сервере живёт 20 секунд»
обходится не терпением, а **вторым SFU**. Прод занимает 7880/7881/7882, и свободных портов рядом
сколько угодно — а LiveKit ничего общего с продовым не имеет, пока не совпали порты.

Три контейнера рядом с продом, ничего общего с ним:

```bash
# 1. SFU на своих портах (конфиг: port 7883, rtc.tcp 7884, rtc.udp 7885, bind 127.0.0.1,
#    node_ip 127.0.0.1, enable_loopback_candidate: true, keys.devkey = 32-байтный секрет)
docker run --rm -d --name cord-poker-sfu --network host \
  -v /путь/livekit.yaml:/etc/livekit.yaml:ro livekit/livekit-server:v1.13.6 --config /etc/livekit.yaml

# 2. Ядро из свежесобранного образа: H2 в памяти, свой порт, PUBLIC_URL = адрес vite
docker run --rm -d --name cord-poker --network host \
  -e SPRING_PROFILES_ACTIVE=local -e SERVER_PORT=8099 -e PUBLIC_URL=http://127.0.0.1:5199 \
  -e LIVEKIT_URL=ws://127.0.0.1:7883 -e LIVEKIT_INTERNAL_URL=http://127.0.0.1:7883 \
  -e DATABASE_PASSWORD=x -e FILES_ROOT=/tmp/uploads \
  -e SPRING_DATASOURCE_URL='jdbc:h2:mem:poker;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1' \
  modern-streaming-core:latest

# 3. Веб: vite на свободном порту, который и назван в PUBLIC_URL
CORD_DEV_API=http://127.0.0.1:8099 npx vite --host 127.0.0.1 --port 5199 --strictPort
```

Дальше **обычный Playwright**, включая спеки из `web/e2e`:
`PLAYWRIGHT_BASE_URL=http://127.0.0.1:5199 npx playwright test e2e/poker.spec.ts`. 20.09.2026 так
прошёл полный сценарий покера с двумя камерами за 22 секунды.

Что здесь важно и неочевидно:

- **Ключ SFU задаёт не окружение, а профиль `local`.** `application-local.yml` жёстко ставит
  `livekit-key: devkey` и `livekit-secret: local-development-only-secret-32bytes`, и переменные
  `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` его не перебивают. В `livekit.yaml` должно стоять ровно
  `keys: { devkey: local-development-only-secret-32bytes }`, иначе встреча доходит до «Возвращаемся
  в разговор», а в журнале SFU — `invalid authorization token`. Там же в профиле уже прописан порт
  7883, так что `LIVEKIT_URL` можно не передавать.
- **Springdoc можно включить прямо на стенде** (`-e SPRINGDOC_API_DOCS_ENABLED=true`) и
  генерировать контракты с него же: `API_SCHEMA_URL=http://127.0.0.1:8099/api/openapi npm run
  generate:api`. Отдельный контейнер ради схемы ([[cord-openapi-regeneration]]) тогда не нужен.
- **`PUBLIC_URL` обязан совпадать с адресом vite** до буквы. `RequestGuard` сравнивает `Origin`
  строкой, а `EventConfig` отдаёт его же в `setAllowedOrigins` для WebSocket. `localhost` и
  `127.0.0.1` — разные строки.
- Порт 5173 на этой машине часто занят **забытыми dev-серверами**
  (`ps -eo cmd | grep vite`). Проще взять другой порт, чем разбираться, чей он.
- Медиа-вебхуки LiveKit в такой связке не доходят (шлюза, который ставит `X-Internal-Secret`,
  нет) — и это ничего не ломает: «В эфире» включает команда `media.restored` от самого клиента.
- Образ собирается `docker compose build core` и берётся по тегу `modern-streaming-core:latest`;
  прод при этом продолжает работать на **старом** образе, пока его не перезапустили.
- Прибрать за собой: `docker rm -f cord-poker cord-poker-sfu` и убить свой vite.

`docker compose up -d` по собственной инициативе **блокируется классификатором разрешений**:
собрать образы и поднять стенд можно всегда, а выкатить прод — только когда владелец попросил
об этом прямо (тогда команда проходит). `gh` на машине нет, поэтому за прогонами CI отсюда не
посмотреть — проверка выкатки это Playwright против `https://meet.nikg.tech`.

**Готовый скрипт стенда кинозала (25.09.2026):** `web/.local/stack.sh up [--services] | status | down` в
прод-checkout (каталог gitignored): SFU 7883–7885, ядро 8099, служба 18101, vite 5199, плеер страниц 18113 в
подсети 10.231.1.0/24 за той же стеной, что у прода. `up`/`down` снимают и ставят стену dev-подсети и сносят
чужие контейнеры `cord-dev-*` — два агента параллельно на нём не работают. Рядом: `parity/` (эталоны вида
каталога YouTube/Twitch и пульта), `live-*.mjs` (живые проверки площадок против прода), `recorded/`
(фикстуры ответов площадок).
