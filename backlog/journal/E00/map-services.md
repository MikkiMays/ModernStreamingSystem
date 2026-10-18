# Карта служб (services/) — E00, 19.10.2026

Корни: `cord_services/` (FastAPI), `cord_services/cinema/`, `publisher/` (Go), `sniffer/`, `tests/`.

## Маршруты (`app.py`) и права

Middleware `app.py:140-158`: чужой `Origin` → 403, `Content-Length` > 50 МиБ → 413.

| Метод | Путь (`/api/v1/services/...`) | Проверка |
|---|---|---|
| GET | `catalog` `:164` | **нет** |
| GET | `rooms/{id}/music` `:186` | участник |
| POST | `.../music/enable` `:191` | `integration=True` |
| **DELETE** | **`.../music` `:200-203`** | **`owner=True` `:202` — причина T14** |
| POST | `.../music/commands` `:205` | `integration=True` |
| PUT | `.../music/upload/{cmd}` `:210` | `integration=True` |
| POST | `.../telegram/link` `:255` | `owner=True` |
| POST | `claims/preview`, `claims/redeem` `:286,299` | только токен |

Яндекс (`yandex.py:361-413`): все через `integration=True`, включая DELETE (в отличие от музыки).
Кинозал (`cinema/routes.py`): участник без флага интеграций; подписанный прокси — без авторизации.
Правило прав живёт в 4+ местах: `core.py:76-83`, `telegram.py:558-568`, `RoomService.java:1107`,
`web/src/ui/Services.tsx:112`. Тест, закрепивший баг: `tests/test_services.py:260-263`.

## Ядро из службы (`core.py`)

`member(room, cred, owner, integration)` 53-84: GET снимка с ключом участника; 403 если комната закрыта,
участника нет, статус не JOINING/CONNECTED/RECOVERING или это бот. Ошибки ядра пробрасываются только
`detail` (код теряется, 45-50).

## Хранение

SQLite `/data/services.sqlite` (WAL). Таблицы `store.py:53-63`: music, bindings, claims, receipts, state,
`cinema_links`, integrations (Fernet). Миграций нет — `CREATE TABLE IF NOT EXISTS` + один `ALTER`.

**`cinema_links` — не история, а общий кэш сервера** (ключ — HMAC URL, без комнаты и профиля, TTL 24 ч).
**Видимые «Недавние ссылки» живут на устройстве**: `localStorage cord:preferences:v1` → `cinemaLinks`
(`web/src/core/preferences.ts:103,163-168`), не больше 10 (`web/src/core/cinema/link.ts:20,110-113`),
показ — `web/src/ui/cinema/scenes/LinkScene.tsx:66,80,244-250`. → T17 «удалить историю» = правка
настроек устройства; серверные записи удалять нельзя (их делят комнаты).

## Музыка

Очередь `store.py:24-40`, команды `music.py:123-184`, 100 треков. Источники: загрузка, Яндекс, Telegram.
**yt-dlp для музыки не используется** (только кинозал). Бот: `core.add_music` → токен → Go-издатель
(`publisher.py`, JSON по stdin). Издатель: Opus 48k стерео, 20 мс, тишина `0xFC 0xFF 0xFE` когда не играет,
`lead=12` кадров тишины перед треком, **громкости/фейда нет** — громкость слушателя только в браузере.

## Telegram

Включается `CORD_MEET_TELEGRAM_BOT_TOKEN` (`.local/telegram.env`). 20 команд. `/bind <токен 24 симв.>`
без подтверждения в комнате; `ownerId` — тот, кто выполнил `/bind`. `setChatMenuButton {type:commands}`.
Long polling без `callback_query`. **Mini App/web_app/initData/startapp нет. `TELEGRAM_WEBAPP_ENABLED` в
коде нет.** В личке `/new` проходит без проверки админа — можно плодить комнаты (E11).

## Кинозал

Провайдеры YouTube, Twitch, Rutube, VK, ivi, Link (`providers/__init__.py:12`). Прокси HLS переписывает
только `URI="…"` — **рекламные метки (DATERANGE/SCTE/CUE-OUT/DISCONTINUITY) не обрабатываются**, но
доходят до плеера. Link: yt-dlp `noplaylist`, плейлист — первые 200, **season/episode не читаются**
(`link.py:974-1009`), `series()` всегда `season: None`. Rutube — сезоны из `metainfo/tv`. «Следующей
серии» на сервере нет. Подписанные URL живут 5 ч и **не привязаны к комнате**, потолка трафика нет (E11).

## Тесты и сборка

unittest (20 файлов, ~760 тестов), фикстуры `tests/fixtures/*`. Sniffer — 78 тестов, Go — 3.
CI: `docker compose run ... services -m unittest discover -s /tests` (host network), ruff 110 для кинозала.
`requirements.lock` с хэшами (`uv pip compile --generate-hashes`) — новая зависимость = перегенерация.
