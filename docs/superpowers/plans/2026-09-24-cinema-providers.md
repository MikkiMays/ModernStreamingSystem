# Кинозал: площадки, VK Видео, Rutube, ivi, своя медиатека — план реализации

**Цель:** кинозал становится набором площадок-модулей. YouTube/Twitch выглядят и работают
как раньше; добавляются Rutube, VK Видео, ivi (бесплатное), «Моя медиатека» (Jellyfin),
«По ссылке»; эфиры синхронны по `PROGRAM-DATE-TIME`; входы — во вкладке «Аккаунты».
**Спецификация:** `docs/superpowers/specs/2026-09-24-cinema-providers-design.md` (обязательна;
при расхождении права она).
**Стек:** Python 3.12 / FastAPI / httpx / yt-dlp 2026.8.19 (служба), Java 25 / Spring Boot 4.1
(ядро), React 19.2 / TypeScript / Vite 8 / hls.js / dash.js (веб).
**Рабочее дерево:** `/opt/meet/.worktrees/cinema-providers/ModernStreamingSystem`, ветка
`cinema-providers`. Прод-checkout `/opt/meet/ModernStreamingSystem` и контейнеры проекта
`modern-streaming` **не трогать** — выкатывает только контролёр.

## Global constraints

- **G1 — ни одного видимого изменения у YouTube/Twitch и плеера.** DOM, классы, тексты,
  `aria-label`, анимации и переходы, тайминги (`SUPPRESS_MS` 1200, `IDLE_MS` 2800, `SKIP_MS`
  15000, `LIVE_LAG` 12, `LIVE_EDGE` 7, пороги `correction` 300/2500 мс, скорость 1,05/0,95,
  `SETTLED` 120, `CATCH_UP_LEAD` 400), конфигурация hls.js и dash.js — прежние. Проверка —
  эталон задачи 1 (скриншоты с порогом `maxDiffPixelRatio: 0.001` и слепок computed-style).
  Исключения только там, где задача называет их прямо (задача 11 — подпись у кнопки синхронизации).
- **G2 — провод совместим.** Пути, параметры и ключи ответов существующих маршрутов службы не
  меняются; новое только добавляется и необязательно. Команды ядра `watch.*` те же.
- **G3 — стиль проекта.** Комментарии по-русски и о том, «почему», в голосе репозитория;
  идентификаторы по-английски. Веб: Prettier (`singleQuote`, `printWidth: 110`,
  `trailingComma: all`), `tsc -b` без ошибок. Java: google-java-format (`fmt:check`). Python:
  строки ≤ 110, новый пакет чист под `ruff check` (правила по умолчанию).
- **G4 — тесты без сети.** Юнит-тесты службы и vitest не ходят в интернет: ответы площадок —
  фикстуры из `services/tests/fixtures/<площадка>/` (сняты настоящими запросами, обрезаны до
  нужного). Живые площадки проверяются только e2e/ручными прогонами.
- **G5 — не открытый прокси.** Каждый адрес, который отдаёт наш прокси, подписан; хост
  проверяется политикой **своей площадки**; для площадок с произвольными хостами (Jellyfin,
  ссылка) соединение разрешено только с публичными IP (проверка на подключении), частные — только
  по `CINEMA_PRIVATE_HOSTS`. Секреты и токены не пишутся в журнал; хранятся зашифрованными.
- **G6 — коммиты.** По-русски, заголовок — результат («Кинозал знает площадки по реестру, а не по
  развилкам»), тело — жалоба/причина/решение/замер, перенос ~95 символов, последняя строка
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Коммитить только в
  ветку `cinema-providers`; **не пушить**.
- **G7 — стенд.** Только свои контейнеры `cord-dev-*`, порты: SFU 7883/7884/7885, ядро 8099,
  служба 18101, vite 5199, Jellyfin 8097. Свои образы с тегами `cord-*:dev`. Никаких
  `docker compose up/down/build` на проекте `modern-streaming`. В конце задачи — прибрать свои
  контейнеры и процессы vite.
- **G8 — имена, на которые опираются e2e (не переименовывать):** `.cinema-browser`,
  `.cinema-search input`, `.cinema-tile`, `.cinema-tile-face`, `.cinema-tile-title`, `.cinema-open`,
  `.cinema-detail`, `.cinema-channel-head`, `.cinema-tile-list`, `.cinema-detail-list`,
  `.cinema-story`, `.cinema-tile-box`, `.cinema-category-head`, `.watch-theater`,
  `.people-strip .person-tile`, `.watch-title b`, `.watch-play`, `.watch-quality-menu`,
  `.watch-captions`; доступные имена «Кинозал», «YouTube», «Музыка», «Игры», «Twitch»,
  «Категории», «Плейлисты», «О канале», «Назад», «Показать ещё», «Смотреть вместе», «Пауза для
  всех», «Включить для всех», «Громкость просмотра», «Каталог», «Вернуться к просмотру», «Закрыть
  просмотр для всех», «Качество картинки и язык звука», «Субтитры».

## Команды проверки (из корня рабочего дерева)

- Служба (без пересборки образа, код монтируется поверх):
  `docker run --rm --network none --entrypoint python -v "$PWD/services/cord_services:/app/cord_services:ro" -v "$PWD/services/tests:/tests:ro" -e PYTHONPATH=/app:/tests modern-streaming-services -m unittest discover -s /tests -v`
  (если менялись зависимости — сначала `docker build -f services/Dockerfile -t cord-services:dev .`
  и тот же прогон на `cord-services:dev`).
- Линт нового пакета: `docker run --rm -v "$PWD/services":/s -w /s ghcr.io/astral-sh/ruff:0.13.2 check cord_services/cinema --line-length 110`.
- Ядро: `docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock -e TESTCONTAINERS_RYUK_DISABLED=true -v cord-m2:/root/.m2 -v "$PWD":/w -w /w maven:3.9.11-eclipse-temurin-25 mvn -B -pl server fmt:check verify`
  (форматирование: тот же образ, `mvn -B -pl server com.spotify.fmt:fmt-maven-plugin:format`).
- Веб: `cd web && npm run format:check && npm test && npm run build`.
- Контракты: стенд ядра на 8099 с `-e SPRINGDOC_API_DOCS_ENABLED=true`, затем
  `cd web && API_SCHEMA_URL=http://127.0.0.1:8099/api/openapi npm run generate:api && git diff --stat`.
- Стенд и e2e: `web/.local/stack.sh up` (задача 1), затем
  `cd web && PLAYWRIGHT_BASE_URL=http://127.0.0.1:5199 npx playwright test <спеки>`;
  эталон вида — `npx playwright test -c .local/parity/parity.config.ts`.

## Интерфейсы между задачами (обязательны к исполнению)

**Служба, `cord_services/cinema/registry.py`:**

```python
class Unsupported(Exception): ...            # маршрут отвечает 400 с тем же detail, что и раньше

@dataclass(frozen=True)
class Features:
    search: bool = True; channels: bool = False; playlists: bool = False
    categories: bool = False; series: bool = False; live: bool = False
    account: Literal["none", "optional", "required"] = "none"

@dataclass(frozen=True)
class HostPolicy:
    suffixes: tuple[str, ...] = ()            # хост == s или оканчивается на "." + s
    public_any: bool = False                  # любой публичный хост (Jellyfin, ссылка)
    def allows(self, host: str) -> bool: ...

class Provider:                               # базовый класс: всё неподдержанное — Unsupported
    id: str; hosts: HostPolicy; features: Features
    content_id: re.Pattern                     # fullmatch для contentId / id карточек
    async def availability(self) -> tuple[bool, str | None]    # (True, None) по умолчанию
    async def search(self, ctx, query: str, offset: int) -> dict
    async def channel(self, ctx, channel_id: str, tab: str, offset: int) -> dict
    async def playlist(self, ctx, playlist_id: str, offset: int) -> dict
    async def categories(self, ctx, query: str, offset: int) -> dict
    async def category(self, ctx, category_id: str, offset: int) -> dict
    async def series(self, ctx, series_id: str, season: str | None, offset: int) -> dict
    async def details(self, ctx, kind: str, item_id: str) -> dict
    async def source(self, ctx, kind: str, item_id: str, options: dict) -> "SourcePlan"
```

`ctx` — `Ctx(room: str, net: httpx.AsyncClient, accounts: Accounts | None)`. `SourcePlan` —
либо `ytdlp(url, **opts)` (дальше общий `Resolver`: hls/dash/file, субтитры, язык, постер), либо
`direct(kind, url, live, title, duration, poster, language, captions, liveDelayMs,
audioChoices, variants)` (Rutube, Jellyfin). Карточки строит `wire.card(...)` с **тем же набором
ключей и тех же `None` по умолчанию**, что ручные словари сейчас (`provider, kind, id, title,
author, channelId, duration, live, viewers, views, poster, …`); новые ключи — `badge`, `shape`
(`"wide"` 16:9 по умолчанию, `"tall"` 2:3), `series` (id сериала у серии).

Новые маршруты (все под `/api/v1/services/rooms/{room_id}/cinema/`, проверка `core.member`):
- `GET providers` → `{"providers": [{"id", "available", "reason", "account", "connected", "features": {...}}]}`;
- `GET series?provider&id&season&cursor` → `{"series": {"id","title","poster","description","year","seasons":[{"id","title"}]}, "season", "items", "next"}`;
- `POST link` `{"url"}` → `{"item": card}` (задача 15);
- `POST|DELETE accounts/{provider}` (задача 13).
`resolve` дополнительно принимает `options: {audio?: str, variant?: str}` и может вернуть
`liveDelayMs`, `audioChoices: [{id,label,lang,selected}]`, `variants: [{id,label,selected}]`.

**Ядро:** `Contracts.WATCH_PROVIDERS = "youtube|twitch|vk|rutube|ivi|jellyfin|link"`, эфир
(`kind=channel`) допустим у `youtube, twitch, vk, rutube, link`; иначе `WATCH_INVALID`.

**Веб, `web/src/core/cinema/providers.ts`:**

```ts
export const PROVIDER_IDS = ['youtube', 'twitch', 'vk', 'rutube', 'ivi', 'jellyfin', 'link'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type SceneId = 'switcher' | 'vk' | 'rutube' | 'ivi' | 'library' | 'link';
export interface ProviderSpec {
  id: ProviderId; name: string; hint: string; accent: string; icon: LucideIcon;
  scene: SceneId; searchPlaceholder: string;
}
export const PROVIDERS: Record<ProviderId, ProviderSpec>;   // только включённые в этой задаче
export const SWITCHER_TABS: readonly ProviderId[];          // ['youtube', 'twitch']
```

Сцена — ленивый компонент `({ provider, meeting, onProvider, onClose }: SceneProps)` из карты
`web/src/ui/cinema/scenes/index.ts`; `Stage` рендерит сцену по `PROVIDERS[cinema].scene` с
`key={scene}` (смена вкладки внутри одной сцены — `key` остаётся, смена сцены — ремоунт).

---

## Task 1 — стенд, фикстуры и эталон вида

**Зачем:** всё дальнейшее — рефакторинг «без видимых изменений», и доказать это можно только
сравнением с тем, что было до первой правки. Живые площадки для этого не годятся — обложки и
выдача меняются каждый час, — поэтому ответы службы фиксируются.

1. `web/.local/stack.sh up|down|status` (каталог `.local` не в git): SFU `livekit/livekit-server:v1.13.6`
   (`cord-dev-sfu`, `--network host`, конфиг с `port: 7883`, `rtc.tcp_port 7884`, `rtc.udp_port 7885`,
   `bind_addresses [127.0.0.1]`, `node_ip 127.0.0.1`, `enable_loopback_candidate: true`,
   `keys: { devkey: local-development-only-secret-32bytes }`); ядро `cord-dev-core` из образа
   `${CORE_IMAGE:-modern-streaming-core:latest}` (`SPRING_PROFILES_ACTIVE=local SERVER_PORT=8099
   PUBLIC_URL=http://127.0.0.1:5199 LIVEKIT_URL=ws://127.0.0.1:7883 LIVEKIT_INTERNAL_URL=http://127.0.0.1:7883
   DATABASE_PASSWORD=x FILES_ROOT=/tmp/uploads SPRINGDOC_API_DOCS_ENABLED=true
   SPRING_DATASOURCE_URL='jdbc:h2:mem:cord;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1'`);
   по флагу `--services` — служба `cord-dev-services` из `${SERVICES_IMAGE:-modern-streaming-services}`
   с примонтированным `services/cord_services` рабочего дерева, uvicorn на 127.0.0.1:18101 и
   переменными, которых ждёт `app.py` (адрес ядра 8099, общий внутренний секрет с ядром,
   `PUBLIC_URL`); vite: `CORD_DEV_API=http://127.0.0.1:8099 CORD_DEV_SERVICES=http://127.0.0.1:18101 npx vite --host 127.0.0.1 --port 5199 --strictPort`
   в фоне с pid-файлом. `down` убирает всё своё. Проверить: `curl 127.0.0.1:5199/api/v1/ping`.
2. Фикстуры **в git**, `web/e2e/fixtures/cinema/`: настоящие ответы службы с прода
   (скрипт Playwright против `https://meet.nikg.tech` собирает JSON всех `…/cinema/*` при проходе
   по каталогу: YouTube — пустой запрос, поиск «big buck bunny», канал из выдачи (вкладки «Видео» и
   «Плейлисты»), плейлист, страница ролика; Twitch — витрина эфиров, «Категории», страница
   категории, канал). Адреса картинок в фикстурах заменить на один `/fixtures/poster.png`.
3. Короткий HLS в git, `web/e2e/fixtures/hls/`: мастер + одна ступень 320x180, 12 с, 2-секундные
   сегменты, звук (ffmpeg из образа службы: `docker run --rm --entrypoint ffmpeg -v …
   modern-streaming-services -f lavfi -i testsrc2=… -f lavfi -i sine=… …`); ≤ 300 КБ.
4. `web/e2e/support/cinema.ts`: `routeCinema(page, overrides?)` — отвечает фикстурами на
   `**/api/v1/services/rooms/*/cinema/**` (включая `resolve` → HLS из фикстур) и
   `**/api/v1/services/catalog`, картинки — серым PNG; `openCinema(page, providerName)`;
   общий вход во встречу (как в существующих спеках).
5. `web/e2e/cinema-catalog.spec.ts` — функциональный e2e на фикстурах (идёт и в CI, без
   службы): панель → «Кинозал» → YouTube; поиск; канал; «Показать ещё»; «Смотреть вместе»
   открывает плеер у двух браузеров; «Каталог» поверх плеера; Twitch-вкладка; категории.
6. Эталон вида, `web/.local/parity/` (не в git): `parity.config.ts` (baseURL 5199, те же флаги
   браузера), `cinema.parity.spec.ts` — `toHaveScreenshot` с масками на все `video`,
   `.people-strip`, `.ping-badge`: панель интеграций с группой «Кинозал»; YouTube пустой запрос;
   поиск; канал; страница ролика; Twitch эфиры; Twitch категории; плеер на паузе с открытым меню
   качества; каталог поверх плеера — на ширинах 390, 768, 1280, 1440. Плюс слепок computed-style
   (`position, z-index, display, width, height, transition, animation-name, color,
   background-color`) для `.cinema-browser`, `.cinema-bar`, `.cinema-services`, `.cinema-service`,
   `.cinema-grid`, `.cinema-tile`, `.watch-theater`, `.watch-chrome`, `.watch-foot`, `.watch-center`,
   `.people-strip`, `.call-footer`, `.services-panel` — `toEqual` против JSON в `web/.local/parity/`.
7. Снять эталон на **нетронутом** коде (`--update-snapshots`), затем прогнать второй раз без
   обновления — должен пройти (стабильность эталона). Записать в отчёт команды и числа.

Готово, когда: `stack.sh up` поднимает стенд за ≤ 1 мин; `cinema-catalog.spec.ts` зелёный на
стенде; эталон снят и повторный прогон зелёный; `npm run format:check && npm test && npm run build`
зелёные. Коммит: фикстуры, помощник, спека.

## Task 2 — служба: пакет `cinema/` переносом, без правок логики

**Зачем:** `cinema.py` на 1552 строки делает всё сразу. Первый шаг — разложить код по модулям
**дословно**, чтобы следующий шаг (реестр) был маленьким и проверяемым.

- Удалить `services/cord_services/cinema.py`, создать пакет: `cinema/__init__.py` (реэкспорт
  **всех** имён, которые сейчас импортируют `app.py`, `tests/test_cinema.py`, `tests/test_dash.py`:
  `PAGE, Cinema, Memo, Reels, Signer, absolute, allowed, finished_playlist, master_playlist,
  offset_of, page, rewrite, routes, PREFIX` и прочие, найденные grep’ом), `cinema/transport/signer.py`
  (`Signer`, `allowed`, `proxied`, `ALLOWED_HOSTS`), `cinema/transport/playlists.py`
  (`master_playlist`, `finished_playlist`, `Reels`, `_attribute`, `rewrite`, `_numbered`),
  `cinema/transport/segments.py` (`Segments`), `cinema/memo.py` (`Memo`), `cinema/paging.py`
  (`offset_of`, `page`, `absolute`, константы `PAGE`, `SEARCH_DEPTH`, …), `cinema/captions.py`
  (`_base_language`, `_vtt`, `CAPTIONS_LIMIT`), `cinema/facade.py` (класс `Cinema` целиком),
  `cinema/routes.py` (`routes()`).
- Никаких переименований и правок поведения; только импорты. `dash.py` не трогать.
- Тесты: прежняя команда — все прежние тесты зелёные без правки их тел (правка импортов
  допустима только если имя переехало, но реэкспорт должен сделать её ненужной).
- `ruff check` нового пакета — чисто (кроме того, что уже было в исходнике: такое не чинить здесь,
  а перечислить в отчёте).

## Task 3 — служба: реестр площадок

**Зачем:** восемь развилок `if provider == …` (`search`, `channel`, `playlist`, `categories`,
`category`, `details`, `_resolve` ×2) и пять списков площадок по системе.

- `cinema/registry.py` по интерфейсу выше; `cinema/wire.py` — `card(...)` и TypedDict’ы ответов;
  **все** ручные словари карточек (≈14 мест) идут через `card(...)` с тем же набором ключей.
- `cinema/providers/youtube.py`, `cinema/providers/twitch.py` — код площадок из `facade.py`
  (каталог, подробности, строка источника для yt-dlp, условие DASH «только YouTube VOD»), без
  изменения поведения и TTL. `Cinema` становится фасадом: валидация → `registry.get(provider)` →
  метод площадки → кэш-политика (как сейчас: те же ключи и TTL) → ответ.
- Маршрут `GET …/cinema/providers` (формат выше). `CINEMA_PROVIDERS` — список включённых через
  запятую; по умолчанию — все зарегистрированные; неизвестное имя — предупреждение в журнал.
- `provider` в маршрутах проверяется реестром (неизвестная/выключенная → 400), а не `Literal`.
- Тесты (новые, `tests/test_cinema_registry.py`): реестр и `CINEMA_PROVIDERS`; `providers`
  маршрут через `fastapi.testclient.TestClient` с подменённым `core.member`; `Unsupported` → 400 с
  прежним `detail`; `card()` даёт ровно прежние ключи (сравнить с записанными словарями из текущих
  тестов/фикстур).

## Task 4 — служба: укрепление и сеть

**Зачем:** найденные дыры (спецификация, «Укрепление без видимых изменений») + сеть, на которой
будут стоять Jellyfin и ссылка.

- Подпись: полезная нагрузка = маршрут + площадка + адрес + срок (`sign(url, ttl, route, provider)`,
  `open(...)` проверяет всё); `proxied(...)` передаёт маршрут и площадку; `seg/` и `dash/` ключи —
  прежние. Картинки: отдельный маршрут в подписи — ссылка картинки не открывает `/fetch`.
- `HostPolicy` у площадки вместо общего `ALLOWED_HOSTS`: YouTube — `googlevideo.com, youtube.com,
  ytimg.com, ggpht.com, googleusercontent.com`; Twitch — `ttvnw.net, jtvnw.net, twitchcdn.net,
  twitch.tv, akamaized.net`. Проверка хоста во всех местах, где сейчас `allowed()`, — политикой
  площадки из подписи.
- `fullmatch` для всех id: `Resolve.contentId` — по `provider.content_id`; `CHANNEL_ID`,
  `CATALOG_ID`, `CATEGORY_ID` — `re.fullmatch` (сейчас `$` пропускает `\n`).
- `/fetch` без `Range`: если `Content-Length` неизвестен или больше лимита кэша — отдавать потоком
  (как ветка с `Range`), не читая тело в память.
- Ключи кэша каталога и подробностей — с учётом регистра (id YouTube регистрозависимы).
- `Memo`: если производитель упал, ожидающие получают то же исключение (не перезапускают).
- Twitch GQL: строки подставлять через `json.dumps(value)` (валидный строковый литерал GraphQL).
- Лимит `resolve`: 30 в минуту на комнату (скользящее окно в памяти) → 429.
- `cinema/net.py`: `client_for(provider_id)` — `httpx.AsyncClient` с прокси из `CINEMA_PROXY_<ID>`
  или `CINEMA_PROXY` (http/https/socks5h; добавить `socksio` в `requirements.txt` и пересобрать
  `requirements.lock` с хэшами: `uv pip compile requirements.txt --generate-hashes -o requirements.lock`
  в контейнере `python:3.12-slim-bookworm`), тот же прокси — в опции yt-dlp (`proxy`) для площадки.
  `guard_public(host)` и транспорт httpx, который **после** разрешения имени отказывает
  соединению с непубличным IP (loopback, private, link-local, CGNAT, multicast, unspecified,
  IPv6-аналоги), кроме сетей из `CINEMA_PRIVATE_HOSTS` (CIDR через запятую).
- Тесты: подпись не переносится между маршрутами/площадками; хост чужой площадки отклонён; `\n`
  в id отклонён; поток без буферизации (мок-ответ с большим `Content-Length`); `Memo` делит
  ошибку; экранирование GQL; 429 на 31-м `resolve`; `guard_public` для набора адресов.

## Task 5 — ядро: площадки, эфир по площадке, одно правило исключительности

- `room/Contracts.java`: `public static final String WATCH_PROVIDERS = "youtube|twitch|vk|rutube|ivi|jellyfin|link";`
  и `@Pattern(regexp = WATCH_PROVIDERS)` у `provider`. Шаблон `contentId` не менять (его делят игры).
- `RoomService` `watch.open`: `kind=channel` только у `youtube|twitch|vk|rutube|link`, иначе
  `WATCH_INVALID` (тот же код и текст, что у пустых полей).
- Пять копий «одна интеграция» → один помощник (например `IntegrationRules` или приватные методы
  `stageBusy(room)`, `earsBusy(room)`), **те же** коды (`INTEGRATION_BUSY`, …) и тексты.
- `RoomServiceTest`: новые площадки открываются; `ivi`+`channel` → `WATCH_INVALID`; все прежние
  тесты исключительности зелёные без правки ожиданий.
- `fmt:check verify` в контейнере с docker.sock (Postgres-тесты должны **идти**, не пропускаться —
  проверить в отчёте число тестов `PostgresIntegrationTest`).
- Перегенерировать `contracts/openapi.json` и `web/src/api/generated.ts` со стенда (образ ядра из
  рабочего дерева: `docker build -f infra/Dockerfile.server -t cord-core:dev .`), коммитом вместе.

## Task 6 — веб: модули кинозала и реестр площадок

- `web/src/core/cinema.ts` → `web/src/core/cinema/{api.ts,types.ts,format.ts,providers.ts,index.ts}`
  (реэкспорт прежних имён из `index.ts`, импорты по коду поправить). В `api.ts`: `cursor`
  через `encodeURIComponent`; `resolve` с таймаутом 20 с (`AbortSignal.timeout(20000)`), остальные
  вызовы — как были. Методы для новых маршрутов: `providers()`, `series(provider, id, season, cursor)`.
- `providers.ts` по интерфейсу выше, пока с `youtube` и `twitch` (`scene: 'switcher'`); акцент —
  **текущие** цвета вкладок из CSS (`#e33b3b`, `#8250e6`) — и CSS-правила
  `[data-id='youtube'|'twitch']` читают их через `style={{'--accent': …}}` /
  `data-id` без смены вида; расхождение с `CinemaGroup` (`#ff3d3d`/`#9147ff`) устранить так, чтобы
  **пиксели плитки в панели не изменились** (оставить её значения отдельным полем `tile` или
  подобрать способ — решить и описать в отчёте).
- `api/types.ts`: `Watch.provider: ProviderId`; `core/watch.ts` — `WatchProvider = ProviderId`.
- `ui/CinemaGroup.tsx` → `ui/cinema/CinemaGroup.tsx`: плитки из `PROVIDERS` в порядке реестра,
  доступность — из `api.providers()` (react-query, `staleTime` 60 с; ошибка → считать всё
  доступным); недоступная плитка — `disabled` + `title={reason}`. Удалить мёртвый селектор-повод
  (`data-active` у `.service-tile`, на который нет стиля) — только если эталон не меняется.
- `Services.tsx`: подсказка группы берётся из реестра (пока «YouTube и Twitch на всю комнату» —
  текст не меняется, пока площадок две).
- vitest: реестр (порядок, уникальность, у каждой площадки есть сцена), `api.ts` (кодирование
  курсора, таймаут resolve). Эталон и `cinema-catalog.spec.ts` — зелёные.

## Task 7 — веб: примитивы каталога и сцена переключателя

- `web/src/ui/CinemaBrowser.tsx` → `web/src/ui/cinema/catalog/` (`Shell.tsx` — тёмный корень
  `.cinema-browser` + полоса `.cinema-bar` с «Назад»/знаком/поиском/закрытием; `tiles.tsx` —
  `Tile`, `PlaylistTile`, `CategoryTile`, `ChannelTile`, `Grid`; `More.tsx`; `useStack.ts`;
  `pages/{ItemPage,ChannelPage,PlaylistPage,CategoryPage}.tsx`) +
  `web/src/ui/cinema/scenes/SwitcherScene.tsx` (поведение YouTube/Twitch целиком: вкладки сверху
  слева из `SWITCHER_TABS`, `TABS` каналов, `HINTS`, «Эфиры/Категории» у Twitch) +
  `scenes/index.ts` (ленивая карта `SceneId → компонент`).
- Развилки `provider === 'youtube'|'twitch'` внутри примитивов заменить данными площадки
  (`features` из реестра/ответа `providers` или полями `ProviderSpec`) — **внутри
  `SwitcherScene` их логика остаётся той же**.
- `Stage.tsx`: сцена по `PROVIDERS[cinema].scene`; при смене площадки внутри `switcher` —
  прежнее мгновенное переключение (без ремоунта сцены, но стопка/поиск сбрасываются **синхронно**
  при смене провайдера — через `key` на внутреннем состоянии площадки, а не эффектом).
- Перекрытие 701–767 px: воспроизвести (Playwright, ширина 720/760, панель открыта, открыть
  каталог) и исправить в `MeetingView.tsx` так, чтобы правило совпадало с точкой, где панель
  становится нижним листом (767 px); в отчёте — скриншоты до/после.
- Эталон вида и `cinema-catalog.spec.ts` — зелёные; vitest для `useStack`.

## Task 8 — веб: разбор плеера и вынос CSS

- `web/src/ui/WatchTheater.tsx` (1149 строк) → `web/src/ui/cinema/theater/`: `WatchTheater.tsx`
  (сборка), `useSource.ts` (resolve, обновление за 60 с до `expiresAt`, повторы 403/410),
  `engines/{hls,dash,file}.ts` с общим интерфейсом `Playback { quality, voice, levels, destroy,
  liveSyncPosition?, playingDate? }` (`watch-dash.ts` переезжает в `engines/dash.ts`),
  `useRoomSync.ts` (секундный цикл, эхо, `resync`), `useCaptions.ts`, `Chrome.tsx` (пульт),
  `menus/{QualityMenu,CaptionsMenu}.tsx`, `SyncButton.tsx`. **Перенос, а не переписывание:**
  выражения, пороги, порядок вызовов и тексты те же. `watch-controls.ts`, `watch-levels.ts`,
  `watch-tracks.ts` — в ту же папку с тестами.
- CSS кинозала из `room-layout.css` (≈ строки 666–1243, 1325–1417, 1419–2038, 2040–2076 —
  проверить по месту) → `web/src/ui/cinema/cinema.css` и `theater.css`, **импорт из `main.tsx`
  сразу после `room-layout.css`** (не из ленивых чанков: иначе меняется порядок каскада). Дубли
  телефонных правил (`.cinema-grid` 160/150 px, `.watch-volume`) свести к тому, что **сейчас
  побеждает**. Правило `.watch-theater:fullscreen` — к остальным правилам плеера.
- e2e `watch.spec.ts`: проверка озвучки ищет `[data-selected="true"]` на первом уровне
  меню, где его больше нет — перейти на вторую страницу меню («Язык звука») и проверить там.
- Проверка: эталон вида на **dev** и на **сборке** (`npm run build` + `npx vite preview --port
  5199` с тем же прокси — если у preview нет прокси, добавить в `vite.config.ts` секцию
  `preview.proxy` = `server.proxy`), `cinema-catalog.spec.ts`, vitest (перенесённые тесты + адаптер
  HLS по образцу `watch-dash.test.ts`), `npm run build`.

## Task 9 — Rutube

- Служба `cinema/providers/rutube.py` (`HostPolicy`: `rutube.ru`, `rtbcdn.ru`; `content_id`
  `[0-9a-f]{32}`; `features`: search, channels, categories, series, live):
  - поиск `https://rutube.ru/api/search/video/?query=` (одна страница до ~95; `next` — смещение в
    полученном, как у Twitch);
  - категории `api/video/category/` и `api/video/category/<id>/?page=` (100/стр);
  - канал `api/video/person/<id>/?page=` (20/стр; шапка — из первой карточки/`api/profile/user/<id>/`,
    проверить);
  - сериалы и шоу `api/metainfo/tv/?page=` (типы `series`/`tvshow`) и серии
    `api/metainfo/tv/<id>/video?page=` + сезоны (найти параметр сезона в запросах их сайта);
  - эфиры ТВ: найти адрес ленты эфиров в сетевых запросах rutube.ru (Playwright), иначе поиск с
    фильтром `is_livestream`; эфир — `kind=channel`, id — id ролика;
  - источник: `api/play/options/<id>/?no_404=true&referer=https%3A%2F%2Frutube.ru` →
    `video_balancer.m3u8` (VOD) или `live_streams.hls[0].url` (эфир) → `direct(hls)`; `is_paid`,
    DRM (`drm_token`) и `is_adult` — не показывать в каталоге/отказ в `resolve` с понятным текстом;
    субтитры `captions` → наш формат.
  - фикстуры — живые ответы (обрезанные) в `services/tests/fixtures/rutube/`; тесты маппинга,
    пагинации, отказа для платного.
- Веб: `PROVIDERS.rutube` (`scene: 'rutube'`, цвет — из их CSS-бандла, найти и указать источник),
  `scenes/RutubeScene.tsx`: полки «Прямой эфир», «Сериалы и шоу» (постеры 2:3, `shape: 'tall'`),
  чипы категорий; поиск «Видео, каналы и ТВ»; страница сериала (`pages/SeriesPage.tsx` — общий
  примитив: шапка, вкладки сезонов, сетка серий); канал; ролик → «Смотреть вместе».
  Скилл `frontend-design:frontend-design` для вида; только существующие токены и переходы.
- e2e `web/e2e/cinema-rutube.spec.ts` на фикстурах (+ HLS из фикстур): открыть, найти, серия,
  «Смотреть вместе» у двух браузеров. Отдельный живой прогон на стенде со службой
  (`stack.sh up --services`) — отчётом, не в CI.
- Перекрытия: сцена на 320/390/500/701/767/820/1024/1280/1440 — `.cinema-browser` не
  пересекается с `.call-footer`/`.side-panel`/`.people-strip`, `scrollWidth ≤ clientWidth`.

## Task 10 — VK Видео

- Служба `cinema/providers/vk.py` (`HostPolicy`: `vkuser.net`, `okcdn.ru`, `userapi.com`,
  `vkvideo.ru`, `vk.com`, `vk.ru`, `mycdn.me` — уточнить по живым ответам; `content_id`
  `-?\d+_\d+`; эфир VK Видео Live — slug `[A-Za-z0-9_]{1,64}`):
  - анонимный токен: `POST https://login.vk.ru/?act=get_anonym_token` (форма `client_id=52461373`,
    `client_secret` — из публичного бандла vkvideo.ru, вписать константой с комментарием «не секрет
    и не наш», как у Twitch; `app_id=52461373`, `version=1`,
    `scopes=audio_anonymous,video_anonymous,photos_anonymous,profile_anonymous`,
    `isApiOauthAnonymEnabled=false`; заголовки `Origin`/`Referer: https://vkvideo.ru`) →
    `data.access_token`, `data.expired_at`; кэш до `expired_at − 5 мин`, одиночный полёт; ошибка
    API 5 → сбросить и повторить один раз;
  - вызовы `POST https://api.vkvideo.ru/method/<метод>?v=5.289&client_id=52461373&lang=ru` с формой
    `access_token=…`: `catalog.getVideo` (`need_blocks=1`, `owner_id=0`) — разделы и первая выдача;
    продолжение раздела — найти (`catalog.getSection`/`catalog.getBlockItems` с `start_from`);
    поиск — `catalog.getVideoSearchWeb2` (`q`); сообщество и его видео/плейлисты — найти рабочие
    методы (проверить `video.get`, `video.getAlbums`, `catalog.getVideo` c `owner_id=-id`), всё
    закрепить фикстурами;
  - источник: yt-dlp `https://vkvideo.ru/video<owner>_<id>` (HLS/DASH, субтитры), для VK Видео Live —
    `https://live.vkvideo.ru/<slug>`; `resolve` эфира — `kind=channel`.
  - если токен/каталог недоступен — страница каталога честно говорит об этом, а поиск по ссылке
    на ролик VK всё ещё работает (вставленная ссылка распознаётся и открывает ролик).
- Веб: `PROVIDERS.vk` (`#0077FF`, `scene: 'vk'`), `scenes/VkScene.tsx`: чипы разделов площадки,
  сетка 16:9 (длительность, просмотры, автор), поиск «Видео и сообщества» с полкой сообществ,
  страница сообщества (шапка, «Видео», «Плейлисты»), ролик → «Смотреть вместе».
- e2e `cinema-vk.spec.ts` на фикстурах; живой прогон отчётом; перекрытия как в задаче 9.

## Task 11 — одна секунда для всех

- `SyncButton`: при `|drift| > VISIBLE_DRIFT` (1200 мс) или когда комната играет, а у меня пауза
  / блок автоплея — кнопка становится таблеткой «На секунду комнаты · −3 с» (знак и округление до
  целых секунд, `aria-label` прежний + число); иначе — прежняя иконка без изменений (G1).
- Служба: для эфира с `#EXT-X-PROGRAM-DATE-TIME` при `resolve` прочитать один вариантный плейлист,
  вычислить `liveDelayMs = ceil((now − PDT_конца_последнего_сегмента) + (3 + 1) × TARGETDURATION)`
  в секундах × 1000, мемо на поток на 6 ч; нет PDT — `null`.
- Веб `useRoomSync`: если `source.liveDelayMs` и `playback.playingDate` есть — цель эфира
  `serverNow − liveDelayMs`, расхождение `playingDate − цель`, те же пороги и скорость, что у VOD,
  не дальше края; `LIVE_LAG` — только когда PDT нет. Кнопка LIVE ведёт к общей цели.
- vitest: `correction` для эфира (PDT есть / нет / край ближе цели); проверить PDT у Twitch,
  YouTube, VK живыми запросами (отчётом).
- Замер: два браузера на стенде со службой на эфире Rutube — расхождение < 0,5 с (отчётом).

## Task 12 — ivi (только бесплатное)

- `pycryptodomex` → `requirements.txt` и lock с хэшами (как в задаче 4), образ `cord-services:dev`.
- Служба `cinema/providers/ivi.py`: `availability()` — `https://api.ivi.ru/mobileapi/geocheck/whoami/v6/?app_version=870`
  (не `RU` → `(False, "ivi отдаёт бесплатное только в России")`, кэш 1 ч);
  каталог `…/mobileapi/catalogue/v7/?category=<14|15|17>&paid_type=AVOD&from&to&app_version=870`
  (фильмы/сериалы/мультфильмы), поиск `…/mobileapi/search/v7/?query=` с отбором `AVOD`,
  сериал — `compilationinfo`/`videofromcompilation` (сезоны, серии); постеры 2:3; `content_id`
  `\d{1,12}`; источник — yt-dlp `https://www.ivi.ru/watch/<id>`; если yt-dlp вернул DRM/гео —
  понятный отказ. Фикстуры — ответы из DE (форма та же) + синтетические AVOD-строки.
- Веб: `PROVIDERS.ivi` (`#EA003D`, `scene: 'ivi'`), `IviScene.tsx`: вкладки «Фильмы / Сериалы /
  Мультфильмы», постеры 2:3 (год, жанр, рейтинг), сериал через `SeriesPage`, недоступность —
  плашка с причиной; «только по подписке» — текст из спецификации.
- В отчёт: одна команда для владельца в Москве, проверяющая ivi на его установке.

## Task 13 — «Аккаунты»

- Служба `cord_services/accounts.py`: Fernet-сейф на комнату (ключ — как у Яндекса сейчас),
  `put(scope, provider, value, ttl)`, `get`, `delete`; `yandex.py` переходит на него **без изменения
  поведения** (`tests/test_yandex.py` и `test_services.py` зелёные). Маршруты
  `POST|DELETE …/cinema/accounts/{provider}` (права — как у интеграций: `integrationsAllowed` или
  создатель), значения не журналируются.
- Веб: `ui/settings/AccountsTab.tsx`, вкладка «Аккаунты» в `Settings.tsx` между «Профилем» и
  «Связью»; поле токена Яндекс Музыки **переносится** из «Профиля» (ключ `yandexMusicToken`,
  тексты и сноска те же); блок Jellyfin (адрес сервера, имя, пароль → «Подключить» → в профиле
  хранятся `server`, `userId`, `token`, `name`; пароль не хранится; «Отключить»). Модалка настроек
  на 320–1440 без горизонтальной прокрутки.
- `core/accounts.ts`: чтение/запись профиля + автоподключение (при открытии сцены площадки с
  `features.account != 'none'` сохранённый вход уходит в `accounts/{provider}` один раз на встречу).

## Task 14 — «Моя медиатека» (Jellyfin)

- Стенд: `cord-dev-jellyfin` (`jellyfin/jellyfin`, 127.0.0.1:8097), автоматическая первичная
  настройка через `/Startup/*`, библиотеки «Фильмы» (Sintel, CC BY 3.0, Blender Foundation — или
  синтетический ролик, если скачать нельзя) и «Сериалы» (ffmpeg: `Test Show/Season 01/S01E01.mkv`,
  `S01E02.mkv`, по две звуковые дорожки `rus` «Дубляж» и `eng` «Original», субтитры srt).
- Служба `cinema/providers/jellyfin.py` (`HostPolicy(public_any=True)`, `account: 'required'`,
  `content_id` `[0-9a-f]{32}`): вход `POST /Users/AuthenticateByName` (заголовок
  `Authorization: MediaBrowser Client="Cord", Device="Cord", DeviceId="<комната>", Version="<версия>"`),
  библиотеки `/UserViews`, элементы `/Items` (`ParentId`, `IncludeItemTypes=Movie,Series`,
  `Recursive`, `SortBy`, `StartIndex`, `Limit`, `searchTerm`), сериал `/Shows/{id}/Seasons` и
  `/Shows/{id}/Episodes?seasonId=`, подробности `/Items/{id}` (`MediaStreams`), картинки
  `/Items/{id}/Images/Primary?maxWidth=`; источник — `direct(hls)`
  `/Videos/{id}/master.m3u8?MediaSourceId=&api_key=&AudioStreamIndex=&SubtitleStreamIndex=&VideoCodec=h264&AudioCodec=aac&MaxStreamingBitrate=&SegmentContainer=ts`
  с `audioChoices` (из `MediaStreams`, метка = `Title` или язык) и `variants` («Оригинал»,
  «1080p», «720p», «480p»); один адрес мастера на комнату и выбор (мемо), чтобы Jellyfin
  перекодировал один раз.
- Веб: `PROVIDERS.jellyfin` (`#AA5CC3`, имя «Моя медиатека», подсказка «Свои фильмы и сериалы:
  озвучки, серии, качество»), `LibraryScene.tsx`: без входа — приглашение + форма (с «Запомнить на
  этом устройстве»); библиотеки вкладками, полка «Продолжить», постеры 2:3; фильм — список озвучек и
  субтитров; сериал — `SeriesPage`. Плеер: если в источнике есть `audioChoices`/`variants`, меню
  «Язык звука»/«Качество» показывает их, выбор — личный `resolve` с `options`, позиция
  сохраняется (синхронизация догонит).
- e2e `cinema-library.spec.ts` на стенде с Jellyfin (не в CI; помечен и пропускается без
  `CORD_E2E_JELLYFIN`); vitest меню с серверными вариантами.

## Task 15 — «По ссылке»

- Служба `cinema/providers/link.py` (`HostPolicy(public_any=True)`): `POST …/cinema/link`
  принимает `http(s)`-адрес ≤ 2000 символов; хост проходит `guard_public`; yt-dlp с
  `allowed_extractors=['default', '-generic']` (проверить ключ опции в 2026.8.19); прямые
  `.m3u8/.mpd/.mp4/.webm` — только после проверки `Content-Type` запросом через безопасный
  транспорт; карточка с непрозрачным id = base64url(HMAC(url))[:22], отображение id→url в сторе
  службы на 24 ч; `resolve` по id. Лимит: 20 ссылок в минуту на комнату.
- Веб: `PROVIDERS.link` (`scene: 'link'`), `LinkScene.tsx`: поле ссылки, подсказки площадок
  (OK, Дзен, VK, Rutube, YouTube, Vimeo, Первый канал, archive.org), недавние ссылки в профиле,
  карточка результата → «Смотреть вместе». Ошибки — человеческим текстом.
- Тесты: `127.0.0.1`, `10.x`, `169.254.169.254`, `[::1]`, имя, резолвящееся в частный адрес, —
  отказ; `generic` не вызывается; повтор id стабилен. Отдельно — security-ревью диффа.

## Task 16 — документы, CI и финальная проверка

- `docs/INTEGRATIONS.md`: раздел кинозала заново (площадки, реестр, как добавить площадку,
  границы: DRM, пиратство, регион, почему нет Кинопоиска и Зоны), `docs/architecture.md`
  (совместный просмотр), `docs/INSTALL.md`/`docs/deployment.md` (`CINEMA_PROVIDERS`,
  `CINEMA_PROXY`, `CINEMA_PROXY_<ID>`, `CINEMA_PRIVATE_HOSTS`), `docs/capacity.md` (Jellyfin и
  ссылка через наш канал).
- CI `verify.yml`: шаг `ruff check` пакета `cinema` (образ ruff по digest); e2e на фикстурах идут в
  browser-задании.
- Полный прогон всех команд проверки; отчёт с числами.

---

## Изменение плана (решение владельца, 24.09.2026)

- **Jellyfin (Task 14) убран**: библиотека своих файлов на сервере не нужна — всё должно работать из сети.
  Task 13 («Аккаунты») остаётся без коннектора Jellyfin: вкладка, перенос токена Яндекс Музыки, каркас.
- **«По ссылке» (Task 15) — приоритет сразу после VK**, разбит на три задачи:
  - **15a** — маршрутизатор ссылок: каждая площадка знает свою грамматику адресов (`match(url)`); ссылка на
    YouTube/Twitch/Rutube/VK открывается в сцене своей площадки на нужной странице; `POST …/cinema/link`;
    сцена «По ссылке» (поле, недавние, карточка результата, сериалы/плейлисты как список серий).
  - **15b** — универсальный путь через yt-dlp: все экстракторы, включая `generic` (разбор произвольной страницы),
    сеть — только через охраняемый выходной прокси (публичные адреса); качество, дорожки звука, субтитры,
    плейлисты → серии.
  - **15c** — «вытянуть плеер со страницы»: отдельный контейнер с headless Chromium открывает страницу, её
    собственный плеер запускается, служба записывает запросы потока (m3u8/mpd/mp4) и заголовки; дальше играет наш
    плеер через прокси с профилем заголовков. Контейнер во внутренней сети, выход только через охраняемый прокси,
    всплывающие окна заблокированы, лимиты памяти/времени/частоты. **DRM отказывается** (EME, SAMPLE-AES,
    Widevine/PlayReady/FairPlay); капчи, платный доступ и вход не обходятся; особых «декодеров» под чужие плееры нет.
- Встраивание чужого плеера рамкой отклонено: синхронизации нет, а Windows-клиент чужие рамки запрещает.
- Новый порядок: Task 10 (VK) → выкатка B → 15a → 15b → 15c → Task 11 → Task 12 → Task 13 → Task 16.

## Task 15a — ссылки: маршрутизатор и сцена «По ссылке»

**Зачем:** человек вставляет любую ссылку; если площадка у нас есть — ролик, эфир, канал или сериал открываются
в её сцене, иначе ссылка идёт в универсальный путь (15b/15c).

- Служба: у `Provider` новый метод `match(url: str) -> Match | None` (`Match(kind, id, page)`,
  `page ∈ {"item","channel","playlist","series"}`), грамматика адресов — у каждой площадки, с тестами на
  реальные формы: YouTube (`watch?v=`, `youtu.be/`, `shorts/`, `live/`, `embed/`, `m.`/`music.`, `playlist?list=`,
  `@handle`, `channel/UC…`), Twitch (`<login>`, `videos/<id>`), Rutube (`video/<id>`, `play/embed/<id>`,
  `live/video/<id>`, `channel/<id>`, `metainfo/tv/<id>`), VK (`video-<o>_<i>`, `vkvideo.ru/video…`, `?z=video…`,
  `clip…`, `video_ext.php?oid=&id=`, `live.vkvideo.ru/<slug>`, `@<группа>`). Разбор строгий (`urlsplit`, хост
  по списку площадки, id через `content_id`); площадка по ссылке **не ходит**.
- Маршрут `POST …/cinema/link {url}` (≤ 2000 символов, `http(s)`): совпало с площадкой → `{"route":
  {"provider","kind","id","page"}}`; не совпало → `{"item": card}` площадки `link` (задачи 15b/15c наполняют;
  здесь — заглушка «Эту ссылку пока не открыть»). Лимит 20/мин на комнату. Грамматику VK из веба (Task 10)
  перенести сюда; веб больше адреса не разбирает.
- Веб: `PROVIDERS.link` («По ссылке», `scene: 'link'`), `LinkScene.tsx`: поле со вставкой из буфера, недавние
  ссылки (профиль, 10 шт.), состояние «ищем видео…», карточка результата (постер, название, длительность,
  качество, дорожки звука, субтитры, список серий, если это плейлист) → «Смотреть вместе». `route` — переход в
  сцену площадки сразу на нужную страницу: `meeting.openCinema(provider, at)` — сцены принимают начальную
  страницу (`at`), для switcher/Rutube/VK. Поле ссылки есть и в поиске каждой сцены (как у VK).
- Тесты: грамматика (по 5+ форм на площадку, чужие хосты и мусор отклоняются), маршрут, e2e на фикстурах: ссылка
  Rutube/VK/YouTube открывает их сцену на ролике; неизвестная ссылка — сцена «По ссылке».

## Task 15b — ссылки: универсальный путь через yt-dlp

- Площадка `link` в службе: `content_id` = непрозрачный id (base64url(HMAC(url))[:22]), отображение id → адрес и
  «профиль» потока — в сторе службы (`store.py`) на 24 ч.
- Разбор: yt-dlp **со всеми экстракторами, включая `generic`** (разбор произвольной страницы: `<video>`, m3u8/mpd,
  разметка видео, встроенные плееры других сайтов — встроенный YouTube/VK/Rutube уходит в свою площадку через
  `match`). Вся сеть yt-dlp — через **охраняемый выходной прокси** в службе: локальный HTTP/CONNECT-прокси на
  `127.0.0.1` с одноразовыми учётными данными, соединения — только после `Guard.vet` (публичные адреса,
  проверка на подключении, редиректы — каждым шагом через прокси). Порт и учётные данные — из конфигурации
  приложения, в журнал не пишутся.
- Результат: HLS/DASH/файл нашим прокси (политика хостов площадки `link` = `public_any`, подпись как у всех),
  дорожки звука (HLS-рендишены → меню «Язык озвучки»), субтитры, **плейлист → серии** (`series`-страница с
  сериями; каждая серия — свой `link`-id), живой эфир → `kind: channel`.
- DRM: `#EXT-X-KEY` с `SAMPLE-AES`/`KEYFORMAT` Widevine/PlayReady/FairPlay, MPD `ContentProtection` → отказ
  «Видео защищено DRM — показать комнате нельзя». AES-128 (открытый ключ) — обычный HLS, играет.
- Тесты без сети (фикстуры yt-dlp info/страниц), прокси: частный адрес, редирект на частный, DNS в частный —
  отказ; живая проверка отчётом: 5 разных сайтов (OK, Дзен, Vimeo, archive.org, страница с `<video>`).

## Task 15c — ссылки: «вытянуть плеер со страницы»

- Отдельный контейнер `cinema-sniffer` (Python + Playwright Chromium; образ собирается из репозитория, версии
  закреплены), в compose: `ports: ["127.0.0.1:18103:8080"]`, `read_only`, `tmpfs: /tmp`, `shm_size: 1g`,
  `mem_limit: 1536m`, `pids_limit`, `cap_drop: [ALL]`, `no-new-privileges`, общий секрет с службой.
- Внутри — тот же охраняемый прокси (общий модуль с `cinema/net.py`), Chromium запущен **только через него**:
  `--proxy-server`, `--disable-quic`, `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`,
  `--host-resolver-rules` «MAP * ~NOTFOUND, EXCLUDE прокси», всплывающие окна и загрузки запрещены.
- `POST /sniff {url}` (секрет): страница открывается, ждём медиа-запросы (по типу и расширению: m3u8/mpd/mp4/webm),
  при их отсутствии — одно нажатие по крупнейшему `video`/кадру/кнопке воспроизведения, всё за ≤ 25 с; фиксируем
  EME (`requestMediaKeySystemAccess`) → DRM-отказ; ответ: заголовок, постер (`og:image`), кандидаты потоков
  с заголовками запроса (Referer/Origin/User-Agent/Cookie) и признак DRM. Одна страница за раз на комнату,
  не больше двух одновременно на сервер.
- Служба: если yt-dlp не нашёл видео — просит sniffer; профиль заголовков хранится на стороне службы по id
  потока и подставляется прокси при запросах к хостам этого потока; на 403/410 — повторное «вытягивание».
- Без обходов: капчи, платный доступ и вход не проходим, «стелс»-подмены отпечатков нет; страница, просящая
  подтверждение, — честный отказ «Сайт просит подтвердить, что вы не робот, — откройте видео на самом сайте».
- Тесты: sniffer на локальной странице-фикстуре (hls.js-плеер с m3u8, плеер в iframe другого origin, страница с
  EME) в контейнере; e2e: ссылка на такую страницу открывает поток у двух браузеров синхронно.

## Task 11a — аудит синхронности (вместо Task 11)

Не переписывать работающее. Найти и закрыть дефекты под нагрузкой и в крайних случаях, каждый — тестом:
пауза (сейчас после паузы клиенты стоят в разных местах: на паузе выравнивание только сверх 2,5 с, хотя перемотка
на паузе невидима — выравнивать точно); подтяжка скоростью, которая не работает (падение кадров) — через N секунд
без сокращения расхождения переходить к перемотке; фоновая вкладка (таймеры замедлены) — выравнивание сразу на
`visibilitychange`; часы (несколько замеров, минимальная задержка, скачки после сна); эфиры — замерить разброс
между зрителями и, только если он заметен, выровнять по `PROGRAM-DATE-TIME`; служба при многих комнатах (память
при `mem_limit: 1g`, кэш сегментов, пулы). Замеры до/после — в отчёт.

## Task 13a — «Аккаунты» (вместо Task 13, без Jellyfin)

Вкладка «Аккаунты» в настройках: токен Яндекс Музыки переносится из «Профиля» (ключ и поведение прежние);
каркас для будущих входов (реестр аккаунтов в вебе, сейф в службе вынесен из `yandex.py`). Больше ничего.
