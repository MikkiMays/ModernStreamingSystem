# 2026-10-21 — хвосты функций (E07, E10-B, E06-B/A2)

Ветка `worktree-agent-a38ac737eddcb1d4c` от `main` (`92e5704`), в конце слита с `main` (`9b03452`). Исполнитель —
Opus 5.5 по заданию главной сессии, без субагентов. Работа шла с перерывом на предел использования: снимок на
середине главная сессия сохранила WIP-коммитом, он разобран на обычные коммиты. Решения — `DECISIONS.md` →
«хвосты функций» (FT-1…FT-6).

## Что сделано

1. **Кинозал, «Следующая серия»** (E07 «Осталось»):
   - Rutube и ivi — `details` серии отдаёт `next`: следующая бесплатная серия сезона, после последней — первая из
     следующих сезонов; сезон «Другое» отдельно; не дальше десяти страниц; ключи памяти — как у страницы сериала;
     сбой площадки — без `next`. Веб не менялся — плеер и так спрашивает `details.next` у любой площадки.
   - VK — **не сделано**: у ролика нет ни сезона, ни номера, ни плейлиста; деградация — кнопки нет, как и было
     (тест `test_cinema_vk.py::DetailsTests` держит страницу без `next`). Что понадобилось бы — в спецификации.
2. **Кинозал, реклама** (E07): разрывы `DISCONTINUITY` с хостов рекламных сетей прокси помечает `CUE-OUT`/`CUE-IN`
   (`cinema/ads.py`, `transport/playlists.py`); плеер страниц ставит рекламу и короткие прероллы последними и
   метит рекламу `ad`, служба её не пробует (`sniffer/capture.py`, `page.py`, `cinema/sniffer.py`,
   `providers/link.py`). `ads.py` копируется в образ sniffer (`services/sniffer/Dockerfile`); стена
   (`infra/sniffer-firewall.sh`) и изоляция не тронуты.
3. **client-report** (E10-B §15): браузер шлёт итог звонка (`media/call-quality.ts` из опроса буфера,
   `core/meeting.ts` — один раз: конец встречи, уход, `pagehide`, `keepalive`); ядро кладёт его суммами в
   `meeting_stats` (V12, `activity/ClientQuality.java`), метры `cord_client_*`; «Активность» → «Качество»
   (`GET /api/v1/admin/quality`, `ui/activity/QualityTab.tsx`).
4. **JOINING 30 с у бота музыки** (A2) — `music.present`; **`closedByServer`** — встреча, завершённая владельцем,
   не открывается из избранного до конца срока (`403 CLOSED_BY_SERVER {until}`, срок словами в вебе).
5. **Строки** — ru и семь языков (`activity.tabs.quality`, `activity.quality.*`, `api.closedByServerUntil`,
   `errors.CLOSED_BY_SERVER`).
6. **Доки** — спецификация кинозала («Хвосты»), `observability.md` §15, `abuse-model.md` §5 и §9 (A2 закрыто).

## Изменения контрактов (регенерацию делает интегратор)

- Новое REST: `POST /api/v1/rooms/{id}/client-report` (тело `ClientQuality.Report`: `seconds`, `rttMs?`,
  `lossPercent?`, `jitterMs?`, `bitrateKbps?`, `freezes`, `freezeSeconds`, `lossySeconds`, `path`, `codec?`;
  ответ `204`; отказы `403`, `404 ROOM_NOT_FOUND`, `429 RATE_LIMITED`).
- Новое REST: `GET /api/v1/admin/quality?from&to&tz` → `ActivityReport.Quality` (в вебе тип руками —
  `core/activity.ts`). `POST /api/v1/admin/rooms/{id}/close` — тело то же, `term` теперь задаёт и срок
  `closedByServer`.
- Новый код: `CLOSED_BY_SERVER` (403, `params: until`) — `contracts/errors.json` пересобран
  `scripts/errors_registry.py`, `ru.json` — `sync-errors.mjs`.
- Поле комнаты (снимок в базе, не в OpenAPI): `closedByServer` (Long, NON_NULL).
- Ответ плеера страниц службе (внутренний, не контракт): у потока необязательный `ad: true`.
- Миграция: **V12** `meeting_quality` — 16 столбцов в `meeting_stats`. Новых ключей `.env` нет.

## Проверки

- Службы (образ `modern-streaming-services`, код смонтирован только для чтения, `--network none`):
  `test_cinema_rutube test_cinema_ivi test_cinema_ads test_cinema test_cinema_sniff test_cinema_vk
  test_cinema_link test_services` — 418/418 OK, выход 0. Раньше в общем прогоне под нагрузкой хоста упал
  временной тест `PlaylistLimits` (2,7 с при пороге 2 с); отдельно при нагрузке 0,3 — 10/10 OK.
- Плеер страниц (образ `modern-streaming-sniffer`, `sniffer/` и `ads.py` смонтированы, `--network none`):
  `discover -s /tests -p test_capture.py` — 31/31 OK, выход 0 (браузерные `test_page` — образ `test`, не гонялись).
- ruff (CI-набор: `cord_services/cinema sniffer tests/test_cinema*.py --line-length 110 --extend-select E501`) —
  «All checks passed», выход 0; `music.py`, `test_services.py` — чисто.
- Ядро (docker Maven офлайн): `fmt:check test -Dtest=ActivityTest,ArchitectureTest` — 16/16, BUILD SUCCESS, выход 0.
- Реестр ошибок `--check` — 0 (141 код), `sync-errors --check` — 0, `check.mjs` — 162 при базе 162 (0),
  `coverage.mjs` после слияния `main` — 0 (2402/2402 у всех семи языков; до слияния падал на 48 ключах E01-B2,
  которые `main` перевёл в `bf46cb7`).
- Веб: `tsc -b` — 0 (после слияния); vitest (`--pool=forks --maxWorkers=1`) по тронутому — `media/call-quality`,
  `core/meeting`, `ui/activity`, `api/client`, `media/playout-control`, `media/session`, `i18n/coverage`,
  `i18n/i18n`, `ui/cinema/theater` — 171 тест: 170 зелёных и один старый красный в `api/client.test.ts` (ждал,
  что `WATCH_INVALID` по-английски не переведён, а E14-B его перевёл). Тест поправлен на код, которого нет в
  каталоге, — 7/7, выход 0; `prettier --check` по тронутому — чисто.

## Что не проверено

- Живой прогон: итог звонка с настоящей встречи и вкладка «Качество» на стенде; реклама в настоящих потоках
  сайтов «по ссылке» (фикстуры — по форме SSAI, не записи сайтов); «Следующая серия» Rutube/ivi вживую (ivi из
  Германии бесплатного не отдаёт вовсе).
- Полные наборы тестов ядра, служб и веба — финальная волна.
