# 2026-10-21 — регрессия перед финальным выпуском: полные прогоны всех наборов

Ветка `regression-wave` от `main` (`bd98dc0`, «Контракты после хвостов безопасности: Snapshot.cinemaTraffic»);
клиент на Electron — ветка `regression-desktop` репозитория Windows (от его `main`, `9e047ef`). Исполнитель —
Sonnet 5.5 по заданию главной сессии. С прошлой волны качества (20.10, всё зелёное) влиты: E10-B (наблюдаемость,
рычаги владельца), E13 (знакомство и поддержка), E14-B (переводы), E01-B2/B3 (веб классического и родного
клиента), хвосты функций (отчёт о качестве V12, реклама кинозала, JOINING музыки), визуальная волна, хвосты
безопасности (ключи HKDF, правила TURN, зал ожидания, чат на адрес, трафик кинозала, кнопки Telegram).

Правок продукта и тестов нет: **ни один тест не устарел**, продукт сломан в одном месте (плеер страниц, ниже).
Контракты не перегенерировались, `STATUS.md` не тронут, пуша и выкатки нет, e2e против стенда и нагрузочных
прогонов нет (E18, отложено владельцем).

Хост общий и медленный: пока шли прогоны, среднее число процессов в очереди доходило до 20 (соседние сессии),
своп занят на 3 ГБ. Все тяжёлые наборы шли по одному, с журналами в `/tmp/reg/`.

## Итог по наборам

| Набор | Команда | Выход | Что получилось |
| --- | --- | --- | --- |
| vitest веба | `npx vitest run <каталоги> --pool=forks --maxWorkers=1 --testTimeout=120000`, три порции | 0, 0, 0 | `src/api src/core` 45 файлов / 344 теста; `src/media src/styles src/telegram src/i18n` 37 / 294; `src/ui` 73 / 516. **155 файлов, 1154 теста, все зелёные** (в волне качества — 125 / 943). ≈ 9 мин |
| `npx tsc -b` | из `web/` | 0 | чисто |
| `npm run format:check` | из `web/` | 0 | «All matched files use Prettier code style» |
| `scripts/i18n/check.mjs` | из `web/` | 0 | строк с кириллицей в коде 162 при базе 162 |
| `scripts/i18n/coverage.mjs` | из `web/` | 0 | 2428 / 2428 ключей у всех семи языков, замечаний 0 |
| `scripts/i18n/sync-errors.mjs --check` | из `web/` | 0 | каталог ошибок совпадает с реестром |
| `scripts/check-contrast.mjs` | из `web/` | 0 | 131 пара, нарушений 0 (в волне качества — 88 пар) |
| `npm run build` | из `web/` (`tsc -b` + `vite build`) | 0 | 64 с |
| Ядро `fmt:check verify` | docker `maven:3.9.11-eclipse-temurin-25`, `--network host`, `TESTCONTAINERS_RYUK_DISABLED=true`, онлайн | 0 | **456 тестов, 0 падений, 0 пропусков**, BUILD SUCCESS, 7 мин 50 с. На настоящем Postgres: `PostgresIntegrationTest` 67 (CI требует ≥ 15 без пропусков), `FavoriteGroupsPostgresTest` 9, `FavoriteOrderPostgresTest` 5 (в волне качества — 412) |
| Службы unittest | образ `modern-streaming-services`, код `:ro` поверх `/app/cord_services`, `--network none --read-only`, `discover -s /tests` | **1**, затем 0 | 767 тестов за 6 мин, 2 падения по срокам под нагрузкой хоста: `test_cinema_link…test_a_site_that_takes_too_long_is_cut_at_the_deadline_with_words` (8,5 с при пределе 5) и `test_cinema_net.DialTests.test_the_whole_timeout_still_bounds_all_attempts` (2,2 с при 0,6). Отдельно: 4/4 OK, выход 0 — не баги |
| ruff служб, как в CI | `ghcr.io/astral-sh/ruff:0.13.2 check cord_services/cinema sniffer tests/test_cinema*.py --line-length 110 --extend-select E501` | 0 | «All checks passed» |
| Плеер страниц (образ `--target test`, флаги CI) | `docker build -f services/sniffer/Dockerfile --target test`; `docker run --network none --read-only --tmpfs /tmp --shm-size 1g --memory 1536m --pids-limit 256 --cap-drop ALL --security-opt no-new-privileges:true` | **1** | сборка 0; 86 тестов (в волне качества — 78): 5 падений в `test_page` (разбор ниже) — **один настоящий баг (SNIF-1)**, один скрытый гонкой запуска (SNIF-2), три по нагрузке. Повторный полный прогон завис на SNIF-2 и убит (137) |
| `scripts/errors_registry.py --check` | из корня | 0 | реестр совпадает с ядром |
| `scripts/product-voice.mjs` | | 0 | «Голос продукта: чисто» |
| `node --test scripts/*.test.mjs` | те же пять файлов, что в CI (`configure`, `edge-config`, `product-voice`, `sign-catalog`, `turn-guard`) | 0 | 22 теста, 0 падений |
| `bash infra/csp-check.sh` | образ шлюза compose | 0 | 9 путей, рамка только у `/tg` |
| `scripts/sign-catalog.mjs verify` | | 0 | `servers.jws` подписан, seq 1, до 2027-04-18 |
| `python3 -I scripts/publish_windows_release_test.py` | | 0 | 5 тестов |
| `docker compose --profile monitoring config -q` | после `configure.mjs --app=… --ip=192.0.2.1`, как в CI | 0 | заодно `docker compose config --quiet` — 0 |
| Клиент: `npx tsc -p tsconfig.json --noEmit` | `desktop/` репозитория Windows | 0 | чисто |
| Клиент: `npx tsc -p tsconfig.test.json` | | 0 | чисто |
| Клиент: `npx vitest run` | | 0 | 12 файлов, 95 тестов |
| Клиент: `npm run build` | | 0 | `dist/` собран (оболочка, preload, ключи) |

Сверх списка, из того же `deployment-config` в CI (дёшево и стенда не трогают): `scripts/cohost_cutover_test.py` — 0;
`scripts/turn-relay-check.sh` — 0 (relay только к SFU, без правил — виден как дыра); `infra/sniffer-subnet-test.sh`
— 0; генератор панелей `infra/monitoring/grafana/dashboards.mjs` + `git diff --exit-code` по каталогу — 0 (панели
не разошлись с генератором).

**Не прогонялось:** Go-издатель (`golang:1.26`, образа нет на хосте, ядро Go не менялось); `docker compose build`
(перетёр бы теги образов запущенного стенда); `docker compose up` + `scripts/smoke.mjs` (стенд); проверки образов
VictoriaMetrics/vmalert/amtool (образов нет); `npm run generate:api` и e2e (нужен локальный стенд — E18).

## Что нашлось

### SNIF-1. Плеер страниц: при HLS, который проигрывает сам тег `<video>`, короткий ролик отдаёт кусочек вместо мастера — **продуктовый баг, не починен** (решение за Opus)

- Где: `services/sniffer/sniffer/capture.py:353–362` (`Catch.ranked`, функция `doubt` — первый ключ сортировки) и
  `capture.py:152` (`kind_of`: запрос вида `media` с типом `video/*` — это `file`). Внесён коммитом `3218149`
  («реклама с рекламных доменов… основной поток вместо преролла»); автор его браузерные тесты не гонял (журнал
  `2026-10-21-feature-tails.md`: «`test_page` — образ `test`, не гонялись»).
- Повтор: `docker build -f services/sniffer/Dockerfile --target test -t cord-sniffer-test .`, затем в контейнере
  с флагами CI `python -m unittest test_page.ThePlayerOfThePage.test_hls_the_video_tag_plays_itself_is_caught_too`
  (`-w /app`, `PYTHONPATH=/app:/tests`). На `HEAD` красный в **каждом из 5 прогонов, где дошло до проверки** (при
  нагрузке 2–10; ещё один прогон при нагрузке 21 упал раньше — `BrowserType.launch: Timeout 30000ms`); на
  образе из `3218149^` — 4 из 4 зелёные.
- Ждали: `found["streams"][0]["url"] == …/media/master.m3u8`. Получили: `…/media/144p_0.m2ts` (кусочек потока).
- Причина: страница играет HLS тегом `<video src=master.m3u8>` (Chromium 153 это умеет сам), и браузер просит у
  выхода кусочки `.m2ts` с типом `video/mp2t` видом `media` — плеер страниц записывает их как потоки `file`.
  До `3218149` их прятал порядок «hls раньше файла». Теперь первым ключом идёт сомнение (`doubt`), а длина
  `<video>` (`lengths`, у фикстуры ~6 с ≤ `PREROLL_SECONDS` = 60) применяется к любому потоку, в том числе к
  мастеру, который и есть `src` этого `<video>`: мастер получает сомнение 1, кусочек (длины у него нет) — 0 и
  встаёт первым. Без юнит-проверки: `Catch` с мастером (`hls`, `master=True`), `144p.m3u8` (`seconds=6.0`) и
  `144p_0.m2ts` (`file`); `ranked([master], {master: 6.0})` → `[144p_0.m2ts, master.m3u8, 144p.m3u8]`, при
  `lengths={}` и при 6000 с — мастер первым.
- Кого касается: страницы, где HLS играет сам тег (без hls.js — у hls.js `src` это `blob:`) и весь ролик не
  длиннее минуты. Длинные фильмы не затронуты. Но CI `deployment-config` («Verify the page player of the cinema»)
  красный из-за него.
- Кандидат на правку (**проверен в черновой копии, не закоммичен**): `lengths` применять только к потокам
  `file` — тогда длину HLS даёт его собственный список (`seconds`), а `<video>` — только файлу, что и сказано в
  описании `ranked` («по своему списку или по длине `<video>`»):
  `seconds = stream.seconds if stream.seconds is not None else lengths.get(stream.url) if stream.kind == "file" else None`.
  С ней в образе: `test_capture` целиком и `test_hls_the_video_tag_plays_itself_is_caught_too` зелёные. Другой путь —
  не считать кусочки HLS (`ts`, `m2ts`, `m4s`, `cmfv`…) потоками `file` в `kind_of`; он глубже, и выбор
  между ними — решение архитектора. Нужен юнит-тест в `services/sniffer/tests/test_capture.py` на связку
  «мастер + кусочек + `lengths`» (сейчас `lengths` проверяется только на файлах `pre.mp4`/`film.mp4`).

### SNIF-2. Плеер страниц: отмена страницы посреди холодного запуска браузера — тест краснеет, а процесс может не завершиться — **скрытая гонка, не от этой волны, не починена**

- Где: `services/sniffer/sniffer/page.py:246–260` (`sniff`, отмена), `:263–273` (`close`), `:276–292`
  (`_browser_ready`: `async_playwright().start()` и `chromium.launch()` под замком запуска). Не менялись с
  25.09.2026; `3218149` их не трогал.
- Тест: `test_page.Budget.test_a_page_given_up_closes_at_once` ждёт 1,5 с, отменяет страницу и проверяет
  `self.pages._browser.contexts == []`. Если за 1,5 с браузер ещё не запущен — `AttributeError: 'NoneType' object
  has no attribute 'contexts'`. На этом хосте холодный запуск Chromium дольше 1,5 с: отдельно тест красный 2 из 2
  при низкой нагрузке, в первом полном прогоне прошёл.
- Хуже самого красного: после этой ошибки процесс теста **не завершается** — второй полный прогон простоял 20 мин
  (потом `docker kill`, выход 137), отдельный прогон `test_page.Budget` — 400 с до убийства. Зонд (отмена на
  0,3 / 1,0 / 1,5 / 3,0 с после старта страницы, `pages.close()` с таймаутом 90 с): на 1,0 с и позже всё чисто
  (`close()` 0,1 с, процессов Chromium 0); на 0,3 с — браузера ещё нет (`_browser` — `None`, процессов Chromium 0), `close()`
  возвращается за 0,0 с, **а процесс не выходит** (убит по 300 с). Гипотеза, не проверена: отменённый
  `start()`/`launch()` оставляет драйвер Playwright (node) живым, и до него `close()` не достаёт. В журнале перед зависанием — поток строк
  «pipe closed by peer or os.write(pipe, data) raised exception». Причину дальше не разбирал.
- Почему это не только тест: в бою холодный запуск — после каждых 60 с простоя (`IDLE`, `_rest` → `_restart`), а
  страницу отменяет служба, когда человек отказался ждать. Отмена в первые секунды холодного запуска оставляет
  невидимый процесс до перезапуска контейнера. В CI зависший `docker run` — это срок задания (25 мин), а не
  красный тест.
- Править тест (ждать `_browser`, а не 1,5 с) — значит спрятать утечку; правка продукта — не очевидна
  (`asyncio.shield` запуска или остановка драйвера в `except CancelledError`), отдана Opus.

### Тесты, красные только под нагрузкой хоста, — не баги, не менялись

- Службы: два срока выше (отдельно 4/4 OK).
- Плеер страниц, один полный прогон: `test_page.Wall.test_a_browser_that_does_not_close_in_time_is_killed`,
  `Wall.test_a_page_that_hangs_its_own_thread_is_answered_within_the_budget` (14,8 с при пределе 10,5),
  `Wall.test_every_process_of_a_browser_with_a_stuck_renderer_is_killed` — отдельно зелёные.
- `test_page.Bounds.test_a_flood_of_playlists_reads_at_most_as_many_bodies_as_streams_are_kept`: ждёт 16 потоков из 180
  ответов за 5 с, под нагрузкой видит 0, 1, 2 или 10 (`found["streams"]` короче `STREAMS`). Сравнение образов
  до `3218149` и после на одной и той же нагрузке: красный у обоих (0 из 16 в обоих), зелёный у обоих при
  спокойном хосте — не от рекламы. Хрупкий по сроку, как и прочие `Wall`.

## Устаревших тестов нет

Ожидания, которые менялись эпиками намеренно (T14 `cinema.browse`, E14-B перевод `WATCH_INVALID`, T07 число карт),
уже поправлены волной качества и хвостами. Новые красные — только в плеере страниц и все объяснены выше.

## Что осталось на следующий проход

- SNIF-1 (правка — одна строка + юнит-тест) и SNIF-2 (решение по отмене запуска), потом повторить
  `docker build --target test` с флагами CI на спокойном хосте.
- e2e и нагрузка — E18.
