# 2026-10-21 — плеер страниц: SNIF-1 и SNIF-2 после регрессии

Ветка `fix/sniffer` от `main` (`f37041a`, «Журнал регрессии 21.10…»). Исполнитель — Opus 5.5 по заданию главной
сессии. Рабочее дерево агента оказалось в репозитории Windows, а создать дерево в `ModernStreamingSystem`
изолированному агенту не дали — поэтому ветка лежит в репозитории `ModernStreamingSystem.Windows` (история —
`main` ядра, как у `regression-wave`): `git fetch /opt/ModernStreamingSystem.Windows fix/sniffer:fix/sniffer`.
Тронут только `services/sniffer` (код и тесты); общий `cinema/ads.py` и `cord_services` не тронуты, стена
(`infra/sniffer-firewall.sh`) и изоляция — тоже. Решения — `DECISIONS.md` → «правки плеера страниц» (SNIF-1,
SNIF-2). `STATUS.md` не тронут, пуша и выкатки нет.

## SNIF-1. Кусочек HLS вместо мастера (`0b0156c`)

**Причина** — подтверждена зондом на `native.html`. Chromium 153 играет HLS сам: тег `<video src=master.m3u8>`
спрашивает `master.m3u8`, варианты и **сегменты** видом `media`, а `kind_of` считал всякий `media` с `video/*`
готовым файлом. В улове страницы было 9 потоков: 6 кусочков `.m2ts` видом `file` и 3 списка HLS. До `3218149`
их прятал порядок «HLS раньше файла»; после — первым ключом идёт сомнение, а длина `<video>` (`lengths`,
у фикстуры 6–12 с ≤ 60) применялась и к мастеру — он получал сомнение 1, кусочек без длины — 0.

**Решение — оба пути, (б) и (а)** (`DECISIONS.md` SNIF-1):

- (б) кусочек — не файл ни при каком запросе. `capture.py:168` (`kind_of`): TS и фрагменты fMP4/CMAF
  (`SEGMENT_EXTENSIONS`/`SEGMENT_TYPES`, `capture.py:75`: `ts`, `m2ts`, `mts`, `m4s`, `cmfv`, `cmfa`;
  `video/mp2t`, `audio/mp2t`, `video/iso.segment`) — `None`. `.mp4` и `.aac` бывают и файлом, и кусочком
  (fMP4-сегменты, `EXT-X-MAP`, упакованный звук) — их отличает только прочитанный список: `playlist_pieces`
  (`capture.py:251`) достаёт адреса кусочков списка сегментов (строки, `URI` у `EXT-X-MAP`/`PART`/
  `PRELOAD-HINT`), `Catch.listed` (`capture.py:372`) их помнит (до `PIECES` = 4096) и убирает файлы,
  пойманные раньше списка (ответы идут разом); `wants`/`stream` таких файлов больше не принимают. В
  `page.py:505–509` список, прочитанный ради мастера и длины, отдаёт и свои кусочки. Без (б) кусочки занимали
  места улова (16): кусочки преролла, который тег играет сам, могли занять их все раньше мастера фильма.
- (а) длина `<video>` — только файлу (`capture.py:420–425`, `Catch.ranked.doubt`). У HLS сомнение — по его
  собственному списку. Иначе мастер, который тег играет сам, встаёт за свои же варианты, чьи списки не
  прочитаны (нет `Content-Length`, не успели за `BODY_WAIT`) — служба взяла бы вариант без лестницы
  качества; и за файл-преролл, который уже не играет. FT-3 не меняется.

**Тесты.** `test_capture.py`: `test_a_short_master_the_video_tag_plays_itself_stays_first` (мастер,
кусочек и `lengths` — случай SNIF-1, плюс `.mp4`-кусочек, который прошёл бы файлом; `lengths` 6 с, пусто, 6000 с),
`test_the_length_of_the_tag_does_not_put_a_master_behind_its_own_variant`,
`test_a_piece_the_video_tag_asks_for_itself_is_not_a_file`, `test_a_list_names_its_pieces_and_a_master_names_none`,
`test_a_file_the_list_names_as_its_piece_is_not_kept`. Все пять красные на коде `f37041a` (3 FAIL, 2 ERROR),
`test_capture` — 36/36 на новом. `test_page.test_hls_the_video_tag_plays_itself_is_caught_too` теперь ещё
проверяет, что в улове только HLS (кусочков нет); зонд на новом коде — `master.m3u8`, `144p.m3u8`, `180p.m3u8`.

## SNIF-2. Отмена посреди холодного запуска (`2c7353c`)

**Причина — подтверждена** (зонд: отмена через 0,3 с, `faulthandler` по `SIGUSR1`, список процессов
контейнера). Отмена страницы отменяла `async_playwright().start()` внутри `_browser_ready`: Playwright
создаёт свою задачу `Connection.run()` и запускает драйвер (node) **до** того, как `start()` вернёт объект, —
`_playwright` оставался `None`, и `close()` закрывать было нечего (0,0 с). Ничейными оставались драйвер
(процесс `…/playwright/driver/node … run-driver` жив) и задачи `Connection.run` и `init`. При закрытии цикла
теста `asyncio.Runner` отменяет все задачи разом: отменённый `init` шлёт драйверу `__abort__` и ждёт ответа
без срока, а читатель ответов (`Connection.run`) отменён тем же махом — `_cancel_all_tasks` ждёт вечно
(стек: `runners.py:206 _cancel_all_tasks` ← `async_case.py:127 _tearDownAsyncioRunner`). Отмена посреди
`chromium.launch()` (≥ 1 с в журнале регрессии) — чистая и на старом коде: драйвер уже у `Pages`, и
`__abort__` ему доходит. `AttributeError` в `Budget` — отдельная хрупкость теста: 1,5 с меньше холодного запуска.

**Правка** (`page.py:289–301`, `close` — `page.py:267–286`): запуск — своя задача `_launch` (`_launched`,
бывшее тело `_browser_ready`), страница ждёт её через `asyncio.shield`. Брошенная страница перестаёт ждать
сразу (место в выходе свободно), а запуск доходит до конца: драйвер и браузер остаются у `Pages`, их
закрывают `_rest` (после `IDLE`) и `close()`. `close()` дожидается начатого запуска не дольше `LAUNCH` +
`TEARDOWN` (`LAUNCH` = 30 с — тот же срок, что у `chromium.launch`); не дождался — отменяет с
предупреждением (патология: драйвер не стартует полминуты). Закрывать полузапущенный Playwright через его
внутренние поля (`_connection`, `_transport`) не стали — хрупко на обновлениях Playwright.

**Тесты.** `Budget.test_a_page_given_up_closes_at_once` бросает страницу, когда сайт уже отдал её браузеру
(хит `/pages/empty.html`), а не через 1,5 с наугад, — проверка вкладки и места та же; брошенную посреди
запуска проверяет новый `Launch`. `Launch` (`test_page.py`) — отдельным процессом (`subprocess.run` с пределом
`LAUNCH + 4·TEARDOWN + 30` с): ребёнок `given_up_while_starting` бросает страницу, пока стартует драйвер
(`driver`: процесс `run-driver` есть, `_playwright` ещё `None`) и пока стартует Chromium (`browser`), потом
`close()`; ждём: отмена < `TEARDOWN`, место свободно, `close()` < `LAUNCH + 2·TEARDOWN`, новых драйверов и
Chromium — 0, задач цикла — ни одной, процесс вышел сам с кодом 0. Не вышел — тест красный (ребёнок убит,
его драйвер и браузер добиты), а не висит до срока CI. На старом `page.py` (`f37041a` + константа `LAUNCH`):
`driver` — FAIL (драйвер жив после `close()`), `browser` — ok, как и предсказано выше.

## Проверка

Образ — как в CI (`docker build -f services/sniffer/Dockerfile --target test`, свой тег
`cord-sniffer-test:snif`, чтобы не трогать чужие), запуск — флаги CI (`--network none --read-only --tmpfs /tmp
--shm-size 1g --memory 1536m --pids-limit 256 --cap-drop ALL --security-opt no-new-privileges:true`). Хост
общий: нагрузка скакала от 0,5 до 14,6 (соседние сессии).

| Прогон | Нагрузка (1 мин) | Выход | Итог |
| --- | --- | --- | --- |
| предварительный (до проверки «только HLS» в `native`) | 2,6 → 1,2 | 0 | 93 теста OK, 217 с |
| 1-й полный, итоговый образ | 0,9 → 0,6 | **0** | 93 теста OK, 177 с |
| 2-й полный | 0,5 → 4,5 (всплеск до 8) | **1** | 91 ok, 2 FAIL: `ThePlayerOfThePage.test_a_player_that_waits_for_a_click_gets_exactly_one`, `Walls.test_popups_and_new_tabs_never_open` — `clicked` False |
| 3-й полный | 1,6 → 3,3 | **1** | 91 ok, 2 FAIL: `ThePlayerOfThePage.test_a_video_with_browser_controls_is_started_by_its_own_play_button` (`clicked` False), `Wall.test_every_process_of_a_browser_with_a_stuck_renderer_is_killed` |

Во всех прогонах `Launch` (оба), `Budget` (все пять) и `test_hls_the_video_tag_plays_itself_is_caught_too` —
зелёные, зависаний нет.

**Красные по нагрузке — не от этих правок.** Срок страницы в тестах (`SECONDS` = 10 с) считается с начала
`_visit` и включает холодный запуск браузера, а нажатие бывает, только если после `LOOK` осталось больше
`FINISH + 1` = 4 с. Замер холодного запуска на `click.html`: 0,8–1,0 с на спокойном хосте и 2,4–8,4 с во
всплеске — тогда нажатия нет ни на старом образе, ни на новом. Сравнение через раз (`ThePlayerOfThePage` +
`Walls` + `Wall`, 16 тестов, старый и новый образ по очереди): старый — 6, 1 и 2 красных, из них сверх
самого SNIF-1 — 5 и 1 (`popups`, `away`, `controls` без нажатия, `Wall` ×2, кукис-тест); новый — 1 (ERROR
кукис-теста при нагрузке 14,6), 1 (`Wall`), 0. Отдельно `ThePlayerOfThePage` + `Walls` на новом образе — 3 из 3 OK при нагрузке до 8. Семейство «нажатия»
— того же рода, что `Wall`/`Bounds` из журнала регрессии.

- ruff как в CI (`ruff:0.13.2@sha256:bc3a…`, `check cord_services/cinema sniffer tests/test_cinema*.py
  --line-length 110 --extend-select E501`) — «All checks passed», выход 0.
- Юнит-тесты служб не гонялись: общий код (`cinema/ads.py`, `cord_services`) не менялся.

## На заметку

- Тесты «нажатия» и `Wall` хрупки по сроку из-за холодного запуска внутри срока страницы. Если CI будет
  краснеть ими, честная правка — греть браузер в `asyncSetUp` этих классов, а не растягивать `SECONDS`.
- Каждый ребёнок `Launch` оставляет в контейнере теста два зомби (процессы Chromium, перешедшие к PID 1 —
  у образа `test` нет `tini`); то же делают и браузеры прочих тестов. На `--pids-limit 256` не влияет.
