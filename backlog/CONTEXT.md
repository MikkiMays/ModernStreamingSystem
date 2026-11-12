# Контекст Cord — общая справка для всех промптов

Снимок на 12.11.2026 (волна 1.4), сверен с кодом и с машинами. Это **кэш**: окружение (код, манифесты, `docs/`)
главнее. Если написанное здесь разошлось с кодом — верь коду и поправь этот файл.

## Что это

**Cord** — продукт для видеовстреч с интеграциями (кинозал, музыка, игры, доска, Telegram-бот). Учётных записей нет:
человек — это профиль устройства. Продукт закрытый: в том, что видит человек, нет ссылок на исходники. Репозитории на
GitHub **публичные** — только ради CI (приватным дают медленные машины и ограниченные минуты); поэтому в репозиторий не
попадают секреты и подробности ещё не закрытых слабых мест.

Два репозитория рядом в `$CORD_ROOT` (на машине разработки — `/opt`):

| Репозиторий | Что внутри | Стек |
| --- | --- | --- |
| `ModernStreamingSystem` | ядро `server/`, веб `web/`, службы `services/`, новые службы на Rust `rust/` (аналитика `insight`, агент машин `cord-agent`), контракты `contracts/`, инфраструктура `infra/`, Android `mobile/`, `docs/`, `backlog/` | Java 25 / Spring Boot 4.1, React 19 / TS / Vite 8 / Base UI / Tailwind 4, Python (FastAPI) + Go-издатель звука, Rust, LiveKit SFU 1.13.6, PostgreSQL 18, Redis 8, tusd, Caddy |
| `ModernStreamingSystem.Windows` | клиент Windows: `desktop/` — Electron, установщик NSIS; `src/Cord.*` — прежний WinUI, только наследие | TypeScript / Electron |

Точные версии — только из манифестов (`pom.xml`, `web/package.json`, `services/requirements.lock`, `rust/Cargo.toml`).

## Домены и машины (12.11.2026)

| Имя | Что это |
| --- | --- |
| **`cord.online`** | продукт — единственный адрес для людей. Узлы: `<id>.cord.online`, `rtc-<id>`, `turn-<id>` |
| `callcord.ru` | стенд разработки и пульт (`admin.callcord.ru`); людям не показывается |
| `cordcam.ru`, `nikg.tech` | прежние имена — убраны совсем; в код, настройки и текущие документы не возвращать |

DNS — файлом `infra/dns/zones.json` (`node scripts/dns.mjs plan|apply`); зоны у Cloudflare, все записи — серое облако.

| Машина | Где | Роль |
| --- | --- | --- |
| meet 108.165.32.23 | Франкфурт | **продукт**: ядро, база, шлюз, службы, медиаузел `main`; установка — `/opt/meet/ModernStreamingSystem`; на той же машине чужой проект — его контейнеры не трогать |
| msk 157.22.241.114 | Москва | медиаузел `msk`, выход кинозала к ivi |
| B 152.234.227.199 | Хельсинки | медиаузел `hel`, выход кинозала к YouTube |
| A 108.165.32.75 | Франкфурт | **эта машина**: стенд `callcord.ru` (`/opt/ModernStreamingSystem`), пульт, мониторинг; людей нет |

Хост meet и A замирает целиком на секунды и минуты (`journalctl -k | grep 'soft lockup'`) — это провайдер, не код;
любую «странность» сначала сверять с этим. Что покупать взамен — `docs/architecture/servers-2026-11.md`.

Выкатка: стенд — `backlog/bin/deploy.sh <службы>` из `/opt/ModernStreamingSystem`; продукт — `update.sh` на meet
(вход с A по ключу); только без идущих встреч (`backlog/bin/active-meetings.sh`). Порядок — `docs/RELEASE.md`.

## Куда смотреть в этой волне

- Состояние и задачи — `backlog/release-1.4/STATUS.md`, `TASKS.md`.
- Проекты: `docs/architecture/analytics-v2.md` (аналитика заново), `control-plane.md` (управление без SSH),
  `admin-console-v2.md` (пульт), `core-scale.md` (оптимизация ядра, ответ про Rust), `servers-2026-11.md` (серверы),
  `cord-architecture.cord-board` (схема для доски).

## Обязательное чтение (по мере надобности эпика)

- Репозиторий: `README.md`, `docs/architecture.md`, `docs/frontend.md`, `docs/INTEGRATIONS.md`,
  `docs/resilience.md`, `docs/capacity.md`, `docs/deployment.md`, `docs/INSTALL.md`, `docs/verification.md`,
  `docs/superpowers/specs/*` и `plans/*` (прошлые проектирования).
- Windows: `README.md`, `docs/architecture.md`, `docs/installer.md`, `docs/updating.md`.
- **Заметки о Cord**: `backlog/knowledge/memory/` (индекс — `knowledge/README.md`). Там грабли,
  на которых уже теряли часы; эпики называют свои. Справочные скиллы по частям системы —
  `backlog/knowledge/codex-skills/` (написаны для Codex; E00 переносит нужное в скиллы Claude).
- Скилл проверки вживую для Claude: `ModernStreamingSystem/web/.claude/skills/verify/SKILL.md`.

## Как проверять

- Веб: из `web/` — `npm test`, `npx tsc -b`, `npm run format:check`, `npm run build`.
  `tsc` не заменяет prettier, prettier не заменяет `tsc`.
- Ядро: JDK на хосте **нет**. `docker run --rm -v cord-m2:/root/.m2 -v
  "$CORD_ROOT/ModernStreamingSystem":/w -w /w maven:3.9.11-eclipse-temurin-25 mvn -B -pl server
  fmt:check verify` (CI требует `fmt:check`; формат — `com.spotify.fmt:fmt-maven-plugin:format`).
  Непонятная ошибка компиляции у `Contracts` — добавить `-Dmaven.compiler.fork=true`.
- Службы: тесты в контейнере; локально с `--network none`, а CI ходит в сеть — тест, который
  зовёт настоящий адрес, локально зелёный по ошибке.
- Контракты: `npm run generate:api` против ядра со springdoc (на проде springdoc выключен —
  поднять собранный образ ядра отдельным контейнером с H2 и включённым springdoc).
  Новый тип команды — в `Contracts.COMMAND_TYPES` (один список).
- Живая проверка: Playwright из `web/` против стенда
  (`PLAYWRIGHT_BASE_URL=https://callcord.ru npx playwright test ...`); без переменной
  конфиг поднимает пустой dev-сервер и «всё падает». Скрипты старого сервера из `web/.local/`
  (`stack.sh`, `poker-shots.mjs`, `durak-six.mjs`, `recorded/`) **не переехали** — каталог в
  `.gitignore`; нужное воссоздавать в git (`web/scripts/`). Ядро отвечает 403 на чужой `Origin` —
  dev-сервер против стенда только с подменой Origin (скилл `verify`). Скиллы проекта —
  `ModernStreamingSystem/.claude/skills/` (`cord-deploy`, `cord-verify-ui`, `cord-live-call`,
  `cord-server-tests`).
- Windows на Linux собирается частично: `Cord.Core` и тесты — да, XAML — нет; всё остальное
  проверяет Windows-CI.
- Скриншоты вёрстки: 320/390/768/1024/1280/1440/1920 (+2560×1440 для столов), обе темы,
  `scrollWidth - clientWidth` на переполнение. Скрипт — `web/scripts/shots.mjs` (скилл `cord-verify-ui`).
- Машина медленная (steal до 60 %): `tsc -b` ~10 мин, `vite build` ~14 мин, `verify` ядра ~35 мин. Во
  время работы — точечные тесты (`vitest run <файл>`, `-Dtest=…`), полный прогон — перед пушем и в CI.

## Как выкатывать

Разрешение владельца постоянное и полное (`DECISIONS.md` → «Решено владельцем»):
в конце каждой порции изменений кода — `main` обеих реп локально и на GitHub, выкатка на прод,
релиз Windows, если менялся его код, и проверка здоровья. Порядок по шагам — `docs/RELEASE.md`.

- `cd "$CORD_ROOT/ModernStreamingSystem" && backlog/bin/deploy.sh <службы>`. Веб собирается **внутрь
  `gateway`**; проверки и правила — `core`; кинозал, музыка, Telegram — `services`. Сборка `services` долгая — в фоне.
- Перед сборкой — **нет ли идущих встреч**: сборка на той же машине душит SFU (на старом
  сервере были задержки 32–48 с). `deploy.sh` спрашивает `backlog/bin/active-meetings.sh` сам и держит
  `backlog/.deploy.lock` — одна выкатка за раз.
- Windows: пуш в `main` репы Windows с новым номером в `desktop/package.json` — CI выпускает `desktop-vX.Y.Z`;
  затем зеркало `/download` и канал обновлений: `backlog/bin/publish-windows.sh --desktop X.Y.Z` на A и перенос на meet
  (`docs/RELEASE.md` → «Зеркало»).
- После выкатки: `docker compose ps` против HEAD, коммит в `<meta name="cord-build">` страницы (в интерфейсе его нет), e2e против прода.
- CI и релизы — `gh` (на A он авторизован владельцем); токен в файлы и команды не вписывать.

## Жёсткие границы

- Никогда: `docker compose down -v`, force-push, `reset --hard` чужой работы, переписывание
  применённой миграции Flyway, удаление пользовательских данных, ослабление стены sniffer
  (`infra/sniffer-firewall.sh`) или CSP. Недоверенное (sniffer кинозала) — только в своей
  подсети за стеной.
- На машине — только Cord: чужие контейнеры, сервисы и каталоги не трогать.
- Новое поле в `RoomState` — `@JsonInclude(NON_NULL)`; `RoomState` уже читается с
  `ignoreUnknown`, иначе откат образа ядра ломает комнаты.
- Правила игр — в ядре (`game/`), браузер получает готовое; снимок собирается на участника
  (`snapshotFor`), чужие карты в браузер не попадают никогда.
- Кинозал: DRM, капчи, платный доступ и вход не обходим; пиратские каталоги не интегрируем;
  чужие плееры рамкой не встраиваем.
- Модерация мягкая: исключение — конец встречи, а не бан.
- Учётных записей нет и не будет в этом бэклоге (решение владельца 18.10.2026).
- Cord — продукт: ни одной ссылки на GitHub/исходники/«поставь себе» в том, что видит
  человек (интерфейс, `/download`, установщик, бот, описания).

## Грабли интерфейса

- Base UI кладёт меню и диалоги в портал в `body`: полноэкранный режим — только на документе,
  слой меню — на `Positioner` (`.menu-layer`), а не на попапе.
- Переопределения CSS по весу (`.poker.poker`) и `animation: none` поверх чужих правил уже
  ломали столы — правь исходное правило.
- Глобальное правило полей с 19.10.2026 (E03) — `:where(…)` без `range`: классы его перебивают. Модальный
  `Dialog` Base UI ставить не ниже слоя 39 — иначе он под собственной подложкой (`knowledge/memory/cord-ui-traps`).
- Прозрачная растянутая кнопка ловит нажатия; абсолютно позиционированное поверх мест — тоже.
- e2e ждут текст «В эфире» (13 спеков) — меняя бейдж, переведи ожидание на устойчивый признак.
- Плееру кинозала нужен `hover()` перед нажатием: пульт прячется через 2,8 с.
