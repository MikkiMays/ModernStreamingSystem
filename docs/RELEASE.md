# Выпуск и выкатка Cord

Порядок выпуска для любого исполнителя — человека или модели. Шаги идут по порядку, команды сверены со
скриптами репозитория на 01.11.2026. Устройство сервера, режимы TLS, пределы и мониторинг — в
[deployment.md](deployment.md), установка с нуля — в [INSTALL.md](INSTALL.md). Здесь — только что и в каком
порядке делать.

Пути — от `$CORD_ROOT`: каталога, где рядом лежат `ModernStreamingSystem` и `ModernStreamingSystem.Windows`. На
машине `callcord.ru` это `/opt`.

## Коротко

1. Номер выпуска — в `web/`, `mobile/`, `desktop/` (§1).
2. Работа — в своём worktree от свежего `origin/main` (§2).
3. Точечные проверки тронутого, контракты, переводы (§3).
4. CI ветки зелёный → fast-forward в `main` (§4).
5. Стенд: нет встреч → `backlog/bin/deploy.sh <службы>` → проверки и e2e (§5).
6. Другие серверы — тот, у кого есть ssh: `./update.sh` после проверки встреч (§6).
7. Клиент Windows: пуш `main` репы Windows → релиз `desktop-vX.Y.Z` → зеркало на продукте и на стенде (§7).
8. APK — артефакт CI (§8).
9. Журнал, статус, Grafana (§9).

Жёсткие правила: никогда `docker compose down -v`; выкатка — только без идущих встреч; контракты — только
скриптом; чужие коммиты не терять, force-push нет; то, что может только владелец, — в
`backlog/OWNER-ACTIONS.md` (§11).

## 1. Что такое выпуск

Выпуск — одна версия продукта `X.Y.Z` у веба с ядром, клиента Windows и приложения Android (решение Р-46,
`backlog/DECISIONS.md`). Своего номера у ядра нет: «О программе» показывает версию веба, а веб едет внутри
шлюза. Клиент Windows и APK получают номер выпуска, когда выходят в нём; неизменённый клиент не перевыпускается
(`backlog/<волна>/PLAN.md` → «Выпуски»).

| Что | Где номер | Как поднять |
| --- | --- | --- |
| Веб и ядро | `web/package.json`, `web/package-lock.json` | `cd web && npm version X.Y.Z --no-git-tag-version` |
| Android | `mobile/package.json`, `mobile/package-lock.json` | `cd mobile && npm version X.Y.Z --no-git-tag-version` |
| Android | `versionName`, `versionCode` в `mobile/android/app/build.gradle` | команда ниже; `versionCode` растёт на единицу каждый выпуск APK |
| Клиент Windows | `desktop/package.json`, `desktop/package-lock.json` (репа Windows) | `cd desktop && npm version X.Y.Z --no-git-tag-version` |
| Описание выпуска клиента | `docs/releases/desktop-X.Y.Z.md` (репа Windows) | новый файл по образцу прошлого; его текст становится описанием релиза |

```bash
cd "$CORD_ROOT/.worktrees/<имя>"
code=$(sed -nE 's/.*versionCode ([0-9]+).*/\1/p' mobile/android/app/build.gradle)
sed -i -E "s/versionCode [0-9]+/versionCode $((code + 1))/; s/versionName \"[^\"]*\"/versionName \"X.Y.Z\"/" \
  mobile/android/app/build.gradle
git diff --stat
```

`npm version … --no-git-tag-version` не коммитит и не ставит тег. В `git diff --stat` — по 2 строки в
`package.json` и по 4 в `package-lock.json`; больше — lock переписан (§10). Коммит — по-русски, например
«Версия продукта X.Y.Z — … (Р-46)».

## 2. Ветки и рабочие каталоги

- `/opt/ModernStreamingSystem` — каталог установки стенда: там `.env`, `infra/generated`, `.local`, оттуда
  выкатывает `deploy.sh`. Он стоит на `main`, код в нём не правят.
- Работа — в своём worktree:

```bash
git -C /opt/ModernStreamingSystem fetch origin
git -C /opt/ModernStreamingSystem worktree add /opt/.worktrees/<имя> -b <ветка> origin/main
git -C /opt/ModernStreamingSystem.Windows fetch origin
git -C /opt/ModernStreamingSystem.Windows worktree add /opt/.worktrees/<имя>-win -b <ветка> origin/main
```

- Параллельно работает другая сессия, в том числе в общем каталоге. Перед слиянием — `git fetch` и
  `git rebase origin/main`; чужое не стирать, `reset --hard` и force-push — никогда (`backlog/PROTOCOL.md` §0).
- В worktree нет `.env`, поэтому `docker compose` там падает на интерполяции (`DATABASE_PASSWORD … missing`).
  Образы для проверок собираются `docker build` под своим тегом — не `modern-streaming-*`, которыми живёт стенд.

## 3. Проверки перед слиянием

Машина медленная (4 vCPU, steal до 60 %): `tsc -b` ~10 мин, `verify` ядра ~35 мин. Во время работы — точечные
проверки тронутого, полный прогон — CI ветки.

**Веб** (`web/`):

```bash
cd /opt/.worktrees/<имя>/web
npm ci                                       # один раз в новом worktree
npx tsc -b
npx vitest run src/<путь>/<файл>.test.ts     # тронутые тесты
npx prettier --check <тронутые файлы>        # CI гоняет npm run format:check по всему web/
node scripts/i18n/check.mjs                  # строк с кириллицей в коде не прибавилось
node scripts/i18n/sync-errors.mjs --check    # тексты ошибок каталога = реестр ядра
node scripts/i18n/coverage.mjs               # у каждого языка есть каждый ключ ru
```

`tsc` не заменяет prettier, prettier не заменяет `tsc`. Новые тексты — через каталог переводов (скилл
`cord-i18n`).

**Ядро** (`server/`). JDK на машине нет — Maven в контейнере (скилл `cord-server-tests`):

```bash
cd /opt/.worktrees/<имя>
docker run --rm -v cord-m2:/root/.m2 -v "$PWD":/w -w /w maven:3.9.11-eclipse-temurin-25 \
  mvn -B -q -pl server com.spotify.fmt:fmt-maven-plugin:format        # формат — до коммита
docker run --rm -v cord-m2:/root/.m2 -v "$PWD":/w -w /w maven:3.9.11-eclipse-temurin-25 \
  mvn -B -pl server test -Dtest='RoomServiceTest,PermissionsTest'     # тронутые классы
python3 scripts/errors_registry.py --check                            # contracts/errors.json = ядро
```

Как в CI (`fmt:check verify`), если тронуто много:

```bash
docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock -e TESTCONTAINERS_RYUK_DISABLED=true \
  -v cord-m2:/root/.m2 -v "$PWD":/w -w /w maven:3.9.11-eclipse-temurin-25 mvn -B -pl server fmt:check verify
```

Новая миграция — следующий `V<n>__*.sql` в `server/src/main/resources/db/migration`, на Postgres и H2;
применённые не переписываются. Flyway применяет её сам при старте ядра.

**Службы** (`services/`) — образ под своим тегом:

```bash
docker build -f services/Dockerfile -t cord-services-test:<ветка> .
docker run --rm --network none --entrypoint python -v "$PWD/services/tests:/tests:ro" \
  -e PYTHONPATH=/app:/tests cord-services-test:<ветка> -m unittest discover -s /tests
docker run --rm -v "$PWD/services":/s -w /s ghcr.io/astral-sh/ruff:0.13.2 \
  check cord_services/cinema sniffer tests/test_cinema*.py --line-length 110 --extend-select E501
docker run --rm -v "$PWD/services/publisher":/src -w /src -e GOFLAGS=-mod=mod golang:1.26-bookworm \
  sh -c "gofmt -l . && go vet ./... && go test ./..."
```

Тесты здесь идут без сети, а в CI — с сетью: новый тест не должен звать настоящие адреса.

**Генераторы** (`scripts/*.mjs`): `node --test scripts/configure.test.mjs scripts/edge-config.test.mjs
scripts/turn-guard.test.mjs`.

**Контракты** — после любой правки API (контроллеры, `Contracts`, `OpenApiConfig`). Только скриптом,
сгенерированное руками не правится:

```bash
cd /opt/.worktrees/<имя>                     # web/node_modules нужен: генератор — npm run generate:api
backlog/bin/gen-contracts.sh                 # соберёт ядро под тегом cord-core-gen:<коммит> и снимет схему
git diff --stat -- contracts/openapi.json web/src/api/generated.ts
```

Скрипт поднимает одноразовые Postgres, Redis и ядро на портах 15432, 16379, 18089 и убирает их; стенд не
задевается. Без `CORD_GEN_IMAGE` он собирает `modern-streaming-core` через compose — в worktree это не
работает, а в каталоге стенда подменило бы образ стенда. CI перегенерирует контракты и падает на любой
разнице с закоммиченными. После слияния двух веток — перегенерировать на сводном дереве.

**Клиент Windows** (`desktop/` репы Windows): `npm ci`, `npm run typecheck`, `npm test` — можно здесь. Нативный
модуль (Rust), установщик и дымовой прогон — только CI на `windows-2022`.

**Зависимости npm.** После `npm install <пакет>` — `git diff --stat` lock-файла: удалённых записей
`node_modules/...` быть не должно. Проверка, как в образе шлюза:

```bash
cd web
docker run --rm -v "$PWD/package.json:/w/package.json:ro" -v "$PWD/package-lock.json:/w/package-lock.json:ro" \
  -w /w node:24.11.1-alpine3.22 npm ci --dry-run --ignore-scripts --no-audit --no-fund
```

## 4. Слияние в main

```bash
cd /opt/.worktrees/<имя>
git fetch origin
git rebase origin/main
git push -u origin <ветка>
backlog/bin/ci-status.sh <ветка> 3           # обе репы; код 1 — последний прогон не зелёный
git push origin HEAD:main                    # только fast-forward
```

- CI ядра (`verify.yml`) идёт на каждый пуш, кроме коммитов только в `backlog/`; ~17–25 мин. Задания: ядро
  (`fmt:check verify`), веб и e2e с контрактами на Windows, конфигурация и образы.
- `desktop.yml` (репа Windows) и `android.yml` идут, только если тронуты `desktop/**` или `mobile/**`.
- Следить: `gh run list -R MikkiMays/ModernStreamingSystem --branch <ветка> --limit 5`, затем
  `gh run watch <id> -R MikkiMays/ModernStreamingSystem`. Красный — чинить, а не сливать.
- На Windows-раннере изредка не встаёт SFU: падают разом все медийные спеки на ожидании «В эфире». Это не код —
  `gh run rerun <id> --failed -R MikkiMays/ModernStreamingSystem`.
- Отказ `push HEAD:main` — `main` ушёл вперёд: `git fetch`, `git rebase origin/main`, снова CI.

## 5. Выкатка на стенд callcord.ru

Стенд — эта машина: `callcord.ru`, 108.165.32.75, каталог `/opt/ModernStreamingSystem`. Режим `strict` с
01.11.2026: `callcord.ru`, `rtc.callcord.ru`, `turn.callcord.ru` (TURN/TLS на 443, Р-50, Р-52). Профиль
`monitoring` в `.env` включён, но его службы остановлены с 31.10.2026 — без нужды не поднимать.

### Какая служба что везёт

| Изменено | Что выкатить |
| --- | --- |
| `web/**`, `infra/Dockerfile.web`, `infra/Caddyfile` | `gateway` (веб собирается внутрь него) |
| `server/**`, `pom.xml`, `infra/Dockerfile.server` | `core` (права, проверки, правила игр, миграции) |
| `services/**` | `services`; `services/sniffer/**` — и `sniffer` |
| протокол ядро ↔ службы (`/internal/*`, ключи из `INTERNAL_SECRET`) | `core services` одной командой |
| `scripts/configure.mjs`, `scripts/edge-config.mjs`, `scripts/turn-guard.mjs`, `STREAM_MAX_PARTICIPANTS` | перевыпуск конфигурации SFU (ниже) |
| `compose.yaml` | службы, у которых поменялась конфигурация: `docker compose up -d --no-deps <служба>`; `edge`, `livekit`, `postgres`, `redis`, `tusd` — только без встреч |
| `infra/sniffer-firewall.sh`, `infra/cord-sniffer-*` | `sudo bash infra/sniffer-firewall.sh --install` (root, §11) |
| `infra/monitoring/**` | дашборды Grafana перечитывает сама раз в минуту; правила — `docker compose up -d --no-deps --force-recreate vmalert`, если профиль запущен |
| `mobile/**` | на сервере ничего — APK собирает CI (§8) |
| `docs/**`, `backlog/**` | ничего |

«Починил, а не работает» — чаще всего выкатили не ту службу (правило в `core`, а пересобран `gateway`).

### Порядок

```bash
cd /opt/ModernStreamingSystem
git status -sb                  # ## main...origin/main без «ahead» и без своих правок
git pull --ff-only
git log -1 --oneline            # тот коммит, что прошёл CI
backlog/bin/active-meetings.sh  # 0 — встреч нет, 1 — идут (список), 2 — база не ответила
```

`ahead` в `git status` — чьи-то коммиты в каталоге установки, ещё не в `origin/main`: не сбрасывать, сначала выяснить, чьи они.

Метки отката — до сборки (`deploy.sh` их не ставит; имя то же, что у `update.sh`, суточная уборка держит
последний набор):

```bash
TAG=cord-rollback-$(date +%Y%m%d-%H%M%S)
for s in core gateway; do docker tag modern-streaming-$s:latest $TAG-$s:latest; done   # те службы, что выкатываются
echo $TAG
```

Выкатка:

```bash
backlog/bin/deploy.sh core gateway
```

`deploy.sh` сам спрашивает `active-meetings.sh` и при встречах (и при коде 2) откладывает выкатку с кодом 1.
Дальше — блокировка `backlog/.deploy.lock`, сборка с `CORD_BUILD=<HEAD>` (до трёх попыток), подъём по одной
службе (ядро первым), ожидание здоровья до 20 минут, а у `gateway` — сверка `<meta name="cord-build">` в бандле
с HEAD. Сборка ядра и служб идёт до получаса: запускать в фоне, не под `timeout`. Незакоммиченные правки в
каталоге — предупреждение «образ не равен HEAD».

Если идут встречи:

- подождать и повторить;
- `backlog/bin/deploy.sh --drain core gateway` (`--drain` — первым аргументом): рычаг владельца закрывает
  создание новых встреч (`503 MAINTENANCE`), идущие доигрывают; скрипт ждёт до 15 минут (`CORD_DRAIN_WAIT`,
  секунды) и снимает флаг на выходе. Нужен `ADMIN_PASSWORD` в `.env`;
- `CORD_DEPLOY_FORCE=1 backlog/bin/deploy.sh …` — только когда в «встречах» нет людей (например, свои e2e).

**Миграции.** Flyway применяет их при старте ядра. Проверка:

```bash
docker compose exec -T postgres psql -U streaming -d streaming -At \
  -c "SELECT version, success FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 1"
docker compose logs --since 30m core | grep -i flyway
```

**Конфигурация SFU.** `infra/generated/*` в git нет: правка генератора до сервера сама не доезжает. `deploy.sh`
LiveKit не перезапускает — даже названный в списке, он не пересоздаётся, если поменялись только файлы.

```bash
cd /opt/ModernStreamingSystem
BACKUP=infra/generated.before-$(date +%Y%m%d-%H%M%S); cp -a infra/generated "$BACKUP"
node scripts/configure.mjs --refresh --check  # что перевыпуск сделает с .env; ничего не пишет (выход 3 — см. ниже)
node scripts/configure.mjs --refresh          # секреты не трогает; аргументы — из topology.json, адреса .env — по ним
diff <(jq -S 'del(.keys, .redis, .prometheus)' "$BACKUP/livekit.json") \
     <(jq -S 'del(.keys, .redis, .prometheus)' infra/generated/livekit.json)   # без секретов
diff "$BACKUP/edge.json" infra/generated/edge.json
backlog/bin/active-meetings.sh && docker compose restart livekit                 # и edge, если менялся edge.json
```

Перезапуск SFU обрывает идущие звонки, поэтому — только сразу после пустого `active-meetings.sh`.

### После выкатки

```bash
git rev-parse --short HEAD
curl -s https://callcord.ru/ | grep -o 'name="cord-build" content="[^"]*"'    # = HEAD
curl -fsS https://callcord.ru/api/v1/ping
curl -fsS https://callcord.ru/api/v1/load                                      # {"level":1..4,"state":…}
node scripts/smoke.mjs                                                            # PASS: … (через шлюз, по .env)
docker compose ps
```

Трогали SFU, edge или генератор — ещё путь TURN/TLS на 443:

```bash
node scripts/turn-relay-check.mjs --env=.env --signal=ws://127.0.0.1:7880 --turn=turn.callcord.ru:443 --transport=tls
```

Коммит человеку не показывается нигде — только в `<meta name="cord-build">` (решение владельца 29.10.2026).

**e2e против стенда** — из любого checkout того же коммита с `web/node_modules` и браузерами Playwright
(`npx playwright install chromium` один раз):

```bash
cd /opt/.worktrees/<имя>/web
PLAYWRIGHT_BASE_URL=https://callcord.ru npx playwright test e2e/connect.spec.ts e2e/download.spec.ts
PLAYWRIGHT_BASE_URL=https://callcord.ru npx playwright test e2e/<тронутый>.spec.ts
```

- Без `PLAYWRIGHT_BASE_URL` конфиг поднимает пустой dev-сервер без ядра и SFU — падает всё.
- Ядро пускает **10 новых встреч в час с одного адреса** (`ABUSE_IP_ROOMS_CREATED`, окно скользящее; отказ
  предел не тратит). Весь набор `web/e2e` создаёт около 60 встреч — гонять порциями. «Слишком много новых
  встреч за час» в прихожей — предел, а не поломка. Обходить подменой адреса нельзя; поднять предел на время
  прогона — выкатка ядра с переменной, решение владельца или главной сессии.
- `connect.spec.ts` и `download.spec.ts` встреч не создают; спеки со звонком создают по одной и больше.
- Создание встречи решает задачу «не бот»: до подключения — 20–25 с.
- Интерфейс — снимки 390/1440 в обеих темах (скилл `cord-verify-ui`) и ни одного нарушения CSP.

### Окно технических работ (R194)

Когда встречи всё равно придётся оборвать: обновление с миграцией, работы на сервере. Обычной выкатке окно не нужно: она ждёт
конца встреч сама (`deploy.sh --drain`).

```bash
cd /opt/ModernStreamingSystem
# Заранее, например с 4 до 5 утра по Москве:
backlog/bin/maintenance.sh schedule 2026-11-10T04:00:00+03:00 --until 2026-11-10T05:00:00+03:00 --reason "Обновление"
# Срочно: встречи завершатся через минуту (--grace 0 — сразу):
backlog/bin/maintenance.sh now --grace 60 --until 2026-11-10T05:00:00+03:00
backlog/bin/maintenance.sh status                      # что сейчас
backlog/bin/maintenance.sh extend 2026-11-10T05:30:00+03:00   # сдвинуть обещанный конец
backlog/bin/maintenance.sh finish                      # отменить или закончить
```

В начале окна ядро завершает все встречи с причиной `maintenance`, вход и создание закрыты (`503 MAINTENANCE_WINDOW`), люди видят
страницу работ, а когда окно закроется — приложение вернётся само, без перезагрузки. До начала окна ничего не видно: данные о
предстоящем окне клиент получает, но не показывает (владелец: «пока что никак нигде не отображать»).

Окно хранится в Postgres, поэтому переживает перезапуск ядра — ту самую выкатку, ради которой открыто. Забытое закроется само: через
час после обещанного конца и не позже шести часов от начала. Проверка окна: `.claude/skills/cord-live-call` не нужен, хватает
`status` и страницы в браузере.

### Откат

```bash
cd /opt/ModernStreamingSystem
for s in core gateway; do docker tag $TAG-$s:latest modern-streaming-$s:latest; done
backlog/bin/active-meetings.sh && docker compose up -d --no-deps core gateway
```

Затем код: `git revert <коммиты>` в своём worktree → CI → fast-forward в `main` → обычная выкатка, чтобы образы
снова были равны HEAD. Миграции не откатываются: прежнее ядро работает на новой схеме, если миграция только
добавляет (Flyway по умолчанию не падает на «будущих» версиях), а новые поля `RoomState` — с
`@JsonInclude(NON_NULL)`. Прежняя конфигурация SFU — в `infra/generated.before-*`: вернуть каталог и
перезапустить `livekit`.

## 6. Другие серверы

С машины A (стенд и пульт) на машины продукта ходят по ключам (владелец, 08.11.2026): `/root/.ssh/cord_fra` — meet,
`cord_msk` — узел Москва, `cord_fi` — узел Хельсинки. Пароли root в работе не используются.

| Машина | Адрес | Что на ней | Каталог |
| --- | --- | --- | --- |
| meet | 108.165.32.23 | **продукт `cord.online`**: ядро, база, шлюз, службы, служба аналитики, медиаузел `main`; режим `strict` (`cord.online`, `rtc-fra.cord.online`, `turn-fra.cord.online`); на том же 443 — чужой проект (`--legacy-hosts`), его контейнеры не трогать | `/opt/meet/ModernStreamingSystem` |
| msk | 157.22.241.114 | медиаузел `msk` (`msk.cord.online`, `rtc-msk`, `turn-msk`), выход кинозала к ivi | `/opt/cord/node` |
| hel | 152.234.227.199 | медиаузел `hel` (`hel.cord.online`, `rtc-hel`, `turn-hel`), выход кинозала к YouTube | `/opt/cord/node` |
| A | 108.165.32.75 | стенд `callcord.ru`, пульт `admin.callcord.ru`, мониторинг | `/opt/ModernStreamingSystem` |

Что выкачено, видно снаружи с любой машины:

```bash
for h in cord.online callcord.ru; do
  echo "$h $(curl -s https://$h/ | grep -o 'cord-build" content="[^"]*')"
  curl -s https://$h/downloads/windows/download.json | head -c 120; echo
done
```

Продукт обновляется на meet: `ssh -i /root/.ssh/cord_fra root@108.165.32.23`, там `cd /opt/meet/ModernStreamingSystem &&
backlog/bin/active-meetings.sh && ./update.sh --check`, затем `./update.sh --yes` — только без идущих встреч.

Первое обновление сервера на `main` с Р-52 (`7dfae28`, TURN/TLS только в `strict`) перевыпускает конфигурацию
SFU и пересоздаёт `edge` и `livekit` — звонки оборвутся. Строку cron `turn-cert.sh` прежних установок можно
убрать: `crontab -l | grep -v turn-cert.sh | crontab -` (скрипт теперь ничего не делает и выходит с 0).

### Перед обновлением

```bash
ssh root@<сервер>
docker compose ls                       # столбец CONFIG FILES — каталог установки
cd <каталог установки>
git status -sb                          # main, без своих правок
git log -1 --oneline
grep -E '^(DEPLOY_MODE|APP_HOST|RTC_HOST|TURN_HOST|PUBLIC_IP|COMPOSE_PROFILES)=' .env
grep -q '^ADMIN_PASSWORD=.' .env && echo "ADMIN_PASSWORD задан"
cat infra/generated/topology.json
df -h / && docker system df             # свободно меньше 25 ГБ (CORD_DISK_FLOOR_GB) — сначала sudo bash infra/tidy.sh
backlog/bin/active-meetings.sh          # 0 — пусто
./update.sh --check                     # что пересоберётся, тронет ли он SFU и те ли имена в topology.json, что в .env
```

`.env` целиком не печатать: в нём секреты. `topology.json` нет — сервер поставлен до него, и `--refresh`
откажет (deployment.md → «Обновление и остановка»). `topology.json` называет другие имена, режим или адрес, чем
`.env` (`.env` правили руками), — `--check` печатает «ВНИМАНИЕ» и готовую команду, которая выровняет `topology.json`
по `.env`; без неё обновление с перевыпуском конфигурации не начинается: перевыпуск вернул бы прежние имена в `.env`,
`edge.json` и `livekit.json`.

### Обновление

```bash
sudo ./update.sh            # спросит «Обновить? [y/N]»; --yes — без вопроса
```

`update.sh` забирает ветку checkout fast-forward, пересобирает только службы с изменёнными исходниками,
перевыпускает конфигурацию, если менялся генератор, ставит метки `cord-rollback-*` до сборки и сам
откатывается, если ядро не здорово или `PUBLIC_URL` не ответил 200. Встреч он **не проверяет**: если
`--check` пишет «SFU будет перезапущен», звонки оборвутся — запускать только после пустого
`active-meetings.sh`. Без root он откажет, если обновление касается плеера страниц. Подробно — [INSTALL.md →
«Обновление»](INSTALL.md#обновление).

С дренажом (как на стенде), если в `.env` есть `ADMIN_PASSWORD`:

```bash
git pull --ff-only
backlog/bin/deploy.sh --drain core gateway      # службы — по таблице §5
```

`deploy.sh` не ставит меток отката (поставить руками, §5), не перевыпускает конфигурацию SFU (§5) и не трогает
стену плеера страниц и мониторинг — это делает `update.sh`.

### После обновления

```bash
git rev-parse --short HEAD
curl -s https://<домен>/ | grep -o 'name="cord-build" content="[^"]*"'
curl -fsS https://<домен>/api/v1/ping && curl -fsS https://<домен>/api/v1/load
node scripts/smoke.mjs                          # нужен Node 20+ на хосте
node scripts/turn-relay-check.mjs --env=.env --signal=ws://127.0.0.1:7880 \
  --turn="$(sed -n 's/^TURN_HOST=//p' .env):443" --transport=tls   # strict; у продукта это turn-fra.cord.online
python3 scripts/cohost-cutover.py               # только meet: проверка совместного 443 с соседним проектом, без --apply ничего не меняет
```

С этой машины — e2e (`PLAYWRIGHT_BASE_URL=https://<домен>`, тот же предел 10 встреч в час) и внешняя проверка
DNS и TLS трёх имён (имена — `APP_HOST`, `RTC_HOST`, `TURN_HOST` сервера; у продукта — `cord.online`,
`rtc-fra.cord.online`, `turn-fra.cord.online`):

```bash
node scripts/network-audit.mjs --app=<домен> --rtc=rtc.<домен> --turn=turn.<домен> --ip=<IP>
```

### Переход в strict

TURN/TLS — путь звонка из VPN и сетей, где открыт только TCP 443, — есть только в `strict` (Р-50, Р-52):
LiveKit 1.13.6 при любом включённом TURN/TLS объявляет `turns:<turn-имя>:443`, а под одним именем 443 — это
HTTPS. Поэтому `configure.mjs` в `simple` и `ip` TURN/TLS не включает: там TURN по UDP 3478 и ICE/TCP 7881.
Серверу с DNS нужен `strict`. Повторный `setup.sh` работающий сервер не переводит (`.env` он не трогает) —
только этот порядок, проверенный на `callcord.ru` 01.11.2026.

0. Сервер уже обновлён до `main` с Р-52 (выше). DNS: A-записи `rtc.<домен>` и `turn.<домен>` → IP сервера,
   без прокси. До перехода `network-audit.mjs` показывает у `rtc` и `turn` `ECONNRESET` — edge таких имён ещё
   не знает.

```bash
getent ahostsv4 rtc.<домен>; getent ahostsv4 turn.<домен>      # = IP сервера
```

1. Встреч нет, резерв:

```bash
cd <каталог установки>
backlog/bin/active-meetings.sh
D=$(date +%Y%m%d)
cp -a infra/generated infra/generated.before-$D-strict && cp -p .env .local/env.before-$D-strict
```

2. `.env` руками не править. Секреты и правки владельца `--refresh` не трогает, а адресные ключи
   (`DEPLOY_MODE`, `APP_HOST`, `RTC_HOST`, `TURN_HOST`, `PUBLIC_IP`, `PUBLIC_URL`, `LIVEKIT_URL`, порты шлюза)
   с R200 §8.6 переписывает сам по именам из аргументов и печатает, что поменял (`.env retargeted: …`). До
   этого `LIVEKIT_URL` и `PUBLIC_URL` оставались старыми, и ядро со службой интеграций отказывали по Origin
   (meet при смене имени 08.11.2026; 12.11.2026 переезд на `cord.online` прошёл уже этим путём).

3. Конфигурация:

```bash
node scripts/configure.mjs --refresh --app=<домен> --rtc=rtc.<домен> --turn=turn.<домен> --ip=<IP>
grep -E '^(DEPLOY_MODE|APP_HOST|RTC_HOST|TURN_HOST|PUBLIC_URL|LIVEKIT_URL)=' .env
```

Печатает `Mode: strict`. Нет Node на хосте — тем же образом, что `update.sh`:
`docker run --rm -v "$PWD:/w" -w /w node:22-alpine sh -c 'apk add --no-cache openssl >/dev/null && node scripts/configure.mjs --refresh --app=… --rtc=… --turn=… --ip=…'`.

4. Подъём. `.env` поменялся, поэтому `up` пересоздаёт всё, что его читает: `core`, `gateway` и `services`
   (служба интеграций сверяет Origin с `PUBLIC_URL` — без пересоздания она отказывает новому имени); `edge` и
   `livekit` читают новые файлы только при старте:

```bash
docker compose up -d edge gateway core services livekit && docker compose restart edge livekit
```

5. Сертификаты трёх имён (ACME выдаёт их за секунды):

```bash
for n in <домен> rtc.<домен> turn.<домен>; do
  echo | openssl s_client -connect <IP>:443 -servername $n 2>/dev/null | openssl x509 -noout -subject -issuer
done
```

6. Firewall: 5349 снаружи закрыт в любом режиме (в `strict` edge ходит к нему по loopback). На сервере,
   поставленном до Р-52, есть прежнее `allow 5349/tcp`, а у UFW первое совпавшее правило главнее — поздний
   `deny` (и `scripts/firewall.sh`) ничего не меняет:

```bash
sudo ufw delete allow 5349/tcp; sudo ufw deny 5349/tcp     # delete ругается, если прежнего allow нет, — это не ошибка
sudo ufw status numbered | grep 5349
```

7. Проверка TURN поверх TLS 443 и шлюза (сигналинг — `ws://127.0.0.1:7880` на самом сервере: публичный
   `wss://<домен>/rtc` голый токен LiveKit не принимает):

```bash
node scripts/turn-relay-check.mjs --env=.env --signal=ws://127.0.0.1:7880 --turn=turn.<домен>:443 --transport=tls
node scripts/smoke.mjs
```

`turn-relay-check.mjs` заодно сверяет, что `join` объявляет `turns:turn.<домен>:443`. Снаружи — `network-audit.mjs`
(у всех трёх имён `"verified": true`). Живая проверка — телефон с VPN без UDP (`release-1.1/STATUS.md` →
«Проверка владельцем», п. 3).

Откат перехода: вернуть `infra/generated.before-<дата>-strict` на место `infra/generated`, `.env` из
`.local/env.before-<дата>-strict`, `docker compose up -d edge gateway core services livekit && docker compose restart edge
livekit`, правило `sudo ufw allow 5349/tcp`.

### Новый сервер

Владелец: машина, DNS (три A-записи без прокси), доступ по ssh и к приватной репе. Дальше:

```bash
git clone <адрес репы ModernStreamingSystem> && cd ModernStreamingSystem
sudo ./setup.sh --app <домен> --rtc rtc.<домен> --turn turn.<домен>       # + --monitoring, --ssh-port N
```

У `setup.sh` аргументы через пробел, у `configure.mjs` — через `=`. `sudo ./setup.sh --domain <домен>` сам
выберет `strict`, если `rtc.<домен>` и `turn.<домен>` уже указывают на эту машину; иначе поставит одно имя и
предупредит, что сети «только 443» останутся без медиа. После установки:

- `ADMIN_PASSWORD` в `.env` (страница «Активность» и дренаж) и `docker compose up -d --no-deps --force-recreate core`
  (deployment.md → «Наблюдаемость»);
- каталог серверов — тот же `.local/catalog/servers.jws`, что у остальных (deployment.md → «Несколько серверов —
  один каталог»); новый сервер в каталоге — подпись ключом каталога (§11);
- `/download` — зеркало клиента (§7), если сервер должен его раздавать;
- проверки — как после обновления.

## 7. Клиент Windows

Клиент один — Electron (`desktop/` репы `ModernStreamingSystem.Windows`). Выпуск — `desktop-vX.Y.Z` с файлами
`Cord-Setup-X.Y.Z.exe`, `.exe.sha256`, `.exe.blockmap`, `.exe.blockmap.sha256`, `latest.yml`, `latest.yml.sig`.

### Подготовка

В своём worktree репы Windows: правки, номер (`cd desktop && npm version X.Y.Z --no-git-tag-version`),
`docs/releases/desktop-X.Y.Z.md` — **одним коммитом с правкой в `desktop/`**: коммит только с описанием CI не
запускает. Проверки — §3, CI ветки — §4.

### Выпуск

Пуш в `main` репы Windows запускает `desktop.yml`:

- запускается на пуш и PR, если тронуты `desktop/**` или `.github/workflows/desktop.yml`;
- задание `desktop` (windows-2022, ~9 мин): нативный модуль, `typecheck`, тесты, сборка, дымовой прогон против
  `CORD_DEFAULT_SERVER` (переменная репы, сейчас `https://callcord.ru/`), установщик NSIS, подпись
  `latest.yml` ключом `CORD_UPDATE_SIGN_KEY`, проверка установщика с обновлением поверх прошлого выпуска
  `desktop-v*`;
- задание `release` — только на пуш в `main` или `deploy/*`: тег `desktop-v<версия из desktop/package.json>`.
  Такой релиз уже есть — «already exists; preserving its artifacts», прогон зелёный, нового ничего: без нового
  номера выпуска нет. Черновик от прерванного прогона удаляется и создаётся заново;
- `concurrency: desktop-<ветка>`, на `main` без отмены: второй пуш ждёт конца первого, третий вытесняет
  ждущий второй. Выпуск — одним пушем, следующий пуш в `main` репы Windows — после релиза.

```bash
gh run list -R MikkiMays/ModernStreamingSystem.Windows --workflow desktop.yml --branch main --limit 3
gh run watch <id> -R MikkiMays/ModernStreamingSystem.Windows
gh release view desktop-vX.Y.Z -R MikkiMays/ModernStreamingSystem.Windows --json isDraft,assets -q '.isDraft, .assets[].name'
```

Нет `latest.yml.sig` — нет секрета `CORD_UPDATE_SIGN_KEY` (§11): такое обновление клиенты не примут.

**Снимок каталога серверов** (`dist/shell/catalog.jws` в установщике) сборка берёт с `cord.online/api/v1/catalog`, а
если CI до продукта не достучался — из `desktop/build/catalog.jws` репы Windows (из двух — с бо́льшим `seq`). Сборка
продукта в CI без снимка падает: без него клиент, обновлённый с прошлой сборки, верит её сохранённому каталогу и
открывает её сервер (1.2.3 так открывал убранное имя стенда — «нет связи»). Подписали новый `seq` каталога
продукта — тот же `servers.jws` кладётся в `desktop/build/catalog.jws` и в `.local/catalog/` стенда.

### Зеркало

GitHub клиент не видит: и `/download`, и обновление при запуске читают только зеркало сервера
(`/downloads/windows/download.json` и канал `/downloads/windows/desktop/`). Клиент основной сборки обновляется с
`CORD_DEFAULT_SERVER` — с 1.4.0 это продукт `cord.online` (meet); выпуск кладётся **на meet** — для всех клиентов.
Зеркало стенда `callcord.ru` (A) — только для разработки и дымового прогона. Клиенты 1.3.1 и старше смотрели на
прежние имена, которых больше нет (владелец, 12.11.2026: «оставляй только cord.online»), — их переустанавливают
установщиком с `https://cord.online/download`. Пока выпуск не выложен, его не видит никто.

```bash
cd /opt/ModernStreamingSystem
backlog/bin/publish-windows.sh --desktop X.Y.Z
curl -s https://callcord.ru/downloads/windows/download.json            # "version": "X.Y.Z", "path": "desktop/"
curl -s https://callcord.ru/downloads/windows/desktop/latest.yml | head -3
```

Скрипт берёт релиз через `gh`, а `scripts/publish-windows-release.py --desktop` сверяет размеры и дайджесты с
GitHub, версию и имя в `latest.yml`, вид подписи; отказывается понижать версию и брать черновик или
предварительный выпуск; пишет `latest.yml` последним и `download.json`; держит прошлый установщик для дельт
(`--keep 2`). Шлюз читает `.local/windows-releases` только на чтение — перезапуск не нужен.

На meet (`/opt/meet/ModernStreamingSystem`, продукт `cord.online`) `gh` нет — файлы приносятся с A:

```bash
# на машине с gh
gh api repos/MikkiMays/ModernStreamingSystem.Windows/releases/tags/desktop-vX.Y.Z > release.json
gh release download desktop-vX.Y.Z -R MikkiMays/ModernStreamingSystem.Windows -D artifacts \
  -p 'Cord-Setup-X.Y.Z.exe*' -p 'latest.yml*'
ssh -i /root/.ssh/cord_fra root@108.165.32.23 mkdir -p /tmp/cord-desktop-X.Y.Z
scp -i /root/.ssh/cord_fra -r release.json artifacts root@108.165.32.23:/tmp/cord-desktop-X.Y.Z/
# на meet, из /opt/meet/ModernStreamingSystem
python3 -I scripts/publish-windows-release.py --desktop /tmp/cord-desktop-X.Y.Z/release.json /tmp/cord-desktop-X.Y.Z/artifacts
```

Проверка — `curl -s https://cord.online/downloads/windows/desktop/latest.yml | head -3`.

Отдельных сборок под другие серверы нет: сборка `deploy/cordcam` (свой сервер и свой ключ) выведена с 1.2.3, её
манифест `installations/cordcam.json` удалён в 1.4.0. CI на `main` падает, если в репе есть
`desktop/build/installation`.

## 8. Android

- `.github/workflows/android.yml` — на пуш и PR, если тронуты `mobile/**` или сам workflow; вручную —
  `gh workflow run android.yml -R MikkiMays/ModernStreamingSystem --ref main`.
- Собирает отладочный APK (`assembleDebug`, отладочный ключ) с адресом продукта `https://cord.online` из
  `mobile/capacitor.config.json` (R200, Р-110); `mobile/scripts/set-server.mjs` без переменной только сверяет файлы.
  Стенд `callcord.ru` в APK не попадает: переменная `CORD_SERVER_URL` — только для `verify-deployed.yml`.
- Результат — артефакт `cord-android-debug` (`app-debug.apk`), живёт 14 дней. На сервер и в магазины не
  выкладывается.

```bash
gh run list -R MikkiMays/ModernStreamingSystem --workflow android.yml --limit 3
gh run download <id> -R MikkiMays/ModernStreamingSystem -n cord-android-debug -D /tmp/cord-apk-X.Y.Z
```

- Номер — `versionName` и `versionCode` (§1); правка в `mobile/` и запускает сборку.
- Правка веба нового APK не требует: оболочка грузит страницу с сервера.
- APK для другого сервера — сборка руками с `CORD_ANDROID_SERVER=https://<сервер> node scripts/set-server.mjs`
  ([mobile.md](mobile.md) §8; нужны Android SDK и JDK 21, на этой машине их нет) или та же переменная репы
  (владелец).

## 9. Учёт в конце выпуска

- Журнал — `backlog/journal/<дата>-<слово>.md` (образец — `2026-10-31-release-1.1.md`): коммиты и службы каждой
  выкатки, проверки с итогом, номер клиента, зеркала, «Найдено и исправлено», «Ждёт».
- Статус волны — `backlog/<волна>/STATUS.md`: каждая задача — `выкачено (дата, коммит, службы)` / `выпущено
  (клиент X.Y.Z)` / `ждёт владельца: …`, с доказательством.
- `backlog/README.md` — строка волны в «Волны»; таблица «Стенды», если что-то у серверов поменялось.
- Решения — `backlog/DECISIONS.md`; то, что может только владелец, — `backlog/OWNER-ACTIONS.md`; новая
  ловушка — заметка в `backlog/knowledge/memory/` и строка в `backlog/knowledge/README.md`.
- Документы — `docs/` по тронутым частям.
- Новые метрики — панели в `infra/monitoring/grafana/dashboards.mjs`, затем `node
  infra/monitoring/grafana/dashboards.mjs` и коммит `infra/monitoring/grafana/dashboards/*.json` вместе с ним.
- Коммит только в `backlog/` CI не запускает и выкатки не требует; пуш — тем же fast-forward в `main`.

## 10. Ловушки

- **Не тот каталог.** Всё, что зовёт `docker compose` (`deploy.sh`, тесты служб через compose), в worktree падает — там нет `.env`; а в каталоге стенда `docker compose build` из
  ветки подменил бы образ, которым живёт стенд. Выкатка — только из `/opt/ModernStreamingSystem` и только `main`.
- **Голый `docker compose up -d` на стенде** поднимет и профиль `monitoring` (он в `COMPOSE_PROFILES`) и
  пересоздаст всё, у чего поменялась конфигурация. Только `deploy.sh` или `up -d --no-deps <служба>`.
- **LiveKit после `--refresh`** сам не перезапускается — ни `deploy.sh`, ни `up -d`; нужен
  `docker compose restart livekit`.
- **`update.sh` встреч не проверяет** — сначала `active-meetings.sh`.
- **`update.sh` перевыпускает конфигурацию** только по правке `scripts/configure.mjs` и `scripts/edge-config.mjs`;
  правка одного `scripts/turn-guard.mjs` (правила relay) до сервера сама не дойдёт — `--refresh` руками.
- **`--refresh` не трогает секреты и правки владельца в `.env`**, но адресные ключи (`DEPLOY_MODE`, `APP_HOST`,
  `RTC_HOST`, `TURN_HOST`, `PUBLIC_URL`, `LIVEKIT_URL`, порты) с R200 переписывает по именам из аргументов и
  `topology.json`; повторный `setup.sh` при живом `.env` ничего не меняет: смена режима или имён — `--refresh` с
  именами (§6 «Переход в strict»), `.env` руками не править.
- **TURN/TLS только в `strict`.** Сервер с одним именем звонок из VPN «только 443» не пропустит, что бы ни
  показывал HTTPS.
- **UFW: первое совпавшее правило главнее.** Поздний `deny` после прежнего `allow` не действует — сначала
  `ufw delete allow …`.
- **`fmt:check`.** `mvn verify` его не включает, CI — включает; google-java-format валит новые файлы почти
  всегда — форматировать до коммита. Непонятная ошибка компиляции у `Contracts` — `-Dmaven.compiler.fork=true`.
- **Lock-файл npm.** `npm install` на этой машине выкидывает вложенные `@emnapi/*` у wasm-сборок, а `npm ci` в
  образе шлюза и в CI падает. Проверка — `npm ci --dry-run` в контейнере (§3); починка — прежний lock плюс только
  новые записи.
- **Контракты.** Только `gen-contracts.sh`; генератор однажды склеил новую схему с существующей одноимённой —
  смотреть дифф `openapi.json`, а не только «прошло».
- **CI строже местного:** ruff кинозала — `--line-length 110 --extend-select E501`; права каталогов в Dockerfile —
  `RUN chmod -R`, а не `COPY --chmod=…X` (BuildKit раннера ставит иначе); тесты служб в CI ходят в сеть.
- **`ci-status.sh`** судит по самому свежему прогону репы, какой бы workflow это ни был, — смотреть строку
  нужного.
- **Выпуск клиента без нового номера** — зелёный прогон и ни одного нового файла. Коммит только с описанием
  выпуска CI не запускает.
- **Зеркало само не обновляется**: без `publish-windows.sh --desktop` новую версию не видят ни `/download`, ни
  клиенты.
- **e2e против стенда** — 10 новых встреч в час с адреса; `verify-deployed.yml` гоняет весь набор (~60 встреч)
  и упрётся в тот же предел.
- **Dev-сервер не показывает нарушений CSP сборки** (шрифты доски шли с `esm.sh` только в бандле): проверять на
  стенде.
- **Ничего не стирается**: `docker compose down -v`, переписанная миграция, `reset --hard` чужого — никогда.

## 11. Что делает только владелец

Агенту среда не даёт писать в `/etc` и cron, вводить токены и платить; такие шаги — в
`backlog/OWNER-ACTIONS.md`.

- **DNS.** A-записи без прокси: три имени на сервер (`<домен>`, `rtc.<домен>`, `turn.<домен>`); AAAA — только
  после проверки IPv6.
- **Доступ.** ssh к другим серверам (ключа этой машины там нет); доступ сервера к приватной репе для
  `git fetch` и `gh auth login` там, где сервер сам качает релизы; смена токена GitHub.
- **Подпись установщика** — сертификат OV/EV или Azure Trusted Signing, секреты репы Windows
  `CORD_SIGN_PFX_BASE64` и `CORD_SIGN_PASSWORD`. Без него — SmartScreen.
- **Ключ подписи обновлений** — секрет `CORD_UPDATE_SIGN_KEY` (задан); смена — новый открытый ключ в
  `desktop/build/update-keys.json`, выпуск клиента, затем новый секрет.
- **Переменные реп:** `CORD_SMOKE_SERVER` (Windows — стенд для дымового прогона CI; пока его нет, берётся
  `CORD_DEFAULT_SERVER`) и `CORD_UPDATE_CHANNEL` (Windows), `CORD_SERVER_URL` (ядро: `verify-deployed.yml`),
  `CORD_ANDROID_SERVER` (ядро: APK другой установки). Адрес продукта `https://cord.online` — в коде обоих клиентов
  (`desktop/build/update-keys.json`, `mobile/capacitor.config.json`), не в переменных (R200, Р-110).
- **Ключ каталога серверов** — `node scripts/sign-catalog.mjs keygen --out <путь>.pem`, открытый ключ в
  `contracts/catalog-keys.json` и `desktop/build/catalog-keys.json`, выпуск клиента, затем `sign`.
- **Команды root на хосте** (если среда агента их не пускает; в сессии Claude Code — с префиксом `! `):

```bash
sudo ufw delete allow 5349/tcp; sudo ufw deny 5349/tcp           # сервер, поставленный до Р-52
sudo bash infra/sniffer-firewall.sh --install                      # стена плеера страниц
sudo ./update.sh                                                   # другие серверы
crontab -l | grep -v turn-cert.sh | crontab -                      # прежняя строка cron, теперь пустая
```

  Команды хоста стенда, которые ждут владельца сейчас (метрика замираний и т. п.), — `backlog/OWNER-ACTIONS.md`.

- **Пределы и продукт:** поднять `ABUSE_IP_ROOMS_CREATED` на время прогона, Telegram (`ALERT_TELEGRAM_CHAT_ID`,
  BotFather для Mini App), магазины приложений, живые проверки на железе (`release-1.1/STATUS.md` → «Проверка
  владельцем»).
