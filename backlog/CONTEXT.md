# Контекст Cord — общая справка для всех промптов

Снимок на 18.10.2026. Это **кэш**: окружение (код, манифесты, `docs/`) главнее. Если
написанное здесь разошлось с кодом — верь коду и поправь этот файл (E00 делает это первым).

## Что это

**Cord** — продукт для видеовстреч с интеграциями (кинозал, музыка, игры, Telegram-бот).
**Не open-source** (решение владельца 18.10.2026): репозитории приватные, наружу не ведёт ни
одна ссылка на исходники, `setup.sh`/`update.sh` — внутренний способ развёртывания. Комментарии
в коде вида «репозитории публичные» устарели (T56). Прод — https://meet.nikg.tech; на первом
сервере (`/opt/meet`) он работает на той же машине, рядом с другими проектами владельца (Kiki
в `/opt/kiki`, Klodi, Rythm) — **их не трогать**.

Два независимых git-репозитория (GitHub `MikkiMays`, приватные), рядом в `$CORD_ROOT`:

| Репозиторий | Что внутри | Стек |
| --- | --- | --- |
| `ModernStreamingSystem` | ядро `server/`, веб `web/`, службы `services/`, контракты `contracts/`, инфраструктура `infra/`, `docs/` | Java 25 / Spring Boot 4.1, React 19.2 / TS / Vite 8 / Base UI / Tailwind 4, Python (FastAPI) + Go-издатель звука, LiveKit SFU 1.13.6, PostgreSQL 18, Redis 8, tusd, Caddy |
| `ModernStreamingSystem.Windows` | клиент Windows | C# / .NET 10 / WinUI 3 / WebView2, установщик Inno Setup |

Точные версии — только из манифестов (`pom.xml`, `web/package.json`, `services/requirements.lock`,
`*.csproj`, `global.json`). На первом сервере `/opt/meet/.worktrees/room-polish` — старый
worktree Codex, позади `main`.

## Окружение (первый запуск на машине)

Бэклог едет вместе с репозиторием, а машина может быть другой. Перед первым эпиком на новой
машине выясни и запиши в `journal/ENV-<hostname>.md`:

1. `$CORD_ROOT` — каталог, где рядом лежат обе репы; если репы Windows рядом нет —
   `git clone` её туда же. Обе на `main`, синхронны с `origin`.
2. Инструменты: `docker` (+ compose), Node из `web/package.json` → `engines`/CI, `tmux`,
   `git`, доступ к GitHub (`gh auth status` или токен в окружении; на первом сервере `gh` нет,
   токен — `GITHUB_KEY` в `/opt/kiki/infra/.env`, наружу не уходит). Плагины Claude из
   `README.md` → «Что подключить».
3. **Где прод.** Прод здесь, если `docker compose ps` в `ModernStreamingSystem` показывает
   `gateway`/`core`/`services`/`livekit` и `https://meet.nikg.tech` отдаёт сборку с коммитом
   этой машины («О программе»). Иначе — `CORD_DEPLOY_SSH` (ssh до прод-машины, там те же
   команды из «Как выкатывать»). Нет ни того, ни другого — прод недоступен: пушь `main`,
   проверяй на локальном стенде, выкатку пиши в `OWNER-ACTIONS.md`.
4. Память: `backlog/knowledge/memory/` (в git) главнее, локальная память сессии — дополнение.
   Заметки ссылаются на `/opt/meet/...` — это пути первого сервера, читай как `$CORD_ROOT`.

## Обязательное чтение (по мере надобности эпика)

- Репозиторий: `README.md`, `docs/architecture.md`, `docs/frontend.md`, `docs/INTEGRATIONS.md`,
  `docs/resilience.md`, `docs/capacity.md`, `docs/deployment.md`, `docs/INSTALL.md`,
  `docs/verification.md`, `docs/superpowers/specs/*` и `plans/*` (прошлые проектирования).
- Windows: `README.md`, `docs/architecture.md`, `docs/installer.md`, `docs/updating.md`.
- **Память прошлых сессий**: `backlog/knowledge/memory/` (индекс — `knowledge/README.md`):
  `cord-*.md`, `meet-cord-system.md`, `windows-client-checks-on-linux.md`,
  `livekit-*.md`, `codex-handoff-review.md`, `handoff-checkmarks-lie.md`, `vm-host-stalls.md`.
  Там лежат грабли, на которых уже теряли часы, — каждый эпик называет свои. На первом сервере
  они же лежат в `/root/.claude/projects/-opt/memory/`.
- Скиллы Codex по Cord (как справка, они написаны под Codex): `backlog/knowledge/codex-skills/`
  (`cord-web-client`, `cord-media-reliability`, `cord-contracts`, `cord-verification`,
  `cord-deployment-review`, `cord-file-lifecycle`, `cord-spring-data`, `cord-windows-bridge`).
  E00 переносит нужное из них в скиллы Claude в `.claude/skills/`.
  Скилл проверки вживую для Claude: `ModernStreamingSystem/web/.claude/skills/verify/SKILL.md`.

## Карта кода (куда смотреть)

- `web/src/core/` — встреча вне React: `meeting.ts`, `control.ts` (WS), `session.ts`,
  `preferences.ts`, `sounds.ts` (звуки входа/выхода), `hotkeys.ts`, `favorites.ts`,
  `watch.ts`, игры `poker.ts`/`durak.ts`/`chess.ts`/`gartic.ts`, `cinema/`.
- `web/src/media/` — LiveKit: `session.ts` (MediaSession), `profiles.ts` (уровни качества),
  `auto-quality.ts` (лестница «Авто»), `upstream.ts` (общий бюджет отдачи), `retune.ts`,
  `cameras.ts`, `capture.ts`, `playout*.ts`, `live-health.ts`.
- `web/src/ui/` — экраны: `MeetingView.tsx` (шапка встречи, пульт `.call-footer`, бейдж
  «В эфире»), `Stage.tsx`, `Sidebar.tsx` (чат, «до 100 МиБ»), `Settings.tsx` (вкладки сверху,
  `AppearanceFields`), `settings/AccountsTab.tsx`, `CameraMenu.tsx` (стрелка `ChevronDown`),
  `Services.tsx` (витрина интеграций, `canUse`), `GamesGroup.tsx`, `GamePeople.tsx` (лица в
  играх), `PokerTable.tsx`, `DurakTable.tsx`/`DurakMotion.tsx`, `cinema/`, `Home.tsx`,
  `DesktopHome.tsx`, `Connect.tsx`, `primitives.tsx`.
- Стили: `web/src/styles.css` (3,5 тыс. строк) + `room-layout.css`, `room-polish.css`,
  `game-polish.css`, по файлу на игру, `ui/cinema/*.css`.
- Ядро `server/src/main/java/dev/mikki/stream/`: `room/` (`RoomService`, `RoomState`,
  `Lifecycle`, `Contracts`, `GameClock`/`GameTicker`), `game/` (чистая Java: `Table` покер,
  `Durak`, `Chess`, `Gartic`), `api/` (контроллеры, `RequestGuard`), `access/` (`RateLimits`),
  `media/` (LiveKit), `attachment/` (tus), `config/` (`StreamProperties`, `OpenApiConfig`).
  Настройки — `server/src/main/resources/application.yml` (`max-participants: 10`,
  `max-rooms: 5`, сроки хранения словами).
- Службы `services/cord_services/`: `app.py` (маршруты; права через `core.member(...,
  owner=True | integration=True)`), `music.py`, `yandex.py`, `telegram.py` (20 команд,
  `/bind` по коду), `cinema/` (реестр площадок, прокси HLS, «По ссылке», `sniffer.py`),
  `publisher/` (Go, стерео-издатель), `services/sniffer` (контейнер headless Chromium).
- Windows: `src/Cord.Windows/MainWindow.xaml` (шапка: `PaneToggle` + `TextBlock Text="cord"`),
  `Services/WebWorkspace.cs` (WebView2), `Services/GlobalMicrophoneHotkey.cs`,
  `src/Cord.Core/ServerList.cs` (список серверов, до 20), `BridgeProtocol.cs`,
  `installer/Cord.iss` (`desktopicon` с `Flags: unchecked`).

## Как проверять

- Веб: из `web/` — `npm test`, `npx tsc -b`, `npm run format:check`, `npm run build`.
  `tsc` не заменяет prettier, prettier не заменяет `tsc`.
- Ядро: JDK на хосте **нет**. `docker run --rm -v cord-m2:/root/.m2 -v
  "$CORD_ROOT/ModernStreamingSystem":/w -w /w maven:3.9.11-eclipse-temurin-25 mvn -B -pl server
  fmt:check verify` (CI требует `fmt:check`; формат — `com.spotify.fmt:fmt-maven-plugin:format`).
  Непонятная ошибка компиляции у `Contracts` — добавить `-Dmaven.compiler.fork=true`.
- Службы: тесты в контейнере; локально с `--network none`, а CI ходит в сеть — тест, который
  зовёт настоящий адрес, локально зелёный по ошибке (см. память `cord-ci-and-release-traps`).
- Контракты: `npm run generate:api` против ядра со springdoc (память `cord-openapi-regeneration`).
  Новый тип команды — в `Contracts.COMMAND_TYPES` (один список).
- Живая проверка: Playwright из `web/` против прода
  (`PLAYWRIGHT_BASE_URL=https://meet.nikg.tech npx playwright test ...`); без переменной
  конфиг поднимает пустой dev-сервер и «всё падает». Стенд со своим SFU рядом с продом —
  `web/.local/stack.sh up [--services] | status | down` (порты 7883–7885, 8099, 18101, 5199;
  двум агентам одновременно на нём нельзя). Подробно — память `cord-local-stack-with-sfu`,
  `cord-ui-checks-on-prod`, `cord-e2e-against-production`, `cord-web-on-phone`.
- Windows на Linux собирается частично: `Cord.Core` и тесты — да, XAML — нет (память
  `windows-client-checks-on-linux`); всё остальное проверяет Windows-CI.
- Скриншоты вёрстки: 320/390/768/1024/1280/1440/1920 (+2560×1440 для столов), обе темы,
  `scrollWidth - clientWidth` на переполнение. Готовые скрипты — `web/.local/*.mjs`.

## Как выкатывать

Разрешение владельца постоянное и полное (`DECISIONS.md`; на первом сервере ещё
`/opt/meet/AGENTS.md`, копия — `knowledge/AGENTS-workspace.md`):
в конце каждой порции изменений кода — `main` обеих реп локально и на GitHub, выкатка на прод,
релиз Windows, если менялся его код, и проверка здоровья.

- `cd "$CORD_ROOT/ModernStreamingSystem" && docker compose build <служба> && docker compose up -d
  --no-deps <служба>`. Веб собирается **внутрь `gateway`**; проверки и правила — `core`; кинозал,
  музыка, Telegram — `services`. Сборка `services` долгая — в фоне.
- Перед сборкой — **нет ли идущих встреч**: сборка на 6 vCPU душит SFU (в журнале были
  задержки 32–48 с). Нет способа проверить — сделай его в E00 (`backlog/bin/`).
- Одна выкатка за раз: `flock "$CORD_ROOT/ModernStreamingSystem/backlog/.deploy.lock" <команды>`.
- Windows: пуш в `main` запускает CI, который **выкладывает релиз**; второй пуш подряд убивает
  выкладку (память `cord-ci-and-release-traps`). После релиза зеркало `/download` обновляется
  руками: `scripts/publish-windows-release.py`.
- После выкатки: `docker compose ps` против HEAD, «О программе» печатает коммит, e2e против прода.
- CI и релизы — `gh` или GitHub REST с токеном (см. «Окружение»). Репозитории приватные:
  анонимный API отвечает 404, это не «релиза нет».

## Жёсткие границы

- Никогда: `docker compose down -v`, force-push, `reset --hard` чужой работы, переписывание
  применённой миграции Flyway, удаление пользовательских данных, ослабление стены sniffer
  (`infra/sniffer-firewall.sh`) или CSP. Kiki-порты 8090/8091 доверяют docker-подсетям —
  недоверенное в общих сетях docker не держать.
- Новое поле в `RoomState` — `@JsonInclude(NON_NULL)`; `RoomState` уже читается с
  `ignoreUnknown`, иначе откат образа ядра ломает комнаты.
- Правила игр — в ядре (`game/`), браузер получает готовое; снимок собирается на участника
  (`snapshotFor`), чужие карты в браузер не попадают никогда.
- Кинозал: DRM, капчи, платный доступ и вход не обходим; пиратские каталоги не интегрируем;
  чужие плееры рамкой не встраиваем (память `cord-cinema-providers`).
- Модерация мягкая: исключение — конец встречи, а не бан (память `cord-moderation-is-soft`).
- Учётных записей нет и не будет в этом бэклоге (решение владельца 18.10.2026).
- Cord — продукт: ни одной ссылки на GitHub/исходники/«поставь себе» в том, что видит
  человек (интерфейс, `/download`, установщик, бот, описания).

## Грабли интерфейса (коротко; подробности — память `cord-ui-traps`, `codex-handoff-review`)

- Base UI кладёт меню и диалоги в портал в `body`: полноэкранный режим — только на документе,
  слой меню — на `Positioner` (`.menu-layer`), а не на попапе.
- Переопределения CSS по весу (`.poker.poker`) и `animation: none` поверх чужих правил уже
  ломали столы — правь исходное правило.
- Глобальное `input:not([type=checkbox],[type=radio])` (0,1,1) перебивает классы ползунков.
- Прозрачная растянутая кнопка ловит нажатия; абсолютно позиционированное поверх мест — тоже.
- e2e ждут текст «В эфире» (13 спеков) — меняя бейдж, переведи ожидание на устойчивый признак.
- Плееру кинозала нужен `hover()` перед нажатием: пульт прячется через 2,8 с.

## Машина

Первый сервер: 6 vCPU, 15 ГБ, диск 126 ГБ (занято ~50 %). Сервер общий с Kiki (у Kiki свои Grafana,
Prometheus, cadvisor, node-exporter — это **не** Cord). С 14.10.2026 у хостера замирает вся ВМ
на 20–55 с (soft lockup на всех vCPU) — это хост, не код (память `vm-host-stalls`); любая
«странность в звонке» сначала сверяется с `journalctl -k | grep 'soft lockup'`.
