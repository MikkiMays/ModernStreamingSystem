---
name: cord-worktree-kit-shots
description: "Почему в worktree Cord dev-сервер рисует запасной шрифт и почему колонка другой темы на /kit врёт про поля"
metadata:
  type: project
---

Две ловушки, на которых E06-B (20.10.2026) терял снимки интерфейса без встречи.

- **Шрифт Inter не грузится на dev-сервере в worktree.** В рабочих копиях `.claude/worktrees/*` каталог
  `web/node_modules` — ссылка на общий `/opt/ModernStreamingSystem/web/node_modules`. Vite не отдаёт файлы вне
  своего корня (`server.fs.allow`): в журнале «… is outside of Vite serving allow list», шрифт падает на запасной,
  и снимки похожи на вёрстку, но не на Cord. Лечится локальным конфигом в `web/.local/` (в git не идёт):
  `mergeConfig(base, { server: { fs: { allow: [<корень web worktree>, '/opt/ModernStreamingSystem/web/node_modules'] } } })`
  и `npx vite --config .local/<файл>`. Сборка (`vite build`) этим не страдает.
- **На `/kit` колонка «не той» темы показывает поля в теме страницы.** Компонентные токены (`--field-bg`,
  `--field-line`, `--menu-bg` …) объявлены только на `:root` в `styles/tokens.css` и считаются там один раз; в
  колонке с `data-theme='dark'` при светлой странице `.ui-input` и поля остаются светлыми, а текст в них —
  светлым из тёмной темы, то есть невидимым. В приложении тема одна (на `:root`), так не бывает. Снимать
  колонку той же темы, что у страницы (`shots.mjs` ставит `cord:theme` — экран `kit-integrations` так и делает).

Ещё: липкая шапка `/kit` (`.kit__bar`) ложится поверх снимка элемента; CSS набора приезжает отдельным чанком
после вставленного стиля, поэтому переопределять её в снимке — только с `!important`.
