---
name: cord-verify-ui
description: Use when a Cord web UI change needs visual proof (before/after screenshots, both themes, phone and desktop widths), when checking for horizontal overflow or clipped layout, or when an epic asks for screens/Exx/before|after.
---

# Проверка вёрстки Cord

«Тесты зелёные» вёрстку не доказывают. Доказательство — снимки до/после на одних и тех же ширинах и темах
и ноль горизонтального переполнения.

## Снимки

```bash
cd "$CORD_ROOT/ModernStreamingSystem/web"
node scripts/shots.mjs --base https://cord.nikg.tech --out ../backlog/screens/E04/before \
  --screens meeting,settings --widths 320,390,768,1024,1280,1440,1920 --themes light,dark
```

- Экраны — ключи `SCREENS` в `scripts/shots.mjs` (`home`, `download`, `prejoin`, `settings`, `meeting`);
  новый экран — новая функция там же, а не разовый скрипт.
- `report.json` рядом со снимками: `overflowX` (= `scrollWidth - clientWidth`) и до 8 элементов за правым
  краем. Скрипт печатает только плохие строки. Цель — пусто.
- `backlog/screens/` в git не идёт; в журнал эпика — пути и итоговую строку скрипта.
- Столы игр — ещё 2560×1440 (`--widths 2560`).

## Чего ждать от браузера

- Подключение к серверу идёт само: ждать «Новая встреча», не нажимать «Подключиться».
- Встречу ждать по `[data-media-status="connected"]` (или по «В эфире», пока бейдж не убран, E02).
- Base UI кладёт меню и диалоги в портал `body` — искать их на странице, не внутри компонента.
- Пульт плеера засыпает за 2,8 с — `hover()` перед нажатием.
- Скрипты с `@playwright/test` — только внутри `web/` (резолв от файла).

## Глазами

После снимков — посмотреть хотя бы 390 и 1440 обеих тем (Read по PNG) или отдать субагенту список
снимков с вопросом «что криво». Переполнение в 0 px не значит «красиво».

Живая проверка медиа (два браузера, getStats) — скилл `cord-live-call`.
