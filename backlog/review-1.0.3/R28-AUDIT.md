# R28, проход 2 — аудит размеров экранов

Задача владельца (R28): «Кривые объекты не по размеру между собой — одни тоньше, другие толще (обводки, кнопки,
иконки)». Проход 1 (`768aef9`) дал шкалу и набор: `--hairline`/`--hairline-strong`, `--icon-sm/md/lg`,
`--icon-stroke`, `Button`/`IconButton` 16/20/24. Проход 2 — сами экраны: всё, что в CSS и TSX стоит числом мимо
шкалы, переводится на токены и набор. Экраны не перерисовываются — меняются только размеры, чтобы одинаковые вещи
были одинаковыми.

Таблица ниже собрана сканером по `web/src/**/*.css` и `web/src/**/*.tsx` на `main` (`34ca6cb`) до правок:
файл, строки, что, было → предложение. «По месту» — решение принимается по соседям (в кнопке 36 значок 20, в строке
текста 16). Итог по каждому месту — в разделе «Сделано» в конце; то, что оставлено своим числом, перечислено в
списке исключений теста `web/src/styles/sizes.test.ts`.

## Шкала (DESIGN.md → «Шкала размеров»)

| Что | Значения | Токены |
| --- | --- | --- |
| Волосок, разделитель, рамка поля | 1 | `--hairline` |
| Акцентная линия: рейка, индикатор, выбранная плитка, рамка «моего» | 2 | `--hairline-strong` |
| Кольцо фокуса (клавиатура) | 2, отступ 2 / внутрь −2 | `--focus-outline`, `--focus-offset`, `--focus-offset-inset` |
| Ореол поля в фокусе (состояние поля, не кольцо) | 3, акцент 28 % | `--field-halo` (новый) |
| Кольцо голоса, ступени 1–4 | 2 / 2,5 / 3 / 3 | `--voice-ring-1..4` (новые) |
| Значки интерфейса | 16 / 20 / 24; в плашке 20 и строке мелкого текста — 12 | `--icon-sm/md/lg`, `--icon-xs` (новый) |
| Значки-иллюстрации (пустые состояния, заглушки) | 32 / 40 | `--icon-xl`, `--icon-2xl` (новые) |
| Высоты элементов | 28 / 32 / 36 / 40 / 48, касание 44 | `--control-xs/sm/md/lg/touch`, `--touch-target` |
| Радиусы | 4 / 6 / 8 / 12 / 16 / 20 / full | `--radius-1`, `--radius-0`, `--radius-2..5`, `--radius-full` |
| Зазоры | 2 / 4 / 8 / 12 / 16 / 20 / 24 / 28 / 32 / 40 / 48 / 64 | `--space-0-5` (новый, 2 — внутри сегмента и стопки «заголовок + подпись»), `--space-1..16` |

## Правила замены

- `border`/`outline` 1 px (и 0,5 / 1,5) → `var(--hairline)`; 2 px и рейки 3–4 px → `var(--hairline-strong)`. Рамка
  остаётся рамкой (размеры коробки не меняются); перевод рамок в тени — не здесь.
- Кольца тенью `0 0 0 Npx`: 1 → `--hairline`, 2 → `--hairline-strong`; ореол поля `0 0 0 3px` акцента 22–28 % и
  `--accent-soft` → `--field-halo`; кольца голоса → `--voice-ring-*`.
- `outline-offset` числом → `--focus-offset` / `--focus-offset-inset`.
- Значки lucide: размер по элементу. В `IconButton` и `Button` набора — по размеру кнопки (sm 16, md 20, lg 24 — так
  их и рисует `kit.css`); в строке текста и меню — 16; мелкий текст (`--text-xs`) и плашка 20 — 12; иллюстрации
  26–34 → 32, 40–42 → 40. Нечётных и промежуточных (11, 13, 14, 15, 17, 18, 19, 21, 22, 23, 26, 28, 30, 34) нет.
  `strokeWidth` — только у рисунков Gartic с `data-own-stroke`.
- Кнопки: свои высоты 33/34/38/42/46/54 → ближайшая из `--control-*`; старые `.button` (48, радиус 12) и
  `.icon-button` (48×48, радиус 12) получают метрики набора: высота `--control-md`, радиус `--control-radius`,
  значок `--icon-md`, вес `--weight-medium`. Перекраски столов (золото покера и т. п.) остаются.
- Свои переключатели покера и дурака (`.poker-toggle i`, `.durak-toggle i`, X4) — размеры `kit/Switch`: 40×24,
  бегунок 18.
- Зазоры: число со шкалы → токен; мимо шкалы — к ближайшему шагу, при равенстве вниз (стол не вылезет за край), кроме
  6 в строке «значок + подпись» → 8, как у `Button` и вкладок набора; `gap: 1px` — это волосок.
- Иллюстрации столов (сукно, карты, кромка колоды, клетки доски, бегунок полосы прокрутки, «стрелка» подсказки)
  рисуются своими толщинами — они в списке исключений теста с причиной.

## Главные расхождения (видно глазами)

| Где | Было | Стало |
| --- | --- | --- |
| Старая кнопка `.button` (столы, кинозал, приглашение, обрезка картинки) | 48, радиус 12, вес 600, зазор 10 | 36, радиус 8, вес 500, зазор 8 — как `Button md` |
| Старая кнопка-значок `.icon-button` (столы, плеер кинозала, каталог) | 48×48, радиус 12, свои 33/34/38/42/46/54 | 36 / 32 / 40 / 48 по шкале, радиус 8 |
| Старое окно `.modal` (настройки игр, приглашение, обрезка, избранное) | радиус 20, рамка 1, поле 24, шапка 48 | радиус 16 и поле 24 как у `Dialog`, крестик 36 |
| Глобальное поле `:where(input, select, textarea)` | 48, радиус 12, поле 12/14 | 40 (`--control-lg`), радиус 8, поле 12 — как `Input` |
| Ореол поля в фокусе | 3 px с акцентом 22 % (чат), 28 % (поиск, набор), `--accent-soft` (имя комнаты) | один `--field-halo` |
| Кольцо голоса | панель 1,5/2/2,5/3, плитка 2/2/3/3, игры 2 и 3 | `--voice-ring-1..4` везде |
| Значки | 25 размеров: 11–23, 26–42 | 12 / 16 / 20 / 24 и 32 / 40 |
| Рейки слева у плашек (шахматы, Gartic, ход стола) | 3 и 4 | 2 (`--hairline-strong`) |
| Переключатели покера и дурака | 23/17, 24/16 | 24/18, как `Switch` |

## Счёт по видам (до правок)

| Вид | Мест |
| --- | --- |
| зазор | 355 |
| размер значка | 265 |
| рамка/линия | 134 |
| высота элемента | 105 |
| кольцо тенью | 64 |
| отступ кольца | 8 |
| радиус | 7 |
| толщина значка | 6 |
| обводка | 3 |
| **всего** | 947 |


## Места (до правок)

Файлы — от `web/src`. Строки — на `34ca6cb`.

#### `accessibility.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 26 | высота элемента | `min-width: 48px` | `min-width: var(--control-touch)` |
| 27 | высота элемента | `width: 48px` | `width: var(--control-touch)` |
| 28 | высота элемента | `height: 48px` | `height: var(--control-touch)` |

#### `chess.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 8 | зазор | `gap: 14px` | `gap: var(--space-3)` |
| 27, 30, 295 | зазор | `gap: 12px` | `gap: var(--space-3)` |
| 42, 425 | зазор | `gap: 3px` | `gap: var(--space-0-5)` |
| 93 | отступ кольца | `outline-offset: -3px` | `var(--focus-offset-inset)` |
| 111 | кольцо тенью | `box-shadow: inset 0 0 0 3px var(--chess-focus)` | проверить на месте |
| 135 | рамка/линия | `border: 4px solid color-mix(in srgb, var(--chess-ink-dark) 58%, transparent)` | своя толщина рисунка → исключение |
| 206, 300, 458 | зазор | `gap: 9px` | `gap: var(--space-2)` |
| 216 | рамка/линия | `border: 1px solid var(--muted)` | `var(--hairline) solid var(--muted)` |
| 235, 361, 463, 554, 658 | зазор | `gap: 8px` | `gap: var(--space-2)` |
| 266, 564 | рамка/линия | `border: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 352, 499, 561, 622, 655 | зазор | `gap: 7px` | `gap: var(--space-2)` |
| 363, 529 | рамка/линия | `border-top: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 390 | зазор | `gap: 4px` | `gap: var(--space-1)` |
| 427 | рамка/линия | `border-bottom: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 430 | высота элемента | `width: 33px` | `width: var(--control-sm)` |
| 431 | высота элемента | `height: 33px` | `height: var(--control-sm)` |
| 436, 488 | зазор | `gap: 6px` | `gap: var(--space-2)` |
| 479 | рамка/линия | `border-left: 3px solid var(--blue)` | `var(--hairline-strong) solid var(--blue)` |
| 517 | рамка/линия | `border-left: 3px solid var(--danger)` | `var(--hairline-strong) solid var(--danger)` |
| 581 | зазор | `gap: 10px` | `gap: var(--space-2)` |
| 640 | высота элемента | `width: 34px` | `width: var(--control-sm)` |
| 641 | высота элемента | `height: 34px` | `height: var(--control-sm)` |
| 646 | зазор | `gap: 8px 20px` | `gap: var(--space-2) var(--space-5)` |
| 673 | зазор | `gap: 6px` | `gap: var(--space-1)` |
| 676 | зазор | `gap: 5px` | `gap: var(--space-1)` |

#### `durak.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 36, 298, 853, 860, 1167, 1298, 1383, 1461 | зазор | `gap: 8px` | `gap: var(--space-2)` |
| 40, 946 | рамка/линия | `border-bottom: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 44, 283, 543, 1259 | зазор | `gap: 3px` | `gap: var(--space-0-5)` |
| 62 | высота элемента | `width: 42px` | `width: var(--control-lg)` |
| 63 | высота элемента | `min-width: 42px` | `min-width: var(--control-lg)` |
| 64 | высота элемента | `min-height: 42px` | `min-height: var(--control-lg)` |
| 65 | высота элемента | `height: 42px` | `height: var(--control-lg)` |
| 82 | зазор | `gap: 16px` | `gap: var(--space-4)` |
| 94 | зазор | `gap: 6px` | `gap: var(--space-2)` |
| 115, 1286 | зазор | `gap: 20px` | `gap: var(--space-5)` |
| 152 | рамка/линия | `border: 6px solid var(--surface-1)` | своя толщина рисунка → исключение |
| 159 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--stage-glint-2), inset 0 0 45px var(--stage-veil-1), var(--shadow-card)` | inset 0 0 0 var(--hairline) var(--stage-glint-2), inset 0 0 45px var(--stage-veil-1), var(--shadow-card) |
| 168 | рамка/линия | `border: 1px solid var(--stage-glint-1)` | своя толщина рисунка → исключение |
| 213, 698, 840, 944, 1045 | зазор | `gap: 12px` | `gap: var(--space-3)` |
| 230 | зазор | `gap: 12px 8px` | `gap: var(--space-3) var(--space-2)` |
| 271, 794 | кольцо тенью | `box-shadow: 0 0 0 3px var(--accent), var(--shadow-lift)` | проверить на месте |
| 302 | рамка/линия | `border: 1px solid var(--accent)` | `var(--hairline) solid var(--accent)` |
| 322, 776 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--card-edge), var(--shadow-card)` | inset 0 0 0 var(--hairline) var(--card-edge), var(--shadow-card) |
| 366 | рамка/линия | `border: 3px solid var(--card-face)` | своя толщина рисунка → исключение |
| 367 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--card-back-deep), var(--shadow-card)` | inset 0 0 0 var(--hairline) var(--card-back-deep), var(--shadow-card) |
| 389, 979, 1161, 1306 | зазор | `gap: 6px` | `gap: var(--space-1)` |
| 418 | рамка/линия | `border: 1px dashed var(--stage-glint-3)` | своя толщина рисунка → исключение |
| 471, 1437 | зазор | `gap: 4px` | `gap: var(--space-1)` |
| 497 | кольцо тенью | `box-shadow: 0 0 0 3px var(--surface-1), var(--shadow-card)` | проверить на месте |
| 530 | кольцо тенью | `box-shadow: 0 0 0 3px var(--speaking), 0 0 18px color-mix(in oklab, var(--speaking) 60%, transparent), var(--shadow-card)` | проверить на месте |
| 547 | рамка/линия | `border: 1px solid var(--stage-glint-2)` | `var(--hairline) solid var(--stage-glint-2)` |
| 559 | рамка/линия | `border: 1px solid var(--card-face)` | `var(--hairline) solid var(--card-face)` |
| 560 | радиус | `border-radius: 2px` | `var(--hairline-strong)` |
| 564 | кольцо тенью | `box-shadow: 0 0 0 3px var(--danger), var(--shadow-card)` | проверить на месте |
| 589, 707, 1013 | зазор | `gap: 5px` | `gap: var(--space-1)` |
| 640 | зазор | `gap: 7px` | `gap: var(--space-2)` |
| 669, 971, 1279, 1448 | зазор | `gap: 10px` | `gap: var(--space-2)` |
| 692, 844, 1123 | рамка/линия | `border-top: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 710 | высота элемента | `min-height: 28px` | `min-height: var(--control-xs)` |
| 785 | кольцо тенью | `box-shadow: inset 0 0 0 2px var(--accent), var(--shadow-card)` | inset 0 0 0 var(--hairline-strong) var(--accent), var(--shadow-card) |
| 822, 863 | рамка/линия | `border: 1px solid var(--line-strong)` | `var(--hairline) solid var(--line-strong)` |
| 861 | высота элемента | `min-width: 102px` | `min-width: var(--control-touch)` |
| 862 | высота элемента | `min-height: 44px` | `min-height: var(--touch-target)` |
| 931, 1136 | зазор | `gap: 14px` | `gap: var(--space-3)` |
| 933, 965, 993, 1020, 1048, 1075 | рамка/линия | `border: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 960 | высота элемента | `width: 40px` | `width: var(--control-lg)` |
| 961, 1274 | высота элемента | `min-height: 40px` | `min-height: var(--control-lg)` |
| 962, 1275 | высота элемента | `height: 40px` | `height: var(--control-lg)` |
| 989 | зазор | `gap: 9px` | `gap: var(--space-2)` |
| 1017 | высота элемента | `min-height: 38px` | `min-height: var(--control-md)` |
| 1018 | высота элемента | `min-width: 54px` | `min-width: var(--control-touch)` |
| 1041 | высота элемента | `min-height: 66px` | `min-height: var(--control-touch)` |
| 1243 | кольцо тенью | `box-shadow: 0 0 0 3px var(--accent), var(--shadow-card)` | проверить на месте |
| 1248 | кольцо тенью | `box-shadow: 0 0 0 5px var(--accent-hover), 0 0 30px var(--accent)` | проверить на месте |
| 1272 | высота элемента | `width: 38px` | `width: var(--control-md)` |
| 1273 | высота элемента | `min-width: 38px` | `min-width: var(--control-md)` |
| 1317 | зазор | `gap: 8px 4px` | `gap: var(--space-2) var(--space-1)` |
| 1326 | рамка/линия | `border-width: 4px` | своя толщина рисунка → исключение |
| 1337 | зазор | `gap: 7px 0` | `gap: var(--space-2) 0` |
| 1390 | высота элемента | `min-width: 82px` | `min-width: var(--control-touch)` |
| 1415 | высота элемента | `width: 34px` | `width: var(--control-sm)` |
| 1416 | высота элемента | `min-width: 34px` | `min-width: var(--control-sm)` |
| 1468 | зазор | `gap: 1px` | `gap: var(--hairline)` |

#### `game-people.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 3 | зазор | `gap: 8px` | `gap: var(--space-2)` |
| 10 | зазор | `gap: 9px` | `gap: var(--space-2)` |
| 34 | обводка | `outline: 2px solid transparent` | `var(--hairline-strong) solid transparent` |
| 35 | отступ кольца | `outline-offset: 2px` | `var(--focus-offset)` |
| 102 | рамка/линия | `border: 1px solid var(--stage-glint-3)` | `var(--hairline) solid var(--stage-glint-3)` |

#### `game-polish.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 21, 27 | высота элемента | `min-height: 44px` | `min-height: var(--touch-target)` |
| 38 | зазор | `gap: 12px` | `gap: var(--space-3)` |
| 50 | рамка/линия | `border-inline-start: 4px solid var(--game-accent, var(--accent))` | `var(--hairline-strong) solid var(--game-accent, var(--accent))` |
| 72 | зазор | `gap: 26px` | `gap: var(--space-6)` |
| 140 | зазор | `gap: 8px` | `gap: var(--space-2)` |
| 146 | высота элемента | `min-height: 64px` | `min-height: var(--control-touch)` |
| 148, 391 | рамка/линия | `border: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 184 | рамка/линия | `border: 1px solid var(--card-edge)` | своя толщина рисунка → исключение |
| 199 | рамка/линия | `border: 2px solid var(--card-face)` | своя толщина рисунка → исключение |
| 233 | зазор | `gap: 6px` | `gap: var(--space-1)` |
| 373 | кольцо тенью | `box-shadow: 0 0 0 1px color-mix(in srgb, var(--game-accent) 20%, transparent)` | 0 0 0 var(--hairline) color-mix(in srgb, var(--game-accent) 20%, transparent) |

#### `gartic.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 14, 213, 746, 1182, 1270 | зазор | `gap: 16px` | `gap: var(--space-4)` |
| 25, 142, 172, 272, 1526, 1581 | зазор | `gap: 20px` | `gap: var(--space-5)` |
| 30, 249, 283, 422, 633, 646, 796, 918, 1249, 1325, 1363, 1478, 1615, 1646 | зазор | `gap: 12px` | `gap: var(--space-3)` |
| 47, 868 | рамка/линия | `border-left: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 55, 109, 177, 288, 481, 722, 891, 1023, 1089, 1228, 1379, 1472, 1485, 1557, 1619, 1657, 1661, 1692 | зазор | `gap: 8px` | `gap: var(--space-2)` |
| 64, 120, 412, 662, 823, 1283, 1295 | зазор | `gap: 6px` | `gap: var(--space-2)` |
| 80, 147, 189, 227, 389, 425, 602, 730, 812, 1209, 1308 | рамка/линия | `border: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 112 | рамка/линия | `border-left: 3px solid var(--warning)` | `var(--hairline-strong) solid var(--warning)` |
| 184, 296 | зазор | `column-gap: 14px` | `column-gap: var(--space-3)` |
| 185 | зазор | `row-gap: 3px` | `row-gap: var(--space-0-5)` |
| 221, 254, 399, 620, 653, 1481 | зазор | `gap: 7px` | `gap: var(--space-2)` |
| 235 | зазор | `column-gap: 8px` | `column-gap: var(--space-2)` |
| 236 | зазор | `row-gap: 6px` | `row-gap: var(--space-2)` |
| 297 | зазор | `row-gap: 2px` | `row-gap: var(--space-0-5)` |
| 321 | рамка/линия | `border: 1px solid var(--paper-line)` | `var(--hairline) solid var(--paper-line)` |
| 346, 809, 1064, 1094, 1435, 1585, 1638 | зазор | `gap: 10px` | `gap: var(--space-2)` |
| 355 | зазор | `gap: 8px 12px` | `gap: var(--space-2) var(--space-3)` |
| 362, 1130, 1625 | зазор | `gap: 4px` | `gap: var(--space-1)` |
| 370, 1725 | высота элемента | `width: 28px` | `width: var(--control-xs)` |
| 371, 1726 | высота элемента | `height: 28px` | `height: var(--control-xs)` |
| 374 | рамка/линия | `border: 1px solid var(--muted)` | `var(--hairline) solid var(--muted)` |
| 378 | обводка | `outline: 2px solid var(--text)` | `var(--hairline-strong) solid var(--text)` |
| 379 | отступ кольца | `outline-offset: 2px` | `var(--focus-offset)` |
| 445 | зазор | `gap: 9px` | `gap: var(--space-2)` |
| 449 | рамка/линия | `border: 1px solid var(--gartic-ink)` | `var(--hairline) solid var(--gartic-ink)` |
| 463, 766, 1531 | зазор | `gap: 18px` | `gap: var(--space-4)` |
| 483, 909, 1272 | рамка/линия | `border-bottom: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 502, 962, 1695 | высота элемента | `width: 44px` | `width: var(--touch-target)` |
| 503, 1304, 1629, 1696 | высота элемента | `min-width: 44px` | `min-width: var(--touch-target)` |
| 504, 963, 1305, 1697 | высота элемента | `height: 44px` | `height: var(--touch-target)` |
| 577 | зазор | `gap: 3px 7px` | `gap: var(--space-0-5) var(--space-2)` |
| 584 | зазор | `gap: 3px` | `gap: var(--space-0-5)` |
| 595 | зазор | `gap: 5px` | `gap: var(--space-1)` |
| 613 | высота элемента | `min-width: 39px` | `min-width: var(--control-lg)` |
| 667 | зазор | `gap: 15px` | `gap: var(--space-4)` |
| 675 | зазор | `gap: 13px` | `gap: var(--space-3)` |
| 681 | рамка/линия | `border: 1px dashed var(--line)` | `var(--hairline) dashed var(--line)` |
| 705 | рамка/линия | `border-left: 3px solid var(--gartic-ink)` | `var(--hairline-strong) solid var(--gartic-ink)` |
| 751, 1152 | рамка/линия | `border-top: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 774 | рамка/линия | `border: 1px solid color-mix(in srgb, var(--gartic-ink) 24%, var(--line))` | `var(--hairline) solid color-mix(in srgb, var(--gartic-ink) 24%, var(--line))` |
| 859 | рамка/линия | `border-block: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 942 | зазор | `gap: 2px` | `gap: var(--space-0-5)` |
| 984 | зазор | `gap: 12px 28px` | `gap: var(--space-3) var(--space-7)` |
| 1049 | зазор | `gap: 32px` | `gap: var(--space-8)` |
| 1057, 1173, 1462 | зазор | `gap: 14px` | `gap: var(--space-3)` |
| 1098 | рамка/линия | `border: 1px solid transparent` | `var(--hairline) solid transparent` |
| 1149 | зазор | `gap: 28px` | `gap: var(--space-7)` |
| 1465, 1561 | высота элемента | `width: 25px` | `width: var(--control-xs)` |
| 1466, 1562 | высота элемента | `height: 25px` | `height: var(--control-xs)` |
| 1502 | размер значка | `width: 18px` | `width: var(--icon-sm)` |
| 1503 | размер значка | `height: 18px` | `height: var(--icon-sm)` |
| 1507 | зазор | `gap: 25px` | `gap: var(--space-6)` |
| 1687, 1722 | зазор | `gap: 6px` | `gap: var(--space-1)` |

#### `home-entry.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 94 | высота элемента | `width: 44px` | `width: var(--touch-target)` |
| 95 | высота элемента | `height: 44px` | `height: var(--touch-target)` |
| 177 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--field-line)` | inset 0 0 0 var(--hairline) var(--field-line) |
| 185 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--muted)` | inset 0 0 0 var(--hairline) var(--muted) |
| 190 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--accent)` | inset 0 0 0 var(--hairline) var(--accent) |
| 193 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--danger)` | inset 0 0 0 var(--hairline) var(--danger) |

#### `poker.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 25, 137, 301, 378, 1273, 1280, 1339, 1513, 1536, 1597, 1606, 1851, 2144, 2234, 2265, 2384, 2424, 2489 | зазор | `gap: 8px` | `gap: var(--space-2)` |
| 35 | зазор | `gap: 12px` | `gap: var(--space-3)` |
| 40, 83, 1226, 1351, 1519, 1559, 1718, 1759, 1779, 1807, 2237, 2349, 2399, 2444 | рамка/линия | `border: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 59, 616, 682, 1879, 1920, 1947, 2162 | зазор | `gap: 5px` | `gap: var(--space-1)` |
| 66, 77, 360, 1343, 1956, 2168, 2438 | зазор | `gap: 6px` | `gap: var(--space-2)` |
| 73 | высота элемента | `min-height: 34px` | `min-height: var(--control-sm)` |
| 152, 317, 1235, 1371, 1386, 1570, 1846, 2209, 2329 | зазор | `gap: 10px` | `gap: var(--space-2)` |
| 156 | рамка/линия | `border: 1px solid transparent` | `var(--hairline) solid transparent` |
| 157 | рамка/линия | `border-inline-start-width: 1px` | `var(--hairline)` |
| 191 | рамка/линия | `border: 1px dashed color-mix(in oklab, var(--gold) 24%, transparent)` | `var(--hairline) dashed color-mix(in oklab, var(--gold) 24%, transparent)` |
| 201 | кольцо тенью | `box-shadow: inset 0 0 0 2px var(--stage-veil-1), inset 0 0 60px var(--stage-veil-2), inset 0 2px 1px var(--stage-glint-1)` | inset 0 0 0 var(--hairline-strong) var(--stage-veil-1), inset 0 0 60px var(--stage-veil-2), inset 0 2px 1px var(--stage-glint-1) |
| 262, 595, 1421 | рамка/линия | `border: 1px solid var(--stage-glint-1)` | `var(--hairline) solid var(--stage-glint-1)` |
| 277 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--stage-glint-2), inset 0 0 0 3px var(--card-back-deep), 3px -3px 0 -1px var(--card-back), 3px -3px 0 0 var(--stage-glint-2), 6px -6px 0 -1px var(--card-back), 6px -6px 0 0 var(--stage-glint-1), 0 8px 18px var(--stage-veil-2)` | inset 0 0 0 var(--hairline) var(--stage-glint-2), inset 0 0 0 3px var(--card-back-deep), 3px -3px 0 -1px var(--card-back), 3px -3px 0 0 var(--stage-glint-2), 6px -6px 0 -1px var(--card-back), 6px -6px 0 0 var(--stage-glint-1), 0 8px 18px var(--stage-veil-2) (3 px+ — проверить) |
| 324 | зазор | `gap: 9px` | `gap: var(--space-2)` |
| 331 | рамка/линия | `border: 1px solid color-mix(in oklab, var(--gold) 55%, transparent)` | `var(--hairline) solid color-mix(in oklab, var(--gold) 55%, transparent)` |
| 350 | кольцо тенью | `box-shadow: var(--shadow-lift), 0 0 0 3px color-mix(in oklab, var(--gold) 30%, transparent)` | проверить на месте |
| 384, 660, 686, 725, 1284 | рамка/линия | `border: 1px solid var(--stage-glint-2)` | `var(--hairline) solid var(--stage-glint-2)` |
| 476, 498, 1433, 2511 | зазор | `gap: 3px` | `gap: var(--space-0-5)` |
| 506 | кольцо тенью | `box-shadow: 0 0 0 2px var(--stage-glint-2), var(--shadow-lift)` | 0 0 0 var(--hairline-strong) var(--stage-glint-2), var(--shadow-lift) |
| 538 | кольцо тенью | `box-shadow: 0 0 0 2px var(--gold), 0 0 26px color-mix(in oklab, var(--gold) 55%, transparent), var(--shadow-lift)` | 0 0 0 var(--hairline-strong) var(--gold), 0 0 26px color-mix(in oklab, var(--gold) 55%, transparent), var(--shadow-lift) |
| 549 | кольцо тенью | `box-shadow: 0 0 0 2px var(--speaking), 0 0 18px color-mix(in oklab, var(--speaking) 60%, transparent), var(--shadow-lift)` | 0 0 0 var(--hairline-strong) var(--speaking), 0 0 18px color-mix(in oklab, var(--speaking) 60%, transparent), var(--shadow-lift) |
| 560 | кольцо тенью | `box-shadow: 0 0 0 2px var(--gold), 0 0 10px color-mix(in oklab, var(--gold) 33%, transparent)` | 0 0 0 var(--hairline-strong) var(--gold), 0 0 10px color-mix(in oklab, var(--gold) 33%, transparent) |
| 565 | кольцо тенью | `box-shadow: 0 0 0 4px var(--gold), 0 0 40px color-mix(in oklab, var(--gold) 80%, transparent)` | проверить на месте |
| 653 | рамка/линия | `border: 1px solid var(--card-face)` | `var(--hairline) solid var(--card-face)` |
| 665, 2345 | зазор | `gap: 2px` | `gap: var(--space-0-5)` |
| 749 | рамка/линия | `border: 1px solid color-mix(in oklab, var(--gold) 45%, transparent)` | `var(--hairline) solid color-mix(in oklab, var(--gold) 45%, transparent)` |
| 793 | рамка/линия | `border: 1px solid color-mix(in oklab, var(--danger) 40%, transparent)` | `var(--hairline) solid color-mix(in oklab, var(--danger) 40%, transparent)` |
| 802, 1893 | зазор | `gap: 1px` | `gap: var(--hairline)` |
| 806 | рамка/линия | `border: 2px dashed var(--stage-glint-3)` | своя толщина рисунка → исключение |
| 832 | кольцо тенью | `box-shadow: var(--shadow-card), inset 0 0 0 1px var(--card-face)` | `var(--shadow-card), inset 0 0 0 var(--hairline) var(--card-face)` |
| 887 | кольцо тенью | `box-shadow: var(--shadow-card), inset 0 0 0 1px var(--stage-glint-2), inset 0 0 0 4px var(--card-back-deep)` | `var(--shadow-card), inset 0 0 0 var(--hairline) var(--stage-glint-2), inset 0 0 0 4px var(--card-back-deep) (3 px+ — проверить)` |
| 919 | кольцо тенью | `box-shadow: 0 0 0 2px var(--gold), 0 0 22px color-mix(in oklab, var(--gold) 45%, transparent)` | 0 0 0 var(--hairline-strong) var(--gold), 0 0 22px color-mix(in oklab, var(--gold) 45%, transparent) |
| 1014 | рамка/линия | `border: 1px dashed var(--stage-glint-4)` | `var(--hairline) dashed var(--stage-glint-4)` |
| 1222 | зазор | `gap: 10px 18px` | `gap: var(--space-2) var(--space-4)` |
| 1230 | кольцо тенью | `box-shadow: 0 0 0 1px color-mix(in oklab, var(--gold) 28%, transparent)` | 0 0 0 var(--hairline) color-mix(in oklab, var(--gold) 28%, transparent) |
| 1240, 1417, 1619, 1773, 2375 | зазор | `gap: 4px` | `gap: var(--space-1)` |
| 1252 | зазор | `column-gap: 9px` | `column-gap: var(--space-2)` |
| 1314 | рамка/линия | `border: 1px solid currentColor` | `var(--hairline) solid currentColor` |
| 1366 | кольцо тенью | `box-shadow: 0 0 0 1px var(--gold)` | 0 0 0 var(--hairline) var(--gold) |
| 1380 | рамка/линия | `border: 1px solid var(--gold)` | `var(--hairline) solid var(--gold)` |
| 1443, 1697, 1889, 2103, 2341, 2368, 2455, 2471 | зазор | `gap: 6px` | `gap: var(--space-1)` |
| 1538 | рамка/линия | `border-bottom: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 1543, 2141, 2430, 2465 | зазор | `gap: 7px` | `gap: var(--space-2)` |
| 1644 | рамка/линия | `border: 1px solid color-mix(in oklab, var(--danger) 50%, transparent)` | `var(--hairline) solid color-mix(in oklab, var(--danger) 50%, transparent)` |
| 1701 | рамка/линия | `border-top: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 1725, 1755 | зазор | `gap: 2px 12px` | `gap: var(--space-0-5) var(--space-3)` |
| 1776 | высота элемента | `min-width: 30px` | `min-width: var(--control-xs)` |
| 1872 | зазор | `gap: 4px 12px` | `gap: var(--space-1) var(--space-3)` |
| 1926 | зазор | `gap: 2px 8px` | `gap: var(--space-0-5) var(--space-2)` |
| 2058 | зазор | `gap: 6px 8px` | `gap: var(--space-2) var(--space-2)` |
| 2244 | кольцо тенью | `box-shadow: 0 0 0 1px var(--accent-soft)` | 0 0 0 var(--hairline) var(--accent-soft) |
| 2253 | зазор | `gap: 4px 10px` | `gap: var(--space-1) var(--space-2)` |
| 2356 | кольцо тенью | `box-shadow: 0 0 0 1px var(--accent)` | 0 0 0 var(--hairline) var(--accent) |
| 2480 | зазор | `gap: 2px 10px` | `gap: var(--space-0-5) var(--space-2)` |

#### `styles.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 117 | рамка/линия | `border: 3px solid transparent` | своя толщина рисунка → исключение |
| 122 | рамка/линия | `border-width: 2px` | своя толщина рисунка → исключение |
| 183, 404, 466, 621, 719, 928 | рамка/линия | `border: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 187, 257 | высота элемента | `min-height: 48px` | `min-height: var(--control-touch)` |
| 200 | высота элемента | `width: 18px` | `width: var(--control-xs)` |
| 201 | высота элемента | `height: 18px` | `height: var(--control-xs)` |
| 263, 633, 732 | зазор | `gap: 10px` | `gap: var(--space-2)` |
| 290 | высота элемента | `width: 48px` | `width: var(--control-touch)` |
| 291 | высота элемента | `min-width: 48px` | `min-width: var(--control-touch)` |
| 292 | высота элемента | `height: 48px` | `height: var(--control-touch)` |
| 357 | рамка/линия | `border: 1px solid var(--line)` | своя толщина рисунка → исключение |
| 411, 570 | зазор | `gap: 7px` | `gap: var(--space-2)` |
| 464, 995 | зазор | `gap: 12px` | `gap: var(--space-3)` |
| 658 | рамка/линия | `border: 1px solid var(--paper-line)` | `var(--hairline) solid var(--paper-line)` |
| 679 | зазор | `gap: 18px` | `gap: var(--space-4)` |
| 687 | рамка/линия | `border-top: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 755 | рамка/линия | `border: 1px solid var(--danger)` | `var(--hairline) solid var(--danger)` |
| 762 | зазор | `gap: 16px` | `gap: var(--space-4)` |
| 768, 817 | высота элемента | `width: 40px` | `width: var(--control-lg)` |
| 769 | высота элемента | `height: 40px` | `height: var(--control-lg)` |
| 818 | высота элемента | `min-width: 40px` | `min-width: var(--control-lg)` |
| 894 | кольцо тенью | `box-shadow: 0 0 0 9999px var(--stage-veil-2), inset 0 0 0 2px var(--stage-glint-3)` | 0 0 0 9999px var(--stage-veil-2), inset 0 0 0 var(--hairline-strong) var(--stage-glint-3) |
| 937, 999 | зазор | `gap: 8px` | `gap: var(--space-2)` |
| 949 | высота элемента | `min-height: 24px` | `min-height: var(--control-xs)` |
| 1016 | рамка/линия | `border-bottom: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |

#### `telegram/TelegramApp.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 169 | размер значка | `MicOff size={28}` | 32 (иллюстрация, --icon-xl) |
| 195 | размер значка | `TriangleAlert size={28}` | 32 (иллюстрация, --icon-xl) |

#### `ui/abuse/notices.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 70 | высота элемента | `min-height: 40px` | `min-height: var(--control-lg)` |

#### `ui/abuse/Notices.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 39 | размер значка | `TimerOff size={14}` | 16 |
| 63 | размер значка | `Clapperboard size={14}` | 16 |
| 80 | размер значка | `ShieldAlert size={13}` | 12 (--icon-xs: мелкий текст, плашка 20) |

#### `ui/activity/activity.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 62, 97, 173, 231, 409 | рамка/линия | `border: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 111 | рамка/линия | `border-bottom: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 184, 250 | зазор | `gap: 2px` | `gap: var(--space-0-5)` |
| 254 | рамка/линия | `border-bottom: 1px solid var(--line-strong)` | `var(--hairline) solid var(--line-strong)` |
| 342 | рамка/линия | `border-left: 1px solid var(--line-strong)` | `var(--hairline) solid var(--line-strong)` |

#### `ui/activity/Activity.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 265, 514 | размер значка | `Ban size={14}` | 16 |
| 469 | размер значка | `RefreshCw size={14}` | 16 |
| 633 | размер значка | `ShieldOff size={14}` | 16 |

#### `ui/activity/SupportTab.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 63 | размер значка | `Send size={13}` | 12 (--icon-xs: мелкий текст, плашка 20) |

#### `ui/BackgroundNote.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 64 | размер значка | `MicOff size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 78 | размер значка | `X size={18}` | 20 (по кнопке md) |

#### `ui/call-dock.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 80 | кольцо тенью | `box-shadow: 0 0 0 2px var(--dock-bg)` | 0 0 0 var(--hairline-strong) var(--dock-bg) |
| 130, 168 | зазор | `gap: 2px` | `gap: var(--space-0-5)` |
| 197 | высота элемента | `min-height: 28px` | `min-height: var(--control-xs)` |

#### `ui/CameraMenu.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 47 | размер значка | `SwitchCamera size={22}` | 24 (по кнопке lg) |

#### `ui/capture-picker.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 148 | кольцо тенью | `box-shadow: inset 0 0 0 2px transparent` | inset 0 0 0 var(--hairline-strong) transparent |
| 162 | кольцо тенью | `box-shadow: inset 0 0 0 2px var(--accent)` | inset 0 0 0 var(--hairline-strong) var(--accent) |

#### `ui/CapturePicker.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 197 | размер значка | `Monitor size={28}` | 32 (иллюстрация, --icon-xl) |
| 199 | размер значка | `AppWindow size={28}` | 32 (иллюстрация, --icon-xl) |
| 217 | размер значка | `Video size={32}` | 32 (иллюстрация, --icon-xl) |
| 238 | размер значка | `Video size={28}` | 32 (иллюстрация, --icon-xl) |

#### `ui/chat-attachments.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 51 | зазор | `gap: 2px` | `gap: var(--space-0-5)` |

#### `ui/ChessTable.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 339 | размер значка | `ArrowLeftRight size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 346 | размер значка | `Download size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 354 | размер значка | `X size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 612 | размер значка | `ChevronsLeft size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 619 | размер значка | `ChevronLeft size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 626 | размер значка | `ChevronRight size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 668 | размер значка | `Handshake size={17}` | 16 |

#### `ui/cinema/catalog/More.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 32 | размер значка | `LoaderCircle size={17}` | 16 |

#### `ui/cinema/catalog/notes.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 80 | размер значка | `CloudOff size={40}` | 40 (иллюстрация, --icon-2xl) |
| 101, 141 | размер значка | `LoaderCircle size={22}` | 24 или 20 — по месту |

#### `ui/cinema/catalog/pages/CategoryPage.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 38 | размер значка | `Gamepad2 size={22}` | 24 или 20 — по месту |

#### `ui/cinema/catalog/pages/ChannelPage.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 24 | размер значка | `Tv size={22}` | 24 или 20 — по месту |

#### `ui/cinema/catalog/pages/ItemPage.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 66 | размер значка | `Tv size={34}` | 32 (иллюстрация, --icon-xl) |
| 76 | размер значка | `Users size={12}` | 12 (--icon-xs: мелкий текст, плашка 20) |
| 81 | размер значка | `Eye size={12}` | 12 (--icon-xs: мелкий текст, плашка 20) |
| 90 | размер значка | `Play size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 94 | размер значка | `Tv size={17}` | 16 |
| 99 | размер значка | `ListVideo size={17}` | 16 |

#### `ui/cinema/catalog/pages/PlaylistPage.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 33 | размер значка | `ListVideo size={34}` | 32 (иллюстрация, --icon-xl) |
| 48 | размер значка | `Eye size={12}` | 12 (--icon-xs: мелкий текст, плашка 20) |

#### `ui/cinema/catalog/pages/SeriesPage.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 52 | размер значка | `Clapperboard size={34}` | 32 (иллюстрация, --icon-xl) |

#### `ui/cinema/catalog/Shell.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 98 | размер значка | `ArrowLeft size={19}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 102 | размер значка | `Clapperboard size={19}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 160 | размер значка | `X size={15}` | 16 |
| 168 | размер значка | `X size={19}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/cinema/catalog/tiles.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 61 | размер значка | `Tv size={26}` | 32 (иллюстрация, --icon-xl) |
| 96, 185 | размер значка | `Users size={11}` | 12 (--icon-xs: мелкий текст, плашка 20) |
| 101 | размер значка | `Eye size={11}` | 12 (--icon-xs: мелкий текст, плашка 20) |
| 122 | размер значка | `Clapperboard size={26}` | 32 (иллюстрация, --icon-xl) |
| 148 | размер значка | `ListVideo size={26}` | 32 (иллюстрация, --icon-xl) |
| 150 | размер значка | `ListVideo size={13}` | 12 (--icon-xs: мелкий текст, плашка 20) |
| 174 | размер значка | `Gamepad2 size={26}` | 32 (иллюстрация, --icon-xl) |
| 200 | размер значка | `Tv size={22}` | 24 или 20 — по месту |

#### `ui/cinema/cinema.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 25, 261, 625, 1034 | зазор | `gap: 10px` | `gap: var(--space-2)` |
| 68, 188, 776, 806, 949, 970, 1039 | зазор | `gap: 6px` | `gap: var(--space-2)` |
| 73, 163, 451, 517, 823, 943, 956, 988 | зазор | `gap: 8px` | `gap: var(--space-2)` |
| 75, 154, 409, 458, 521, 975 | рамка/линия | `border: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 165, 479 | рамка/линия | `border-bottom: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 180, 477, 735 | зазор | `gap: 4px` | `gap: var(--space-1)` |
| 189, 455 | высота элемента | `height: 34px` | `height: var(--control-sm)` |
| 234, 644, 830, 847 | зазор | `gap: 12px` | `gap: var(--space-3)` |
| 275, 740 | зазор | `gap: 9px` | `gap: var(--space-2)` |
| 290 | зазор | `gap: 14px 12px` | `gap: var(--space-3) var(--space-3)` |
| 295, 961 | зазор | `gap: 6px` | `gap: var(--space-1)` |
| 340 | высота элемента | `width: 38px` | `width: var(--control-md)` |
| 341 | высота элемента | `height: 38px` | `height: var(--control-md)` |
| 381 | зазор | `gap: 4px 9px` | `gap: var(--space-1) var(--space-2)` |
| 388, 594 | зазор | `gap: 3px` | `gap: var(--space-0-5)` |
| 416, 485, 1026 | зазор | `gap: 7px` | `gap: var(--space-2)` |
| 442 | зазор | `gap: 4px 12px` | `gap: var(--space-1) var(--space-3)` |
| 486 | высота элемента | `height: 36px` | `height: var(--control-md)` |
| 518, 777 | высота элемента | `height: 40px` | `height: var(--control-lg)` |
| 605 | зазор | `gap: 14px` | `gap: var(--space-3)` |
| 655 | зазор | `gap: 13px` | `gap: var(--space-3)` |
| 695 | зазор | `gap: 18px` | `gap: var(--space-4)` |
| 715 | зазор | `gap: 11px` | `gap: var(--space-3)` |
| 727 | зазор | `gap: 5px 12px` | `gap: var(--space-1) var(--space-3)` |
| 755 | зазор | `gap: 12px 10px` | `gap: var(--space-3) var(--space-2)` |
| 1013 | высота элемента | `width: 40px` | `width: var(--control-lg)` |
| 1050 | зазор | `gap: 5px` | `gap: var(--space-1)` |

#### `ui/cinema/scenes/LinkScene.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 266, 316, 334, 361 | размер значка | `Link2 size={40}` | 40 (иллюстрация, --icon-2xl) |
| 270 | размер значка | `ClipboardPaste size={17}` | 16 |
| 278 | размер значка | `History size={13}` | 12 (--icon-xs: мелкий текст, плашка 20) |
| 294 | размер значка | `Link2 size={15}` | 16 |
| 304 | размер значка | `X size={15}` | 16 |
| 320 | размер значка | `Link2 size={17}` | 16 |
| 327 | размер значка | `LoaderCircle size={22}` | 24 или 20 — по месту |
| 416 | размер значка | `Globe size={14}` | 16 |
| 424 | размер значка | `MonitorPlay size={14}` | 16 |
| 438 | размер значка | `AudioLines size={14}` | 16 |
| 446 | размер значка | `Captions size={14}` | 16 |

#### `ui/cinema/scenes/SwitcherScene.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 196 | размер значка | `CloudOff size={13}` | 12 (--icon-xs: мелкий текст, плашка 20) |
| 248 | размер значка | `Radio size={15}` | 16 |
| 256 | размер значка | `Gamepad2 size={15}` | 16 |
| 286 | размер значка | `Clapperboard size={40}` | 40 (иллюстрация, --icon-2xl) |

#### `ui/cinema/scenes/VkScene.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 200 | размер значка | `Link2 size={40}` | 40 (иллюстрация, --icon-2xl) |

#### `ui/cinema/theater.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 36, 50, 203 | зазор | `gap: 10px` | `gap: var(--space-2)` |
| 141 | высота элемента | `width: 54px` | `width: var(--control-touch)` |
| 142 | высота элемента | `min-width: 54px` | `min-width: var(--control-touch)` |
| 143 | высота элемента | `height: 54px` | `height: var(--control-touch)` |
| 177 | высота элемента | `width: 46px` | `width: var(--touch-target)` |
| 178 | высота элемента | `min-width: 46px` | `min-width: var(--touch-target)` |
| 179 | высота элемента | `height: 46px` | `height: var(--touch-target)` |
| 190, 390 | зазор | `gap: 8px` | `gap: var(--space-2)` |
| 196, 296, 425, 571 | зазор | `gap: 2px` | `gap: var(--space-0-5)` |
| 209 | зазор | `gap: 4px` | `gap: var(--space-1)` |
| 216 | высота элемента | `width: 40px` | `width: var(--control-lg)` |
| 217 | высота элемента | `min-width: 40px` | `min-width: var(--control-lg)` |
| 218 | высота элемента | `height: 40px` | `height: var(--control-lg)` |
| 230 | зазор | `gap: 1px 8px` | `gap: var(--hairline) var(--space-2)` |
| 251 | зазор | `gap: 7px` | `gap: var(--space-2)` |
| 255 | рамка/линия | `border: 1px solid var(--stage-glint-2)` | `var(--hairline) solid var(--stage-glint-2)` |
| 288 | кольцо тенью | `box-shadow: 0 0 0 4px color-mix(in srgb, var(--live) 24%, transparent)` | проверить на месте |
| 395 | рамка/линия | `border-bottom: 1px solid var(--line)` | `var(--hairline) solid var(--line)` |
| 466 | рамка/линия | `border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent)` | `var(--hairline) solid color-mix(in srgb, var(--warning) 40%, transparent)` |
| 486 | зазор | `gap: 6px` | `gap: var(--space-1)` |
| 566 | высота элемента | `width: 36px` | `width: var(--control-md)` |
| 567 | высота элемента | `min-width: 36px` | `min-width: var(--control-md)` |
| 568 | высота элемента | `height: 36px` | `height: var(--control-md)` |

#### `ui/cinema/theater/Chrome.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 143 | размер значка | `Radio size={15}` | 16 |
| 143 | размер значка | `Tv size={15}` | 16 |
| 168 | размер значка | `X size={19}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 185 | размер значка | `RotateCcw size={22}` | 24 или 20 — по месту |
| 194 | размер значка | `Play size={30}` | 32 (иллюстрация, --icon-xl) |
| 194 | размер значка | `Pause size={30}` | 32 (иллюстрация, --icon-xl) |
| 202 | размер значка | `RotateCw size={22}` | 24 или 20 — по месту |
| 260 | размер значка | `Play size={21}` | 20 |
| 260 | размер значка | `Pause size={21}` | 20 |
| 267 | размер значка | `SkipBack size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 337 | размер значка | `Minimize2 size={19}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 337 | размер значка | `Maximize2 size={19}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 370 | размер значка | `VolumeX size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 370 | размер значка | `Volume1 size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 370 | размер значка | `Volume2 size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/cinema/theater/menus/CaptionsMenu.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 44 | размер значка | `Captions size={19}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/cinema/theater/menus/QualityMenu.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 60 | размер значка | `Settings2 size={17}` | 16 |
| 103 | размер значка | `ArrowLeft size={15}` | 16 |

#### `ui/cinema/theater/SyncButton.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 17 | размер значка | `RefreshCw size={17}` | 16 |

#### `ui/cinema/theater/WatchTheater.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 315 | размер значка | `LoaderCircle size={34}` | 32 (иллюстрация, --icon-xl) |
| 340 | размер значка | `LoaderCircle size={30}` | 32 (иллюстрация, --icon-xl) |
| 353 | размер значка | `Play size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/Connect.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 93 | размер значка | `Server size={22}` | 24 или 20 — по месту |
| 134 | размер значка | `ArrowRight size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 160 | размер значка | `Check size={14}` | 16 |
| 166 | размер значка | `TriangleAlert size={14}` | 16 |

#### `ui/DesktopHome.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 26 | размер значка | `Settings2 size={18}` | 20 (по кнопке md) |

#### `ui/Download.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 65 | размер значка | `DownloadIcon size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 79 | размер значка | `ShieldAlert size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/DurakTable.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 376 | размер значка | `ListOrdered size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 394, 1141 | размер значка | `Play size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 394, 1141 | размер значка | `Pause size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 404 | размер значка | `Settings2 size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 407 | размер значка | `Minimize2 size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 407 | размер значка | `Maximize2 size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 461 | размер значка | `Shield size={12}` | 12 (--icon-xs: мелкий текст, плашка 20) |
| 525 | размер значка | `ArrowRightLeft size={14}` | 16 |
| 572 | размер значка | `X size={14}` | 16 |
| 691 | размер значка | `Hand size={17}` | 16 |
| 701 | размер значка | `Check size={17}` | 16 |
| 749, 753, 1244 | размер значка | `X size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 897 | размер значка | `Pause size={14}` | 16 |
| 1229 | размер значка | `LogOut size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/FaceZoom.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 56 | размер значка | `ZoomOut size={13}` | 12 (--icon-xs: мелкий текст, плашка 20) |
| 56 | размер значка | `ZoomIn size={13}` | 12 (--icon-xs: мелкий текст, плашка 20) |

#### `ui/FavoriteSettings.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 33 | размер значка | `MoreHorizontal size={19}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 72 | размер значка | `Trash2 size={17}` | 16 |

#### `ui/GamesGroup.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 194, 686, 800 | размер значка | `ChevronDown size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 296, 417 | размер значка | `Users size={14}` | 16 |
| 303 | размер значка | `Coins size={14}` | 16 |
| 307, 426 | размер значка | `Timer size={14}` | 16 |
| 312 | размер значка | `TrendingUp size={14}` | 16 |
| 320, 433 | размер значка | `Play size={17}` | 16 |
| 324, 437 | размер значка | `X size={17}` | 16 |
| 350 | размер значка | `Spade size={17}` | 16 |
| 362 | размер значка | `History size={17}` | 16 |
| 420 | размер значка | `Layers size={14}` | 16 |
| 423 | размер значка | `Shuffle size={14}` | 16 |
| 484 | размер значка | `Club size={17}` | 16 |
| 659 | размер значка | `Club size={15}` | 16 |
| 683 | размер значка | `Club size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 783 | размер значка | `History size={15}` | 16 |
| 797 | размер значка | `Spade size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/GarticCanvas.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 418 | размер значка | `Check size={15}` | 16 |
| 436 | размер значка | `Pencil size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 445 | размер значка | `Eraser size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 471 | размер значка | `Undo2 size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 480 | размер значка | `Trash2 size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 507 | толщина значка | `Pencil strokeWidth={1.25}` | своя (рисунок Gartic, data-own-stroke) — оставить |
| 507 | размер значка | `Pencil size={30}` | 32 (иллюстрация, --icon-xl) |
| 516 | размер значка | `WifiOff size={14}` | 16 |
| 531 | размер значка | `RotateCw size={15}` | 16 |

#### `ui/GarticResults.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 74 | размер значка | `ChevronDown size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 115 | толщина значка | `Trophy strokeWidth={1.6}` | своя (рисунок Gartic, data-own-stroke) — оставить |
| 115 | размер значка | `Trophy size={28}` | 32 (иллюстрация, --icon-xl) |
| 147 | размер значка | `Trophy size={15}` | 16 |
| 273 | размер значка | `BookOpen size={21}` | 20 |
| 392 | размер значка | `BookOpen size={32}` | 32 (иллюстрация, --icon-xl) |
| 398 | размер значка | `Pencil size={32}` | 32 (иллюстрация, --icon-xl) |
| 443 | размер значка | `ArrowLeft size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 454 | размер значка | `RotateCcw size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 454 | размер значка | `ArrowRight size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/GarticTable.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 112 | размер значка | `Palette size={23}` | 24 или 20 — по месту |
| 148 | размер значка | `X size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 174 | толщина значка | `Pencil strokeWidth={1.3}` | своя (рисунок Gartic, data-own-stroke) — оставить |
| 174 | размер значка | `Pencil size={42}` | 40 (иллюстрация, --icon-2xl) |
| 255, 269 | размер значка | `Users size={17}` | 16 |
| 273 | размер значка | `Check size={17}` | 16 |
| 283 | размер значка | `Play size={17}` | 16 |
| 354 | размер значка | `LogOut size={15}` | 16 |
| 408 | толщина значка | `Pencil strokeWidth={1.5}` | своя (рисунок Gartic, data-own-stroke) — оставить |
| 408 | размер значка | `Pencil size={34}` | 32 (иллюстрация, --icon-xl) |
| 483, 741 | размер значка | `Check size={14}` | 16 |
| 513 | размер значка | `Send size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 518 | размер значка | `CheckCheck size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 554 | толщина значка | `Eye strokeWidth={1.3}` | своя (рисунок Gartic, data-own-stroke) — оставить |
| 554 | размер значка | `Eye size={34}` | 32 (иллюстрация, --icon-xl) |
| 578 | толщина значка | `BookOpen strokeWidth={1.3}` | своя (рисунок Gartic, data-own-stroke) — оставить |
| 578 | размер значка | `BookOpen size={34}` | 32 (иллюстрация, --icon-xl) |
| 593 | размер значка | `Pencil size={28}` | 32 (иллюстрация, --icon-xl) |
| 643, 733 | размер значка | `Check size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/home/FavoritesNav.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 249 | размер значка | `Plus size={14}` | 16 |
| 257, 435, 460 | размер значка | `ChevronRight size={14}` | 16 |
| 333 | размер значка | `Star size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 472 | размер значка | `Pin size={12}` | 12 (--icon-xs: мелкий текст, плашка 20) |

#### `ui/home/home.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 61, 238, 285, 393 | зазор | `gap: 2px` | `gap: var(--space-0-5)` |
| 134 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--line-strong)` | inset 0 0 0 var(--hairline) var(--line-strong) |
| 150 | кольцо тенью | `box-shadow: inset 0 0 0 1px transparent` | inset 0 0 0 var(--hairline) transparent |
| 162 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--line)` | inset 0 0 0 var(--hairline) var(--line) |
| 184 | зазор | `gap: 1px` | `gap: var(--hairline)` |
| 508 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--accent)` | inset 0 0 0 var(--hairline) var(--accent) |
| 514 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 3px var(--accent-soft)` | inset 0 0 0 var(--hairline) var(--accent), var(--field-halo) |
| 594 | кольцо тенью | `box-shadow: 0 0 0 4px var(--voice-1)` | проверить на месте |

#### `ui/home/HomeShell.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 57 | размер значка | `X size={18}` | 20 (по кнопке md) |
| 76 | размер значка | `Settings2 size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 136 | размер значка | `ShieldCheck size={14}` | 16 |

#### `ui/HomeEntry.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 91 | размер значка | `Link2 size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/InstallHint.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 72 | размер значка | `Share size={13}` | 12 (--icon-xs: мелкий текст, плашка 20) |
| 73 | размер значка | `SquarePlus size={13}` | 12 (--icon-xs: мелкий текст, плашка 20) |
| 92 | размер значка | `X size={17}` | 16 |

#### `ui/integrations.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 104 | кольцо тенью | `box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent)` | inset 0 0 0 var(--hairline) color-mix(in srgb, var(--accent) 45%, transparent) |
| 124, 205, 456, 556, 804, 989 | зазор | `gap: 2px` | `gap: var(--space-0-5)` |
| 519 | высота элемента | `width: 48px` | `width: var(--control-touch)` |
| 520 | высота элемента | `height: 48px` | `height: var(--control-touch)` |
| 564 | радиус | `border-radius: 1px` | шкала |
| 730 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--field-line)` | inset 0 0 0 var(--hairline) var(--field-line) |
| 744 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent)` | inset 0 0 0 var(--hairline) var(--accent), var(--field-halo) |
| 929 | отступ кольца | `outline-offset: -2px` | `var(--focus-offset-inset)` |

#### `ui/IntegrationShelf.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 68 | размер значка | `ChevronRight size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/Invite.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 63 | размер значка | `Link size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 82 | размер значка | `Check size={19}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 82 | размер значка | `Copy size={19}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/kit/Dialog.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 58 | размер значка | `X size={18}` | 20 (по кнопке md) |

#### `ui/kit/kit.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 149 | рамка/линия | `border: 2px solid color-mix(in srgb, currentColor 30%, transparent)` | своя толщина рисунка → исключение |
| 300 | кольцо тенью | `box-shadow: inset 0 0 0 var(--hairline) var(--accent), 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent)` | inset 0 0 0 var(--hairline) var(--accent), var(--field-halo) |
| 374, 387, 407 | кольцо тенью | `box-shadow: 0 0 0 1px rgb(0 0 0 / 0.08), 0 1px 3px rgb(0 0 0 / 0.3)` | 0 0 0 var(--hairline) rgb(0 0 0 / 0.08), 0 1px 3px rgb(0 0 0 / 0.3) |
| 397 | кольцо тенью | `box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 18%, transparent), 0 1px 3px rgb(0 0 0 / 0.3)` | проверить на месте |
| 469, 488, 575, 1115 | зазор | `gap: 2px` | `gap: var(--space-0-5)` |
| 1148 | зазор | `gap: 4px` | `gap: var(--space-1)` |
| 1346 | рамка/линия | `border: 1px solid transparent` | своя толщина рисунка → исключение |
| 1349 | радиус | `border-radius: 3px` | шкала |
| 1399 | обводка | `outline: 2px solid var(--accent)` | `var(--hairline-strong) solid var(--accent)` |
| 1400 | отступ кольца | `outline-offset: 3px` | `var(--focus-offset)` |
| 1401 | кольцо тенью | `box-shadow: 0 0 0 7px var(--accent-soft)` | проверить на месте |

#### `ui/kit/showcase.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 93 | кольцо тенью | `box-shadow: 0 0 0 1px var(--line)` | 0 0 0 var(--hairline) var(--line) |
| 129 | зазор | `gap: 6px` | `gap: var(--space-2)` |

#### `ui/kit/Showcase.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 222 | размер значка | `MoreHorizontal size={18}` | 16 (по кнопке sm) |
| 225 | размер значка | `Share2 size={22}` | 24 (по кнопке lg) |
| 244 | размер значка | `MicOff size={14}` | 16 |

#### `ui/loader/loader.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 15 | зазор | `gap: 40px` | `gap: var(--space-10)` |
| 40 | зазор | `gap: 36px` | `gap: var(--space-8)` |
| 77 | радиус | `border-radius: 999px` | `var(--radius-full)` |
| 109 | кольцо тенью | `box-shadow: 0 0 0 1px rgb(0 0 0 / 0.12)` | 0 0 0 var(--hairline) rgb(0 0 0 / 0.12) |

#### `ui/meeting-header.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 229 | зазор | `gap: 2px` | `gap: var(--space-0-5)` |

#### `ui/meeting-panel.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 84, 407 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--field-line)` | inset 0 0 0 var(--hairline) var(--field-line) |
| 93 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent)` | inset 0 0 0 var(--hairline) var(--accent), var(--field-halo) |
| 106, 402 | зазор | `gap: 2px` | `gap: var(--space-0-5)` |
| 124 | отступ кольца | `outline-offset: -2px` | `var(--focus-offset-inset)` |
| 167 | кольцо тенью | `box-shadow: 0 0 0 2px var(--surface-1), 0 0 0 calc(2px + var(--voice-ring)) color-mix(in srgb, var(--success) var(--voice-mix), transparent)` | 0 0 0 var(--hairline-strong) var(--surface-1), 0 0 0 calc(2px + var(--voice-ring)) color-mix(in srgb, var(--success) var(--voice-mix), transparent) |
| 411 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent)` | inset 0 0 0 var(--hairline) var(--accent), var(--field-halo) |

#### `ui/MeetingElsewhere.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 51 | размер значка | `ArrowRight size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 60 | размер значка | `LogOut size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/MeetingView.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 327 | размер значка | `Users size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 352 | размер значка | `PhoneOff size={28}` | 32 (иллюстрация, --icon-xl) |
| 370 | размер значка | `Users size={32}` | 32 (иллюстрация, --icon-xl) |
| 419 | размер значка | `X size={18}` | 20 (по кнопке md) |
| 442 | размер значка | `ChevronDown size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 442 | размер значка | `ChevronUp size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/music/music-mini.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 47, 88 | зазор | `gap: 2px` | `gap: var(--space-0-5)` |

#### `ui/music/MusicWidget.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 80 | размер значка | `Music2 size={26}` | 32 (иллюстрация, --icon-xl) |

#### `ui/music/YandexDeviceLogin.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 181 | размер значка | `ExternalLink size={14}` | 16 |
| 184 | размер значка | `LoaderCircle size={14}` | 16 |

#### `ui/MusicPlayer.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 157 | размер значка | `Shuffle size={18}` | 20 (по кнопке md) |
| 179 | размер значка | `Play size={22}` | 20 (по кнопке md) |
| 179 | размер значка | `Pause size={22}` | 20 (по кнопке md) |
| 197 | размер значка | `Repeat2 size={18}` | 20 (по кнопке md) |

#### `ui/MusicSearch.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 247 | размер значка | `X size={14}` | 16 (по кнопке sm) |
| 293 | размер значка | `LoaderCircle size={12}` | 12 (--icon-xs: мелкий текст, плашка 20) |

#### `ui/PlatformPicker.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 198 | размер значка | `CloudOff size={13}` | 12 (--icon-xs: мелкий текст, плашка 20) |

#### `ui/PokerResult.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 44 | размер значка | `Layers size={13}` | 12 (--icon-xs: мелкий текст, плашка 20) |
| 47 | размер значка | `Coins size={13}` | 12 (--icon-xs: мелкий текст, плашка 20) |
| 50 | размер значка | `TrendingUp size={13}` | 12 (--icon-xs: мелкий текст, плашка 20) |
| 57 | размер значка | `Timer size={13}` | 12 (--icon-xs: мелкий текст, плашка 20) |
| 83 | размер значка | `Crown size={13}` | 12 (--icon-xs: мелкий текст, плашка 20) |
| 126 | размер значка | `Trophy size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/PokerTable.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 315 | размер значка | `Pause size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 517 | размер значка | `TrendingUp size={14}` | 16 |
| 541 | размер значка | `Settings2 size={15}` | 16 |
| 545, 818 | размер значка | `Trophy size={15}` | 16 |
| 558 | размер значка | `Check size={15}` | 16 |
| 570, 583 | размер значка | `Play size={15}` | 16 |
| 583 | размер значка | `Pause size={15}` | 16 |
| 815 | размер значка | `Crown size={22}` | 24 или 20 — по месту |
| 1290 | размер значка | `X size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 1346 | размер значка | `Eye size={15}` | 16 |
| 1350 | размер значка | `LogOut size={15}` | 16 |
| 1427 | размер значка | `LogOut size={14}` | 16 |
| 1499 | размер значка | `ChevronRight size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/prejoin.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 97 | высота элемента | `width: 1px` | `width: var(--control-xs)` |
| 98 | высота элемента | `height: 1px` | `height: var(--control-xs)` |

#### `ui/Prejoin.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 173 | размер значка | `LoaderCircle size={30}` | 32 (иллюстрация, --icon-xl) |
| 276 | размер значка | `ArrowLeft size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
| 442 | размер значка | `ArrowRight size={19}` | 16 или 20 — по месту (в кнопке 36+ — 20) |

#### `ui/settings/AboutSection.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 78 | размер значка | `TriangleAlert size={15}` | 16 |

#### `ui/settings/AccountsSection.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 88 | размер значка | `ExternalLink size={12}` | 12 (--icon-xs: мелкий текст, плашка 20) |

#### `ui/settings/settings.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 87, 127, 183, 290, 294, 491, 815 | зазор | `gap: 2px` | `gap: var(--space-0-5)` |
| 159 | кольцо тенью | `box-shadow: inset 0 0 0 var(--hairline) var(--accent), 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent)` | inset 0 0 0 var(--hairline) var(--accent), var(--field-halo) |
| 562 | зазор | `gap: 3px` | `gap: var(--space-0-5)` |
| 566 | высота элемента | `width: 5px` | `width: var(--control-xs)` |
| 567 | высота элемента | `height: 14px` | `height: var(--control-xs)` |
| 861 | высота элемента | `width: 1px` | `width: var(--control-xs)` |
| 862 | высота элемента | `height: 1px` | `height: var(--control-xs)` |
| 882 | отступ кольца | `outline-offset: 4px` | `var(--focus-offset)` |
| 921 | высота элемента | `height: 12px` | `height: var(--control-xs)` |
| 1190 | кольцо тенью | `box-shadow: 0 0 0 3px var(--voice-3)` | проверить на месте |
| 1216 | радиус | `border-radius: 3px` | шкала |
| 1223 | радиус | `border-radius: 1px` | шкала |

#### `ui/settings/SoundsSection.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 72 | размер значка | `Play size={12}` | 12 (--icon-xs: мелкий текст, плашка 20) |

#### `ui/shell.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 161 | рамка/линия | `border: 4px solid transparent` | своя толщина рисунка → исключение |

#### `ui/Sidebar.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 300 | размер значка | `Check size={18}` | 16 (по кнопке sm) |
| 308 | размер значка | `UserX size={17}` | 16 (по кнопке sm) |
| 361 | размер значка | `Paperclip size={22}` | 24 или 20 — по месту |
| 387 | размер значка | `Copy size={15}` | 16 (по кнопке sm) |
| 420 | размер значка | `Download size={18}` | 20 (по кнопке md) |
| 446 | размер значка | `X size={18}` | 20 (по кнопке md) |
| 472 | размер значка | `Pause size={17}` | 16 (по кнопке sm) |
| 482 | размер значка | `Play size={17}` | 16 (по кнопке sm) |
| 491 | размер значка | `X size={17}` | 16 (по кнопке sm) |
| 519 | размер значка | `Paperclip size={19}` | 20 (по кнопке md) |
| 554 | размер значка | `Send size={18}` | 20 (по кнопке md) |

#### `ui/stage-overlay.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 87 | размер значка | `width: 12px` | `width: var(--icon-xs)` |
| 88 | размер значка | `height: 12px` | `height: var(--icon-xs)` |
| 125 | зазор | `gap: 2px` | `gap: var(--space-0-5)` |
| 127 | высота элемента | `width: 13px` | `width: var(--control-xs)` |
| 128 | высота элемента | `height: 12px` | `height: var(--control-xs)` |
| 133 | радиус | `border-radius: 1px` | шкала |

#### `ui/stage.css`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 122 | кольцо тенью | `box-shadow: inset 0 0 0 1px var(--stage-line)` | inset 0 0 0 var(--hairline) var(--stage-line) |
| 140 | кольцо тенью | `box-shadow: inset 0 0 0 2px var(--accent)` | inset 0 0 0 var(--hairline-strong) var(--accent) |
| 198, 764 | зазор | `gap: 6px` | `gap: var(--space-2)` |
| 265, 355, 720 | зазор | `gap: 2px` | `gap: var(--space-0-5)` |
| 288 | отступ кольца | `outline-offset: 1px` | `var(--focus-offset)` |
| 292, 326 | высота элемента | `min-width: 44px` | `min-width: var(--touch-target)` |
| 293, 327 | высота элемента | `height: 44px` | `height: var(--touch-target)` |
| 363 | высота элемента | `min-width: 40px` | `min-width: var(--control-lg)` |
| 364 | высота элемента | `height: 28px` | `height: var(--control-xs)` |

#### `ui/Stage.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 308 | размер значка | `ZoomOut size={17}` | 20 (по кнопке md) |
| 317 | размер значка | `ZoomIn size={17}` | 20 (по кнопке md) |
| 327 | размер значка | `RotateCcw size={17}` | 20 (по кнопке md) |
| 387 | размер значка | `MicOff size={14}` | 16 |

#### `ui/YandexIntegration.tsx`

| Строки | Что | До | После |
| --- | --- | --- | --- |
| 94 | размер значка | `Music size={18}` | 16 или 20 — по месту (в кнопке 36+ — 20) |
