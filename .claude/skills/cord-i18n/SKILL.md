---
name: cord-i18n
description: Use when writing or changing any user-visible text in the Cord web client (web/src) — new screen, new label, aria-label, error, plural count, date or size — or when moving hard-coded Russian strings into the translation catalog (E14), or when scripts/i18n/check.mjs fails in CI.
---

# Тексты Cord через слой переводов

С E14-A каждая строка, которую видит человек, живёт в каталоге `web/src/i18n/locales/ru.json`, а не в
коде. Русский — исходный язык и запасной для любого ключа; другие языки (`en.json`, … — П9) приходят
отдельными файлами и пока несут только часть ключей (E14-B). CI держит храповик: строк с кириллицей в
`.ts/.tsx` вне каталога не становится больше (`scripts/i18n/check.mjs`, база — `scripts/i18n/baseline.json`).

## Как сказать текст

| Где | Чем | Почему |
| --- | --- | --- |
| компонент | `const { t } = useTranslation();` (`react-i18next`), `t(($) => $.poker.fold)` | `t` меняется вместе с языком — React Compiler пересчитает всё, что от него зависит |
| функция, которая возвращает текст для разметки (`core/*.ts`, карты подписей) | первым параметром `t: Translate` (`import type { Translate } from '…/i18n'`), компонент передаёт свой | глобальный перевод в такой функции компилятор закэширует по остальным аргументам — после смены языка останется старый текст |
| событие вне React (класс встречи, обработчик, `throw new Error(…)` для человека) | `import { t } from '…/i18n'` | текст рождается в момент события |
| ошибка сервера | уже в `api/client.ts`: `ApiError.message = errorText(code, detail)` | по-русски — точный `detail` ядра, на другом языке — `errors.<CODE>` |

- Ключи — **селекторами**: `t(($) => $.settings.rows[id].label)`. Строковых ключей нет: селектор проверяет
  компилятор (`i18next.d.ts`, `enableSelector`). Динамический ключ — индекс по объединению литералов,
  совпадающему с ключами JSON (`$.poker.actions[action]`, где `action: PokerAction`).
- **Карта подписей на уровне модуля** (`const LABELS: Record<X, string> = { … 'Пас' }`) — нельзя: текст
  застынет на языке загрузки. Вместо неё — ключи в JSON по тем же идентификаторам и функция
  `label(t, x)`, или `t(($) => $.ns.labels[x])` прямо в разметке.
- Вставки — `{{name}}`: `"reset": "Сбросить: {{name}}"` → `t(($) => $.settings.accounts.reset, { name })`.
  Разметка внутри фразы — `<Trans i18nKey={($) => $.ns.key} components={{ b: <b /> }} />` и `<b>…</b>` в
  тексте; проще — разбить на две строки, если фраза позволяет.

## Каталог

- Пространство верхнего уровня — область интерфейса: `settings`, `home`, `meeting`, `cinema`, `music`,
  `poker`, `durak`, `chess`, `gartic`, `games`, … `common` — только для настоящих общих слов (`close`);
  одинаковое по-русски в разных местах может по-разному переводиться — тогда два ключа.
- Ключи — смысловые и устойчивые, camelCase: `poker.actions.fold`, `home.favorites.empty`, а не `text1` и
  не сам русский текст. Идентификаторы из кода (`'profile-name'`, `'low-latency'`) — ключами как есть.
- Пустая строка `""` — осознанное «нет текста» (у строки настроек без пояснения `hint: ""`).
- **Русский — слово в слово как был**: те же «ёлочки», тире, `ё`, неразрывные пробелы (U+00A0 —
  в JSON они невидимы, переносить копированием, не руками). Вынос — не редактура; тесты сверяют текст.
- Не переводятся и в каталог не идут: «Cord», пользовательское содержимое, имена и названия с сервера,
  разбор чужого ввода (регулярные выражения по русским словам), комментарии, тесты, образцы витрины
  `/kit` (`kit/Showcase.tsx`, `IntegrationsSample.tsx`). Названия чужих продуктов по-русски
  («Яндекс Музыка») — в каталог: у продукта есть своё имя на других языках.
- `errors` в `ru.json` пишет скрипт из `contracts/errors.json` — руками не править
  (`node scripts/i18n/sync-errors.mjs`).

## Числа, даты, размеры

- Формы числа — плюралы i18next: `"cards_one": "{{count}} карта"`, `"cards_few": "{{count}} карты"`,
  `"cards_many": "{{count}} карт"`, `"cards_other": "{{count}} карты"` (`other` — дробные; у русского
  четыре формы `Intl.PluralRules`), вызов `t(($) => $.durak.cards, { count })`. Своих `plural()` и `% 10`
  больше не писать.
- Даты, время, числа — `Intl` с языком каталога: `locale(t)` из `…/i18n` вместо зашитого `'ru-RU'`
  (`new Intl.DateTimeFormat(locale(t), {...})`, `value.toLocaleString(locale(t))`). Единицы размера,
  которых нет в `Intl` (КиБ), — словом из каталога, число — через `Intl`.

## Проверка

Из `web/`:

```bash
npx vitest run --pool=forks --maxWorkers=1 --testTimeout=60000 <тесты тронутого>
npx tsc -b
npx prettier --check <файлы>
node scripts/i18n/check.mjs                 # храповик; вынесли строки — node scripts/i18n/check.mjs --update
node scripts/i18n/sync-errors.mjs --check   # ошибки ядра в каталоге совпадают с реестром
python3 ../scripts/errors_registry.py --check   # реестр совпадает с кодом ядра (новый Problem — перезапустить без --check)
```

Новый экран — сразу через `t`: храповик не пустит новый файл с кириллицей. Тест, который читает русский
текст, работает как есть — `src/test/setup.ts` поднимает слой по-русски.
