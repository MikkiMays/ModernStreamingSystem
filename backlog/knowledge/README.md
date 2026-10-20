# Знания о Cord

Заметки о том, как устроен Cord и на чём уже спотыкались, плюс справочные скиллы по частям
системы. Пути `/opt/meet/...` в заметках — пути первого сервера, читай как `$CORD_ROOT`. Новое
добавляй сюда же: одна заметка — один факт, строка в этот список.

## Заметки (`memory/`)

- [`codex-handoff-review`](memory/codex-handoff-review.md) — Что чаще всего оказывается сломанным в Cord под отчётом «всё прошло» — проверять при каждом приёме чужой работы
- [`cord-audio-verification`](memory/cord-audio-verification.md) — Как на этой машине послушать, что на самом деле приходит в комнату Cord
- [`cord-call-in-pocket`](memory/cord-call-in-pocket.md) — Почему встреча Cord рвалась у телефона с погашенным экраном и на каких двух сторонах это лечится
- [`cord-capacity-numbers`](memory/cord-capacity-numbers.md) — Чем меряется ёмкость сервера Cord и три числа, которые решают спор про железо
- [`cord-catalog-platform-limits`](memory/cord-catalog-platform-limits.md) — Что YouTube и Twitch отдают каталогу Cord анонимно, и где у них стоят стены
- [`cord-ci-and-release-traps`](memory/cord-ci-and-release-traps.md) — Чем CI в Cord строже локальных команд и как пуш подряд ломает выкладку релиза Windows
- [`cord-cinema-ad-markers`](memory/cord-cinema-ad-markers.md) — Где в кинозале видны рекламные метки потока (hls.js tagList), почему интерстишелы выключены и почему фокус держал пульт на кадре
- [`cord-cinema-playlists-and-sync`](memory/cord-cinema-playlists-and-sync.md) — Почему длинный фильм в Cord открывался минутами, и три числа про синхронность совместного просмотра
- [`cord-cinema-providers`](memory/cord-cinema-providers.md) — Какие площадки кинозала Cord реально достижимы (Rutube, VK Видео, ivi, по ссылке с плеером страниц), почему Кинопоиска, Зоны и Jellyfin нет, и почему прокси отдаёт чужое только своим типом
- [`cord-disk-utilisation`](memory/cord-disk-utilisation.md) — Где в Cord копится место, срок хранения встреч в неделю и суточная уборка cord-tidy
- [`cord-durak-table`](memory/cord-durak-table.md) — Дурак в Cord: где он живёт, чем отличается от покера и на каких граблях там уже стояли
- [`cord-e2e-against-production`](memory/cord-e2e-against-production.md) — Как за минуту проверить клиента Cord настоящим браузером против боевого сервера, не поднимая локальный стенд
- [`cord-figma-export`](memory/cord-figma-export.md) — Как экраны Cord попадают в Figma-файл продукта и на чём там спотыкаешься — план Starter, запрет захвата в слои, кадры по ссылкам upload_assets
- [`cord-ladder-in-place`](memory/cord-ladder-in-place.md) — Почему камера в Cord «моргала» каждые полминуты и как лестница качества теперь шагает без переопубликации
- [`cord-local-stack-with-sfu`](memory/cord-local-stack-with-sfu.md) — Как поднять рядом с продом Cord полный второй стенд со своим SFU и проверять на нём медиа, ничего не трогая
- [`cord-moderation-is-soft`](memory/cord-moderation-is-soft.md) — Решение владельца Cord: исключение и выключенный микрофон — не запрет, а конец встречи
- [`cord-music-silence-and-encode`](memory/cord-music-silence-and-encode.md) — Почему пауза в музыке Cord звучала как поломка и чем меряется, кодек это или сеть
- [`cord-openapi-regeneration`](memory/cord-openapi-regeneration.md) — Как перегенерировать contracts/openapi.json в Cord, когда прод-ядро отдаёт 404 на /api/openapi
- [`cord-playout-buffer`](memory/cord-playout-buffer.md) — Почему в Cord звук «то ускорялся, то ломался», и почему нулевой буфер приёма больше не просят
- [`cord-poker-table`](memory/cord-poker-table.md) — Покер в Cord: где он живёт, три решения, на которых он держится, и ловушка отката
- [`cord-quality-ladder-and-reception`](memory/cord-quality-ladder-and-reception.md) — Почему показ в Cord стартовал в 15 fps и как сделан режим приёма «всегда максимум»
- [`cord-retention-config`](memory/cord-retention-config.md) — Сроки хранения встреч в Cord задаются словами в yaml, и несохранённая встреча уходит сразу
- [`cord-room-member-rollback`](memory/cord-room-member-rollback.md) — ignoreUnknown на RoomState не спасает вложенные классы — новое поле участника делает комнату нечитаемой для прежнего образа ядра
- [`cord-testcontainers-on-host`](memory/cord-testcontainers-on-host.md) — Почему *PostgresTest ядра на стенде молча пропускаются или падают по таймауту, и какой запуск даёт настоящий PostgreSQL
- [`cord-standing-permissions`](memory/cord-standing-permissions.md) — Владелец Cord дал все разрешения: в конце каждой сессии разработки — выкатка в прод и актуальный main обеих реп, без вопросов
- [`cord-ui-checks-on-prod`](memory/cord-ui-checks-on-prod.md) — Как проверять вёрстку и медиа Cord настоящим браузером на этой машине, включая обход origin-проверки ядра
- [`cord-ui-traps`](memory/cord-ui-traps.md) — Ловушки интерфейса Cord, которые выглядели как сломанные ручки: ползунки, подложки Base UI, холст

- [`cord-ui-traps`](memory/cord-ui-traps.md) — Три ловушки интерфейса Cord, которые выглядели как сломанные ручки, а не как неверные значения
- [`cord-voice-levels`](memory/cord-voice-levels.md) — Кто говорит в Cord считает сам зритель (AnalyserNode в media/levels.ts), а не SFU — где это ломается и чем проверять
- [`cord-video-quality-levers`](memory/cord-video-quality-levers.md) — Где в Cord ломается качество видео: кодек камеры, потолок «Авто», adaptiveStream и один предел LiveKit, который снаружи не убирается
- [`cord-watch-together`](memory/cord-watch-together.md) — Кинозал Cord: видео тянет сервер и проксирует HLS, а не браузер — почему так и где грабли
- [`cord-web-on-phone`](memory/cord-web-on-phone.md) — Что ломалось у Cord в вебе с телефона и чем это проверять, не имея телефона
- [`cord-windows-update-helper`](memory/cord-windows-update-helper.md) — Почему «Обновить» в Cord для Windows перезапускал старую версию и что в помощнике обновления теперь иначе (0.7.5)
- [`cord-youtube-audio-and-captions`](memory/cord-youtube-audio-and-captions.md) — Почему ролик YouTube в Cord говорил по-французски, и откуда там берутся субтитры
- [`livekit-resume-on-network-change`](memory/livekit-resume-on-network-change.md) — Почему livekit-client не замечает смену сети (VPN) и как попросить у него бесшовный resume без полного connect
- [`livekit-stereo-only-via-go`](memory/livekit-stereo-only-via-go.md) — Почему музыка в Cord приходила в моно и почему стерео возможно только через Go-SDK
- [`livekit-turn-and-secure-context`](memory/livekit-turn-and-secure-context.md) — Два ограничения, которые определяют топологию Cord: LiveKit жёстко объявляет TURN на порту https, а без https нет камеры
- [`meet-cord-system`](memory/meet-cord-system.md) — Что такое /opt/meet (Cord), из чего состоит, три режима установки и как выкатывать
- [`pricing-from-official-sources`](memory/pricing-from-official-sources.md) — Владелец требует официальные прайсы и первоисточники, а не пересказы из статей — особенно когда решение стоит денег
- [`use-all-skills-and-mcp`](memory/use-all-skills-and-mcp.md) — Владелец требует максимально задействовать все доступные скиллы, MCP и плагины и разрешает ставить новые самостоятельно
- [`vm-host-stalls`](memory/vm-host-stalls.md) — С 14.10.2026 ВМ старого прода замирала на 20–55 с пачками; виноват хост, не код Cord
- [`windows-client-checks-on-linux`](memory/windows-client-checks-on-linux.md) — Как проверить C# клиента Cord на этой машине, хотя WinUI здесь не собирается

## Скиллы (`codex-skills/`, написаны для Codex — читать как справку)

- [`cord-contracts`](codex-skills/cord-contracts/SKILL.md) — Cord API and WebSocket contract changes: schemas, generated clients and compatibility.
- [`cord-deployment-review`](codex-skills/cord-deployment-review/SKILL.md) — Cord deployment review: Docker Compose, Caddy, TURN/TLS, networking, health and release readiness.
- [`cord-file-lifecycle`](codex-skills/cord-file-lifecycle/SKILL.md) — Cord uploads and retention: tus, ownership checks, quotas, temporary chat/files and cleanup.
- [`cord-media-reliability`](codex-skills/cord-media-reliability/SKILL.md) — Cord/ModernStreamingSystem LiveKit and WebRTC work: media quality, reconnects, screen sharing and device bugs.
- [`cord-spring-data`](codex-skills/cord-spring-data/SKILL.md) — Cord/ModernStreamingSystem Java and Spring backend: JDBC transactions, PostgreSQL, Redis, Flyway and concurrent state.
- [`cord-verification`](codex-skills/cord-verification/SKILL.md) — Cord verification: choose the real project checks and report evidence without overstating coverage.
- [`cord-web-client`](codex-skills/cord-web-client/SKILL.md) — Cord React/Vite web client: TypeScript, Base UI, accessibility and client-side performance.
- [`cord-windows-bridge`](codex-skills/cord-windows-bridge/SKILL.md) — Cord Windows client: WinUI, the WebView2 bridge, deep links and installer compatibility.
