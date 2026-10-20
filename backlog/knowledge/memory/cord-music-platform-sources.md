---
name: cord-music-platform-sources
description: "Что YouTube и SoundCloud отдают музыке Cord через yt-dlp без ключей и как узнать 30-секундный фрагмент SoundCloud Go+"
metadata:
  type: project
---

Проверено 20.10.2026 с машины `cord.nikg.tech` (yt-dlp 2026.8.19, deno 2.9.7, образ `modern-streaming-services`), E06-B.

- **Поиск без ключей работает у обоих:** `ytsearch8:<запрос>` и `scsearch8:<запрос>` с `extract_flat` — около
  секунды. У YouTube в плоской записи есть `id`, `title`, `channel`, `duration`, `live_status`; у SoundCloud —
  `webpage_url` (постоянный адрес трека), `uploader`, `duration`, а `url` — адрес API, не страницы.
- **SoundCloud Go+ анонимно отдаёт только 30-секундный фрагмент.** В плоском поиске это видно по `duration: 30.0`
  ровно; в полном разборе — у всех форматов `format_id` кончается на `_preview` (`hls_mp3_1_0_preview`,
  `http_mp3_1_0_preview`) и `preference: -10`. Обычный трек — `hls_aac_96k`/`hls_aac_160k` по HLS.
- **HLS SoundCloud yt-dlp склеивает и чинит ffmpeg-ом** (fixup) в `.m4a`; без fixup файл остаётся MPEG-TS с
  расширением `.m4a`, и `ffprobe` в `media.probe` назвал бы его `mpegts` — не аудиоформат из списка. Поэтому
  `fixup` не выключать.
- **YouTube отдаёт отдельные дорожки звука:** Opus ~130 кбит/с (`251`, ≈ 5,2 МБ на 5:20) и AAC (`140`). Час
  Opus — около 58 МБ, больше предела файла 50 МБ: формат берётся как
  `bestaudio[filesize<?MAX][filesize_approx<?MAX]/worstaudio`, а крючок прогресса обрывает остальное.
- **`allowed_extractors`** ставится на каждый вызов: `youtube:search`/`soundcloud:search` для поиска,
  `youtube`/`soundcloud` для трека — общий разборщик страниц (`generic`) не участвует, и ссылка «куда угодно»
  до него не доходит.
- Скачивание — `extract_info(download=False)`, проверки (эфир, длина, фрагмент), затем
  `process_ie_result(info, download=True)`; итоговый путь — `requested_downloads[0].filepath`. Формат больше
  `max_filesize` yt-dlp молча пропускает (если размер знал заранее) — файла нет, это и есть «слишком большой».

Код — `services/cord_services/sources.py`, решение и риск (письма Google ботам Discord в 2021) —
`DECISIONS.md` E06-B-1. Связано: [[cord-catalog-platform-limits]], [[cord-youtube-audio-and-captions]].
