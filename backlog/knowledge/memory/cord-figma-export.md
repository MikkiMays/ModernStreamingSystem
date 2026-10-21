---
name: cord-figma-export
description: Как экраны Cord попадают в Figma-файл продукта и на чём там спотыкаешься — план Starter, запрет захвата в слои, кадры по ссылкам upload_assets
metadata:
  type: reference
---

Файл продукта — https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA (E15-A, 20.10.2026). Снимки
снимает `web/scripts/figma-screens.mjs` против стенда, в Figma их кладут `figma-build.mjs` (код
для `use_figma`) и `figma-upload.mjs` (POST в ссылки `upload_assets`), перечень — `docs/screens.md`.

**Why:** на первом заходе ушли часы на то, что выглядит как «просто выгрузить»:

- План Starter даёт **три страницы** на файл: четвёртый `figma.createPage()` падает. Разделы
  живут секциями на одной странице.
- `generate_figma_design` (захват страницы в слои) внедряет внешний `capture.js` Figma в страницу
  Cord — среда сессии такое запрещает. Остаются PNG в кадрах и свои слои (`use_figma`).
- `upload_assets` с `nodeIds` кладёт картинку заливкой в готовый кадр; ссылки одноразовые и живут
  10 минут, до 60 за вызов. Порядок ссылок = порядок `nodeIds`, поэтому `figma-build --plan`
  пишет порядок файлов, а загрузчику хватает uuid ссылок.
- Снимок «во всю страницу» врёт на окнах и меню: фиксированная подложка покрывает только исходную
  высоту окна. Окна снимаются экраном, а размер кадра берётся из PNG, не из `innerHeight`.
- Картинку в другом месте файла (флоу, «до/после») не грузят заново: берут `imageHash` кадра
  страницы «Как есть», найденного по имени `id / ширина / тема` (`page.loadAsync()`).

**How to apply:** перед правкой файла — `create_session`, чтение структуры, три страницы не
трогать. Снять заново: `node --experimental-transform-types scripts/figma-screens.mjs --only …`
(флаг нужен для записанных ответов кинозала из `e2e/support/cinema.ts`), затем пересобрать ряд
`figma-build --rows …` — ряд встаёт на своё место. Шахматы: кто открыл доску, тот уже за белыми;
место чёрных у второго — через `dispatchEvent('click')`, кнопку закрывает липкая шапка.

**E15-B (21.10.2026): карта продукта слоями.** Четыре файла в drafts (ключи — `web/scripts/screens-doc.mjs`,
`KEYS`). Путь: `figma-screens.mjs --svg --toggle-theme` (SVG из DOM — `dom-svg.mjs`) → `upload_assets` →
`figma-svg-upload.mjs --latest --plan <страница>` (UUID берёт из журнала сессии, `CLAUDE_TRANSCRIPT`) →
код `figma-layers.js` и `figma-place.js` в `use_figma`. Пределы Starter: одна мода у коллекции (темы — две
коллекции), нет библиотеки, предел вызовов MCP в сутки, REST 429 на `depth≥4`. Встречи на стенде — не больше
одной на сценарий: антибот E11-B считает 10 новых в час с адреса, общий для всех агентов машины. Имена файлов для
выгрузки — только латиницей: multipart-имя с кириллицей Figma читает как Latin-1.
