# Состояние сессии — точка возобновления (19.10.2026)

Этот файл — для следующего «меня» после `/compact` или перезапуска. Где что лежит и что идёт.

## Ветки (всё локально — пуш ждёт `gh auth login` владельца, OWNER-ACTIONS №1)

| Репо | Ветка | Что |
| --- | --- | --- |
| ядро | `main` = a7ed543 | E00 + E01-B0 (T56 веб) + марка SVG (T24/T01 веб) + исследования E11-A/E12/E09/E16-4a |
| ядро | `epic/E05-media` (от main) | T38 (`web/src/core/room-cues.ts` + тест, подключено в `meeting.ts`), T49 (`web/src/media/volume.ts` + тест, подключено в `ui/Stage.tsx`) — **не закоммичено на момент записи**, проверки в `/opt/.cord-work/e05a-check.log` |
| Windows | `epic/E01-B0-quick-wins` = fe97a78 поверх `epic/E01-A-electron-adr` = 81f8b6f поверх `main` 0d5c2fa | ADR Electron; выпуск 0.7.6: марка в шапке (T01), ПКМ без Edge (T42), ярлык по умолчанию (T15), обновления только с зеркала (T56). Тесты Cord.Core 52/54 (2 — DPAPI, только Windows), `dotnet format` чист. XAML проверит CI |

## Субагенты в работе (worktree `ModernStreamingSystem/.claude/worktrees/agent-*`)

- E06-A права (`epic/E06-A-permissions`): матрица в ядре, `you.can` в снимке, служба спрашивает ядро, T14.
- E07 кинозал (`epic/E07-cinema`): T17/T19/T20.
- E08 игры (`epic/E08-games`): T51, T07, T45 (звуки Kenney CC0 + синтез), T11.
- E10-A исследование наблюдаемости → `docs/observability.md` (файл уже есть, ждём отчёт, не коммитить до него).
После отчёта: прочитать дифф ветки, ревью, слить в `main` (`--ff-only` или merge), перегенерировать
`contracts/openapi.json` + `web/src/api/generated.ts`, если две ветки их тронули.

## Стек на стенде

Сборка: gateway ✔, services ✔, sniffer — в процессе, core — повтор с `COMPOSE_BAKE=false` (первый раз
упал на сбое BuildKit). Журнал — `/opt/.cord-work/stack-build.log`. После сборки: `sudo ./setup.sh
--domain cord.nikg.tech --ip 108.165.32.75` (`.env` уже есть и сохранится; поставит ufw, таймер уборки,
стену sniffer, поднимет стек, выпустит сертификат) → смоук → e2e против `https://cord.nikg.tech`.

## Дальше по плану (моя очередь)

1. Закоммитить E05 T38/T49 → T44/T48 (качество из `application.yml` → `capabilities`, без «Авто» и 1440,
   миграция сохранённых настроек, демонстрация показывается зрителям после кадра целевого качества —
   `screen.started` уже есть в командах) → T06/T52 в ядре (после слияния E06-A: конфликт в RoomService).
2. E16: токены, примитивы, `FullscreenLoader` (спека `docs/superpowers/specs/2026-10-19-fullscreen-loader.md`),
   хук ширины панелей (T46), витрина.
3. E14-A: слой переводов (решение о библиотеке в DECISIONS), вынос строк.
4. E15-A: Figma «как есть» (файл https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA).

## Машина

Steal 25–60 %, load 20–45. Монитор — `/opt/.cord-work/health.log` (раз в 2 мин). vitest — только
`--pool=threads --testTimeout=60000` (форки не успевают стартовать). Своп 4,5 ГБ.
