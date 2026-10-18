# План E07: плеер кинозала (T17, T19, T20)

Спецификация — `docs/superpowers/specs/2026-10-19-cinema-player.md`. Каждый шаг — сначала падающий
тест, потом код, потом прогон тронутых тестов (`npx vitest run <файлы> --pool=threads
--testTimeout=60000`, Python — в контейнере с `--network none`) и маленький коммит.

## 1. T19 — бездействие

- `web/src/ui/cinema/theater/WatchTheater.test.tsx`: через 2,6 с после `loadedmetadata` у
  `.watch-theater` `data-idle="true"`, у `.watch-chrome` нет `data-shown`; `pointermove` возвращает.
- `WatchTheater.tsx`: `IDLE_MS = 2500`. `theater.css`: снять `.watch-chrome:focus-within` из правил
  видимости и нажатий. Коммит.

## 2. T20 — клавиши плеера

- `theater/watch-keys.test.ts` → `theater/watch-keys.ts`: `watchKey(event, context)` → действие или
  подсказка; `focusKind(target)` (текст/ползунок/кнопка/прочее).
- `theater/useWatchKeys.ts`: слушатель `keydown` на окне, пока плеер открыт; вызывает `command`,
  `skip`, громкость, звук, полный экран; подсказка на 2 с (`.watch-hint`).
- `WatchTheater.test.tsx`: пробел → `watch.play`, → → `watch.seek` на +10 с; без права — подсказка.
- `Chrome.tsx`: громкость «без звука/вернуть» — общей функцией `muteToggle` (клавиша M и кнопка). Коммит.

## 3. T20 — стрелки в каталоге

- `catalog/arrow-nav.test.ts` → `catalog/arrow-nav.ts`: `arrowTarget({key, index, count, columns})`
  и обработчик `arrowNav` (фокус на `.cinema-open` соседней плитки).
- `Shelf.tsx`, `tiles.tsx` (`Grid`): `onKeyDown={arrowNav}`. Коммит.

## 4. T17 — удалить историю

- `core/cinema/link.test.ts` → `forgetLink`.
- `LinkScene.test.tsx` → крестик у ссылки и «Очистить всё» → `saveSettings({cinemaLinks})`.
- `LinkScene.tsx`, `cinema.css` (`.cinema-link-recent`). Коммит.

## 5. T17 — сезоны

- `services/tests/fixtures/link/show-seasons.raw.json`, `test_cinema_link.py::Seasons`.
- `providers/link.py`: `_episode` читает `season_number`/`episode_number`; `series()` — сезоны,
  фильтр, значки, 404 на чужой сезон.
- `LinkScene.tsx`: сезон в состоянии и в ключе запроса; тест. ruff. Коммит.

## 6. T17 — следующая серия

- `test_cinema_link.py::Seasons` → `details()["next"]`; `wire.details(next=…)`.
- Веб: `CinemaDetails.next`, `theater/useNextEpisode.ts`, кнопка в `Chrome` и плашка в конце;
  `WatchTheater.test.tsx`. Коммит.

## 7. T17 — реклама

- `theater/ad-breaks.test.ts` → `theater/ad-breaks.ts`: `adBreaks(fragments)`, `adSkip(...)`,
  `adLeader(...)`.
- `engines/hls.ts`: `enableInterstitialPlayback: false`, `LEVEL_LOADED/UPDATED` → `callbacks.breaks`.
- `usePlayback.ts` → `breaks`; `WatchTheater.tsx` — автопропуск ведущим, «Пропустить рекламу», «+85 с»
  в `Chrome`. Коммит.

## 8. e2e и проверка

- `web/e2e/cinema-link.spec.ts`: удаление одной и всех недавних ссылок.
- `web/e2e/watch-keys.spec.ts`: два зрителя, пробел у одного → пауза у второго, курсор `none` через 3 с.
- `npx prettier --check`, `npx tsc -b` (в фоне), vitest по тронутым файлам, Python-тесты кинозала, ruff.
