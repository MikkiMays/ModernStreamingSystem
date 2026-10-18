---
name: cord-catalog-platform-limits
description: "Что YouTube и Twitch отдают каталогу Cord анонимно, и где у них стоят стены"
metadata: 
  type: project
---

Каталог кинозала [[cord-watch-together]] ходит к площадкам **без ключей и аккаунтов**. Что
именно они при этом отдают, выяснено опытом (19.09.2026) — гадать тут дорого.

**YouTube (через yt-dlp, `extract_flat`)**

- `ytsearch<N>:<запрос>` — **только ролики**. Каналов там нет вовсе; отсюда и жалоба «ввожу имя
  канала, а канала нет». Каналы ищутся отдельным адресом — вкладкой поиска самой площадки:
  `https://www.youtube.com/results?search_query=…&sp=EgIQAg%3D%3D`. В записях есть
  `channel_follower_count`, `uploader_id` (`@псевдоним`) и картинки 88/176 px.
- Вкладки канала — обычные адреса: `/videos`, `/streams`, `/shorts`, `/playlists`. Листание
  настоящее: `playliststart`/`playlistend`, порция 30, страница ~1 с. Нет вкладки — исключение
  с текстом `This channel does not have a streams tab`; ловить по `does not have a`.
- В ленте канала у роликов **нет** ни имени канала, ни `channel_id` — они уровнем выше, у
  страницы; эфир помечен `live_status: "is_live"`, а не `is_live`.
- Плейлист: `https://www.youtube.com/playlist?list=PL…` даёт `playlist_count`, `view_count`,
  `modified_date` и записи с `channel_id`. У плейлистов **в ленте канала** автор подписан
  `View full playlist` — имя брать уровнем выше.
- Картинки каналов приходят **без схемы** (`//yt3.ggpht.com/…`). Без `https:` они не проходят
  белый список прокси, и лицо канала тихо пропадает.

**Twitch (публичный GraphQL, клиент `kimne78kx3ncx6brgo4mv6wki5h1ko`)**

- Продолжение (`after: "<курсор>"`) анонимному клиенту **не отдаётся**: ответ
  `failed integrity check`, `extensions.challenge.type = integrity`. Курсоры в ответе есть и
  выглядят настоящими — это не помогает. Значит, листать можно только по уже полученному.
- `streams(first:)` — максимум **30** (больше: «argument 'first' value must be between 1 and
  30»). `games(first: 100)` и `user.videos(first: 100)` отдают сотню за раз.
- Разделы: `games(first: N)` для витрины, `searchFor(target: {index: GAME})` для поиска,
  `game(id: "<число>") { streams(first: N) }` для страницы раздела. Брать раздел по
  **идентификатору**, а не по имени: имя приходит из браузера.

Отсюда и разная механика подгрузки: у YouTube курсор — это номер в ленте и настоящий запрос,
у Twitch — место в уже скачанном списке. Наружу оба выглядят одинаково: строка `next`.
